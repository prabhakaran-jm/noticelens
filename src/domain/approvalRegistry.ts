import {
  canonicalCloudPayload,
  CloudPayloadValidationError,
} from "./cloudPayloadGuard";
import {
  canonicalClosedCloudBrief,
  ClosedCloudBriefValidationError,
} from "./closedCloudBrief";
import {
  ALLOWED_CIRCUMSTANCE_FLAGS,
  ALLOWED_RESPONSE_GOALS,
  type CircumstanceFlag,
  type ResponseGoal,
} from "./types";

/**
 * In-memory approval authority for one page session.
 *
 * Lifecycle: NO_APPROVAL → PENDING_APPROVAL → APPROVED → INVALIDATED.
 * A future submission consumes one approved handle: APPROVED → CONSUMED.
 * Invalidated and consumed are terminal. Matching bytes do not approve
 * them again, and nothing restores a consumed handle after a failed send.
 * The strong list keeps current pending and approved records. Terminal
 * records can be released. A held handle still reports its terminal status.
 * The registry does not read storage, does not send, and does not change
 * whether a grounded fact is verified.
 *
 * `isPayloadApproved` is not send authorisation. It is true only when exactly
 * one approved record matches. A future send must pass one handle to
 * `authoriseExactApproval`.
 */

export type ApprovalLifecycle =
  | "NO_APPROVAL"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "INVALIDATED"
  | "CONSUMED";

export type ApprovalSchema = "noticelens.cloud-brief.v2" | "noticelens.cloud-brief.v1";

export interface ApprovalBinding {
  readonly schema: ApprovalSchema;
  /** Exact canonical JSON. Pretty-printed or reordered bytes are a different value. */
  readonly canonicalBytes: string;
  readonly noticeGeneration: number;
  /** Opaque session marker. Not a name, address, account reference, or notice text. */
  readonly identifierContextId: string;
  readonly responseGoal: ResponseGoal;
  readonly circumstanceFlags: readonly CircumstanceFlag[];
  readonly extractionGeneration: number;
  /** Opaque session marker for the notice and comparison selection. */
  readonly documentContextId: string;
}

export interface ApprovalHandle {
  readonly kind: "noticelens.approval-handle";
}

export type ApprovalRejection = "malformed-context" | "not-canonical";

export type RegisterResult =
  | { readonly ok: true; readonly handle: ApprovalHandle; readonly lifecycle: "PENDING_APPROVAL" }
  | { readonly ok: false; readonly lifecycle: "NO_APPROVAL"; readonly reason: ApprovalRejection };

interface StoredRecord {
  status: "PENDING_APPROVAL" | "APPROVED" | "INVALIDATED" | "CONSUMED";
  schema: ApprovalSchema;
  canonicalBytes: string;
  noticeGeneration: number;
  identifierContextId: string;
  responseGoal: ResponseGoal;
  flagsKey: string;
  extractionGeneration: number;
  documentContextId: string;
  /** App instance that created this record. Null for legacy and direct test registrations. */
  owner: object | null;
}

const handleBrand = Symbol("noticelens.approval-handle");
const reviewBrand = Symbol("noticelens.privacy-review");

/**
 * Live only for the duration of the privacy modal's confirm click.
 * A saved token does not approve anything after that click returns.
 */
const liveReviews = new Set<object>();

/**
 * Production builds require a live privacy-review token.
 * Vitest leaves this off so existing registry tests keep their direct calls.
 * A test can force the production rule. Malicious script already running in
 * the page is outside this check.
 */
let privacyReviewOverride: boolean | null = null;

export interface PrivacyReview {
  readonly kind: "noticelens.privacy-review";
}

function privacyReviewRequired(): boolean {
  if (privacyReviewOverride !== null) {
    return privacyReviewOverride;
  }
  return import.meta.env.PROD;
}

function isLiveReview(review: unknown): review is PrivacyReview {
  return (
    review !== null &&
    typeof review === "object" &&
    liveReviews.has(review) &&
    Object.prototype.hasOwnProperty.call(review, reviewBrand)
  );
}

function acceptsReview(review: unknown): boolean {
  if (!privacyReviewRequired()) {
    return true;
  }
  return isLiveReview(review);
}

/** Opens a review for the modal's confirm click. It is not a send and it is not a boolean grant. */
export function openPrivacyReview(): PrivacyReview {
  const review = {};
  Object.defineProperty(review, reviewBrand, { value: true });
  Object.defineProperty(review, "kind", {
    value: "noticelens.privacy-review",
    enumerable: true,
  });
  const frozen = Object.freeze(review) as PrivacyReview;
  liveReviews.add(frozen);
  return frozen;
}

export function closePrivacyReview(review: PrivacyReview): void {
  liveReviews.delete(review);
}

interface RegistryState {
  records: WeakMap<object, StoredRecord>;
  handles: object[];
}

function freshRegistryState(): RegistryState {
  return { records: new WeakMap(), handles: [] };
}

let registryState = freshRegistryState();

const OPAQUE_ID = /^(?:ie-\d+|idctx-\d+|legacy-doc-\d+|sess-\d+-doc-\d+)$/;
const RESPONSE_GOALS = new Set<string>(ALLOWED_RESPONSE_GOALS);
const CIRCUMSTANCE_FLAGS = new Set<string>(ALLOWED_CIRCUMSTANCE_FLAGS);

/**
 * Test isolation only. Replaces the registry so a discarded handle cannot
 * become authoritative again. Application code and any future send path
 * must not call this.
 */
export const approvalRegistryTestIsolation = {
  reset(): void {
    registryState = freshRegistryState();
    liveReviews.clear();
  },
  /**
   * Test isolation. Production code does not call this.
   * `true` matches a production build: register and approve require a live review.
   */
  setPrivacyReviewRequired(required: boolean): void {
    privacyReviewOverride = required;
  },
  useDefaultPrivacyReview(): void {
    privacyReviewOverride = null;
  },
};

export function retainedApprovalCount(): number {
  return registryState.handles.length;
}

export function activeApprovalCount(): number {
  return registryState.handles.filter((handle) => {
    const record = registryState.records.get(handle);
    return record?.status === "PENDING_APPROVAL" || record?.status === "APPROVED";
  }).length;
}

/** Drops invalidated and consumed records from the strong list. A held handle still resolves to its terminal status. */
export function releaseInvalidatedApprovals(): number {
  const before = registryState.handles.length;
  registryState.handles = registryState.handles.filter((handle) => {
    const record = registryState.records.get(handle);
    return record !== undefined && record.status !== "INVALIDATED" && record.status !== "CONSUMED";
  });
  return before - registryState.handles.length;
}

function lookup(handle: unknown): StoredRecord | null {
  if (handle === null || typeof handle !== "object") {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(handle, handleBrand)) {
    return null;
  }
  return registryState.records.get(handle) ?? null;
}

function flagsKey(flags: readonly CircumstanceFlag[]): string {
  return [...flags].sort().join("\n");
}

function copyFlags(value: unknown): CircumstanceFlag[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const copied: CircumstanceFlag[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, String(index))) {
      return null;
    }
    const flag: unknown = value[index];
    if (typeof flag !== "string" || !CIRCUMSTANCE_FLAGS.has(flag) || seen.has(flag)) {
      return null;
    }
    seen.add(flag);
    copied.push(flag as CircumstanceFlag);
  }
  return copied;
}

function generation(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function opaqueId(value: unknown): string | null {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    return null;
  }
  return value;
}

interface NormalizedBinding {
  schema: ApprovalSchema;
  canonicalBytes: string;
  noticeGeneration: number;
  identifierContextId: string;
  responseGoal: ResponseGoal;
  flagsKey: string;
  extractionGeneration: number;
  documentContextId: string;
}

function normalize(input: unknown): { ok: true; value: NormalizedBinding } | { ok: false; reason: ApprovalRejection } {
  let schema: unknown;
  let canonicalBytes: unknown;
  let noticeGeneration: unknown;
  let identifierContextId: unknown;
  let responseGoal: unknown;
  let circumstanceFlags: unknown;
  let extractionGeneration: unknown;
  let documentContextId: unknown;
  try {
    if (input === null || typeof input !== "object") {
      return { ok: false, reason: "malformed-context" };
    }
    const source = input as Record<string, unknown>;
    schema = source.schema;
    canonicalBytes = source.canonicalBytes;
    noticeGeneration = source.noticeGeneration;
    identifierContextId = source.identifierContextId;
    responseGoal = source.responseGoal;
    circumstanceFlags = source.circumstanceFlags;
    extractionGeneration = source.extractionGeneration;
    documentContextId = source.documentContextId;
  } catch {
    return { ok: false, reason: "malformed-context" };
  }

  if (schema !== "noticelens.cloud-brief.v2" && schema !== "noticelens.cloud-brief.v1") {
    return { ok: false, reason: "malformed-context" };
  }
  if (
    typeof canonicalBytes !== "string" ||
    canonicalBytes.length === 0 ||
    canonicalBytes !== canonicalBytes.trim() ||
    canonicalBytes.includes("\n") ||
    canonicalBytes.includes("\r")
  ) {
    return { ok: false, reason: "malformed-context" };
  }
  const notice = generation(noticeGeneration);
  const extraction = generation(extractionGeneration);
  const identifierId = opaqueId(identifierContextId);
  const documentId = opaqueId(documentContextId);
  const flags = copyFlags(circumstanceFlags);
  if (
    notice === null ||
    extraction === null ||
    identifierId === null ||
    documentId === null ||
    flags === null ||
    typeof responseGoal !== "string" ||
    !RESPONSE_GOALS.has(responseGoal)
  ) {
    return { ok: false, reason: "malformed-context" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalBytes);
  } catch {
    return { ok: false, reason: "not-canonical" };
  }

  try {
    if (schema === "noticelens.cloud-brief.v2") {
      const canonical = canonicalClosedCloudBrief(parsed);
      const payloadFlags = canonical.payload.circumstanceFlags ?? [];
      if (
        canonical.serialized !== canonicalBytes ||
        canonical.payload.responseGoal !== responseGoal ||
        flagsKey(payloadFlags) !== flagsKey(flags)
      ) {
        return { ok: false, reason: "not-canonical" };
      }
    } else {
      const canonical = canonicalCloudPayload(parsed);
      const payloadFlags = canonical.payload.circumstanceFlags ?? [];
      if (
        canonical.serialized !== canonicalBytes ||
        canonical.payload.responseGoal !== responseGoal ||
        flagsKey(payloadFlags) !== flagsKey(flags)
      ) {
        return { ok: false, reason: "not-canonical" };
      }
    }
  } catch (error) {
    if (
      error instanceof ClosedCloudBriefValidationError ||
      error instanceof CloudPayloadValidationError ||
      error instanceof SyntaxError
    ) {
      return { ok: false, reason: "not-canonical" };
    }
    throw error;
  }

  return {
    ok: true,
    value: {
      schema,
      canonicalBytes,
      noticeGeneration: notice,
      identifierContextId: identifierId,
      responseGoal: responseGoal as ResponseGoal,
      flagsKey: flagsKey(flags),
      extractionGeneration: extraction,
      documentContextId: documentId,
    },
  };
}

function matches(record: StoredRecord, binding: NormalizedBinding): boolean {
  return (
    record.schema === binding.schema &&
    record.canonicalBytes === binding.canonicalBytes &&
    record.noticeGeneration === binding.noticeGeneration &&
    record.identifierContextId === binding.identifierContextId &&
    record.responseGoal === binding.responseGoal &&
    record.flagsKey === binding.flagsKey &&
    record.extractionGeneration === binding.extractionGeneration &&
    record.documentContextId === binding.documentContextId
  );
}

export function approvalBindingsEqual(left: ApprovalBinding, right: ApprovalBinding): boolean {
  const first = normalize(left);
  const second = normalize(right);
  if (!first.ok || !second.ok) {
    return false;
  }
  return matches(
    {
      status: "PENDING_APPROVAL",
      ...first.value,
      owner: null,
    },
    second.value
  );
}

export function registerApprovablePayload(binding: ApprovalBinding, review?: unknown): RegisterResult {
  if (!acceptsReview(review)) {
    return { ok: false, lifecycle: "NO_APPROVAL", reason: "malformed-context" };
  }
  const normalized = normalize(binding);
  if (!normalized.ok) {
    return { ok: false, lifecycle: "NO_APPROVAL", reason: normalized.reason };
  }
  const record: StoredRecord = {
    status: "PENDING_APPROVAL",
    ...normalized.value,
    owner: null,
  };
  const handle = {};
  Object.defineProperty(handle, handleBrand, { value: true });
  Object.defineProperty(handle, "kind", {
    value: "noticelens.approval-handle",
    enumerable: true,
  });
  Object.freeze(handle);
  registryState.records.set(handle, record);
  registryState.handles.push(handle);
  return { ok: true, handle: handle as ApprovalHandle, lifecycle: "PENDING_APPROVAL" };
}

/**
 * Approves the pending record bound to this handle when the binding still
 * matches the registered bytes and context. A second call, a stale binding,
 * a clone, or an invalidated handle does not approve anything.
 */
export function approvePending(handle: unknown, binding: ApprovalBinding, review?: unknown): boolean {
  if (!acceptsReview(review)) {
    return false;
  }
  const record = lookup(handle);
  const normalized = normalize(binding);
  if (!record || !normalized.ok || !matches(record, normalized.value)) {
    return false;
  }
  if (record.status !== "PENDING_APPROVAL") {
    return false;
  }
  for (const other of registryState.handles) {
    if (other === handle) {
      continue;
    }
    const existing = registryState.records.get(other);
    if (existing && existing.status === "APPROVED" && matches(existing, normalized.value)) {
      return false;
    }
  }
  record.status = "APPROVED";
  return true;
}

/** True only when this handle is the approved record for this exact binding. */
export function isHandleApproved(handle: unknown, binding: ApprovalBinding): boolean {
  const record = lookup(handle);
  const normalized = normalize(binding);
  if (!record || !normalized.ok || record.status !== "APPROVED") {
    return false;
  }
  return matches(record, normalized.value);
}

/**
 * Not send authorisation. True only when exactly one approved record matches.
 * Two matches are ambiguous and fail closed. A future send must call
 * `authoriseExactApproval` with the specific handle.
 */
export function isPayloadApproved(binding: ApprovalBinding): boolean {
  const normalized = normalize(binding);
  if (!normalized.ok) {
    return false;
  }
  let approved = 0;
  for (const handle of registryState.handles) {
    const record = registryState.records.get(handle);
    if (record && record.status === "APPROVED" && matches(record, normalized.value)) {
      approved += 1;
    }
  }
  return approved === 1;
}

export function bindingLifecycle(binding: ApprovalBinding): ApprovalLifecycle {
  const normalized = normalize(binding);
  if (!normalized.ok) {
    return "NO_APPROVAL";
  }
  let approved = 0;
  let sawPending = false;
  let sawInvalidated = false;
  for (const handle of registryState.handles) {
    const record = registryState.records.get(handle);
    if (!record || !matches(record, normalized.value)) {
      continue;
    }
    if (record.status === "APPROVED") {
      approved += 1;
    } else if (record.status === "PENDING_APPROVAL") {
      sawPending = true;
    } else if (record.status === "INVALIDATED") {
      sawInvalidated = true;
    }
  }
  if (approved === 1) {
    return "APPROVED";
  }
  if (approved > 1) {
    return "NO_APPROVAL";
  }
  if (sawPending) {
    return "PENDING_APPROVAL";
  }
  if (sawInvalidated) {
    return "INVALIDATED";
  }
  return "NO_APPROVAL";
}

export function approvalLifecycle(handle: unknown): ApprovalLifecycle {
  return lookup(handle)?.status ?? "NO_APPROVAL";
}

export type AuthorisationRejection =
  | "missing-handle"
  | "stale-handle"
  | "invalidated"
  | "mismatched"
  | "already-consumed"
  | "not-approved";

export type AuthorisationResult = { readonly ok: true } | { readonly ok: false; readonly reason: AuthorisationRejection };

/**
 * Consumes one approved handle for one exact binding. Success is single-use.
 * There is no restore. If a later network request fails, this handle stays
 * consumed and a new submission requires a new explicit approval.
 * This does not send and does not open a network request.
 */
export function authoriseExactApproval(handle: unknown, binding: ApprovalBinding): AuthorisationResult {
  const record = lookup(handle);
  if (!record) {
    return { ok: false, reason: "missing-handle" };
  }
  if (record.status === "CONSUMED") {
    return { ok: false, reason: "already-consumed" };
  }
  if (record.status === "INVALIDATED") {
    return { ok: false, reason: "invalidated" };
  }
  const normalized = normalize(binding);
  if (!normalized.ok || !matches(record, normalized.value)) {
    return { ok: false, reason: record.status === "APPROVED" ? "mismatched" : "stale-handle" };
  }
  if (record.status !== "APPROVED") {
    return { ok: false, reason: "not-approved" };
  }
  record.status = "CONSUMED";
  registryState.handles = registryState.handles.filter((item) => item !== handle);
  return { ok: true };
}

/**
 * Marks a pending or approved record as belonging to one app instance.
 * It does not approve, consume, or restore anything.
 */
export function attachDispatchOwner(handle: unknown, owner: object): void {
  const record = lookup(handle);
  if (!record || (record.status !== "PENDING_APPROVAL" && record.status !== "APPROVED")) {
    return;
  }
  if (owner === null || typeof owner !== "object") {
    return;
  }
  if (record.owner !== null && record.owner !== owner) {
    return;
  }
  record.owner = owner;
}

/**
 * Invalidates pending and approved records created by this app instance.
 * Consumed and invalidated records stay terminal. Other owners are left alone.
 */
export function invalidateApprovalsForOwner(owner: object): void {
  if (owner === null || typeof owner !== "object") {
    return;
  }
  for (const handle of registryState.handles) {
    const record = registryState.records.get(handle);
    if (
      record &&
      record.owner === owner &&
      record.status !== "INVALIDATED" &&
      record.status !== "CONSUMED"
    ) {
      record.status = "INVALIDATED";
    }
  }
  releaseInvalidatedApprovals();
}

export function revokeApproval(handle: unknown): boolean {
  const record = lookup(handle);
  if (!record || record.status === "INVALIDATED" || record.status === "CONSUMED") {
    return false;
  }
  record.status = "INVALIDATED";
  return true;
}

/**
 * Drops every pending or approved record to invalidated, then releases
 * terminal records from the strong list. A held handle stays invalidated.
 */
export function invalidateActiveApprovals(): void {
  for (const handle of registryState.handles) {
    const record = registryState.records.get(handle);
    if (record && record.status !== "INVALIDATED" && record.status !== "CONSUMED") {
      record.status = "INVALIDATED";
    }
  }
  releaseInvalidatedApprovals();
}

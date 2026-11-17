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
 * An invalidated record stays invalidated. Matching bytes do not approve it
 * again. The registry does not read storage, does not send, and does not
 * change whether a grounded fact is verified.
 */

export type ApprovalLifecycle =
  | "NO_APPROVAL"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "INVALIDATED";

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
  status: "PENDING_APPROVAL" | "APPROVED" | "INVALIDATED";
  schema: ApprovalSchema;
  canonicalBytes: string;
  noticeGeneration: number;
  identifierContextId: string;
  responseGoal: ResponseGoal;
  flagsKey: string;
  extractionGeneration: number;
  documentContextId: string;
}

const handleBrand = Symbol("noticelens.approval-handle");
const records = new WeakMap<object, StoredRecord>();
const handles: object[] = [];

const OPAQUE_ID = /^(?:ie-\d+|idctx-\d+|legacy-doc-\d+|sess-\d+-doc-\d+)$/;
const RESPONSE_GOALS = new Set<string>(ALLOWED_RESPONSE_GOALS);
const CIRCUMSTANCE_FLAGS = new Set<string>(ALLOWED_CIRCUMSTANCE_FLAGS);

export function resetApprovalRegistryForTests(): void {
  handles.length = 0;
}

function lookup(handle: unknown): StoredRecord | null {
  if (handle === null || typeof handle !== "object") {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(handle, handleBrand)) {
    return null;
  }
  return records.get(handle) ?? null;
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
    },
    second.value
  );
}

export function registerApprovablePayload(binding: ApprovalBinding): RegisterResult {
  const normalized = normalize(binding);
  if (!normalized.ok) {
    return { ok: false, lifecycle: "NO_APPROVAL", reason: normalized.reason };
  }
  const record: StoredRecord = {
    status: "PENDING_APPROVAL",
    ...normalized.value,
  };
  const handle = {};
  Object.defineProperty(handle, handleBrand, { value: true });
  Object.defineProperty(handle, "kind", {
    value: "noticelens.approval-handle",
    enumerable: true,
  });
  Object.freeze(handle);
  records.set(handle, record);
  handles.push(handle);
  return { ok: true, handle: handle as ApprovalHandle, lifecycle: "PENDING_APPROVAL" };
}

/**
 * Approves the pending record bound to this handle when the binding still
 * matches the registered bytes and context. A second call, a stale binding,
 * a clone, or an invalidated handle does not approve anything.
 */
export function approvePending(handle: unknown, binding: ApprovalBinding): boolean {
  const record = lookup(handle);
  const normalized = normalize(binding);
  if (!record || !normalized.ok || !matches(record, normalized.value)) {
    return false;
  }
  if (record.status !== "PENDING_APPROVAL") {
    return false;
  }
  record.status = "APPROVED";
  return true;
}

export function isPayloadApproved(binding: ApprovalBinding): boolean {
  const normalized = normalize(binding);
  if (!normalized.ok) {
    return false;
  }
  for (const handle of handles) {
    const record = records.get(handle);
    if (record && record.status === "APPROVED" && matches(record, normalized.value)) {
      return true;
    }
  }
  return false;
}

export function bindingLifecycle(binding: ApprovalBinding): ApprovalLifecycle {
  const normalized = normalize(binding);
  if (!normalized.ok) {
    return "NO_APPROVAL";
  }
  let sawPending = false;
  let sawInvalidated = false;
  for (const handle of handles) {
    const record = records.get(handle);
    if (!record || !matches(record, normalized.value)) {
      continue;
    }
    if (record.status === "APPROVED") {
      return "APPROVED";
    }
    if (record.status === "PENDING_APPROVAL") {
      sawPending = true;
    } else {
      sawInvalidated = true;
    }
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

export function revokeApproval(handle: unknown): boolean {
  const record = lookup(handle);
  if (!record || record.status === "INVALIDATED") {
    return false;
  }
  record.status = "INVALIDATED";
  return true;
}

/** Drops every pending or approved record. Invalidated records stay invalidated. */
export function invalidateActiveApprovals(): void {
  for (const handle of handles) {
    const record = records.get(handle);
    if (record && record.status !== "INVALIDATED") {
      record.status = "INVALIDATED";
    }
  }
}

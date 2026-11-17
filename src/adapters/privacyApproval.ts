import { CLOUD_SUBMISSION_BLOCKED_REASON } from "./cloudApprovalSession";
import {
  canonicalCloudPayload,
  CloudPayloadValidationError,
  type CloudPayloadGuardOptions,
} from "../domain/cloudPayloadGuard";
import {
  canonicalClosedCloudBrief,
  ClosedCloudBriefValidationError,
} from "../domain/closedCloudBrief";
import { CloudSendSafetyError } from "../domain/cloudSendApproval";
import {
  approvalLifecycle,
  approvalRegistryTestIsolation,
  approvePending,
  authoriseExactApproval,
  registerApprovablePayload,
  releaseInvalidatedApprovals,
  revokeApproval,
  type ApprovalBinding,
  type ApprovalHandle,
} from "../domain/approvalRegistry";
import {
  hasPartialPlaceholderIdentifier,
  isCanonicalPlaceholder,
  listPlaceholderTokens,
} from "../domain/placeholders";
import type { CircumstanceFlag, ResponseGoal } from "../domain/types";

/**
 * A person's approval of one exact canonical payload.
 * Recording it does not call `CloudPayloadApproval.begin`, so the in-flight
 * lock stays free for a later single acquisition. This object cannot send.
 */
export interface UserPayloadApproval {
  readonly kind: "user-canonical-snapshot";
  readonly id: string;
  readonly generation: number;
  readonly serialized: string;
  readonly guardOptions: CloudPayloadGuardOptions;
  /** Sorted identifier list captured with this approval. Not notice prose. */
  readonly identifierContext: string;
  readonly cloudSendEnabled: false;
  /** Context captured at approval. A later check must pass the current context; this copy is not authority by itself. */
  readonly boundContext?: ApprovalCheckContext;
}

export interface ApprovalCheckContext {
  readonly guardOptions: CloudPayloadGuardOptions;
  readonly responseGoal: ResponseGoal;
  readonly circumstanceFlags: readonly CircumstanceFlag[];
  readonly extractionGeneration: number;
  readonly documentContextId: string;
}

export interface PrivacyApprovalView {
  readonly serialized: string | null;
  readonly limitations: readonly string[];
  readonly approval: UserPayloadApproval | null;
  readonly matchesCurrentPayload: boolean;
  readonly cloudSendEnabled: false;
  readonly blockedReason: string;
}

let nextApprovalId = 1;
let opaqueCounter = 0;
let legacyDocumentCounter = 0;
const consumedApprovalIds = new Set<string>();
const opaqueByIdentifierKey = new Map<string, string>();

interface ApprovalLink {
  handle: ApprovalHandle;
  identifierKey: string;
  binding: ApprovalBinding;
}

const links = new Map<string, ApprovalLink>();

export function resetUserApprovalStateForTests(): void {
  nextApprovalId = 1;
  opaqueCounter = 0;
  legacyDocumentCounter = 0;
  consumedApprovalIds.clear();
  opaqueByIdentifierKey.clear();
  links.clear();
  approvalRegistryTestIsolation.reset();
}

function opaqueIdentifierContext(key: string): string {
  const existing = opaqueByIdentifierKey.get(key);
  if (existing) {
    return existing;
  }
  opaqueCounter += 1;
  const minted = `idctx-${opaqueCounter}`;
  opaqueByIdentifierKey.set(key, minted);
  return minted;
}

/**
 * The domain registry is the authority. The returned adapter object keeps the
 * fields existing callers read. Its guard-option arrays are a separate copy,
 * so mutating them does not change the stored record.
 */
function retainApproved(input: {
  id: string;
  schema: ApprovalBinding["schema"];
  canonicalBytes: string;
  noticeGeneration: number;
  identifierKey: string;
  responseGoal: ResponseGoal;
  circumstanceFlags: readonly CircumstanceFlag[];
  guardOptions: CloudPayloadGuardOptions;
}): ApprovalCheckContext {
  legacyDocumentCounter += 1;
  const binding: ApprovalBinding = {
    schema: input.schema,
    canonicalBytes: input.canonicalBytes,
    noticeGeneration: input.noticeGeneration,
    identifierContextId: opaqueIdentifierContext(input.identifierKey),
    responseGoal: input.responseGoal,
    circumstanceFlags: input.circumstanceFlags,
    extractionGeneration: 0,
    documentContextId: `legacy-doc-${legacyDocumentCounter}`,
  };
  const registered = registerApprovablePayload(binding);
  if (!registered.ok || !approvePending(registered.handle, binding)) {
    if (registered.ok) {
      revokeApproval(registered.handle);
      releaseInvalidatedApprovals();
    }
    throw new CloudSendSafetyError("Approval payload failed canonical validation");
  }
  links.set(input.id, {
    handle: registered.handle,
    identifierKey: input.identifierKey,
    binding,
  });
  return {
    guardOptions: input.guardOptions,
    responseGoal: binding.responseGoal,
    circumstanceFlags: [...binding.circumstanceFlags],
    extractionGeneration: binding.extractionGeneration,
    documentContextId: binding.documentContextId,
  };
}

function collectStrings(value: unknown, found: string[]): void {
  if (typeof value === "string") {
    found.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, found);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collectStrings(nested, found);
    }
  }
}

function assertPlaceholderIntegrity(payload: unknown): void {
  const strings: string[] = [];
  collectStrings(payload, strings);
  for (const text of strings) {
    if (hasPartialPlaceholderIdentifier(text)) {
      throw new CloudSendSafetyError("Approval payload contains a partial identifier");
    }
    for (const token of listPlaceholderTokens(text)) {
      if (!isCanonicalPlaceholder(token)) {
        throw new CloudSendSafetyError("Approval payload contains a malformed placeholder");
      }
    }
  }
}

function copyGuardOptions(options: CloudPayloadGuardOptions): CloudPayloadGuardOptions {
  return {
    rawNoticeText: options.rawNoticeText,
    forbiddenIdentifiers: [...(options.forbiddenIdentifiers ?? [])],
  };
}

export function identifierContextKey(options: CloudPayloadGuardOptions | undefined): string {
  return JSON.stringify([...(options?.forbiddenIdentifiers ?? [])].slice().sort());
}

/**
 * Records approval only when the supplied bytes are the current canonical payload.
 * The guard options are the same set used to build that payload. Caller claims that
 * the payload was already validated are not accepted: this function runs
 * `canonicalCloudPayload` again. `generation` is the edit generation the person
 * approved. A later edit, including one that restores the same text, uses a newer
 * generation and does not match.
 */
export function recordUserPayloadApproval(
  serialized: string,
  currentCanonicalSerialized: string,
  generation: number,
  options: CloudPayloadGuardOptions
): UserPayloadApproval {
  if (!Number.isInteger(generation) || generation < 0) {
    throw new CloudSendSafetyError("Approval generation is not current");
  }
  if (serialized !== currentCanonicalSerialized) {
    throw new CloudSendSafetyError("Approval must match the current canonical payload");
  }
  if (serialized !== serialized.trim() || serialized.includes("\n") || serialized.includes("\r")) {
    throw new CloudSendSafetyError("Approval must be the exact canonical serialized payload");
  }
  const guardOptions = copyGuardOptions(options);
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new CloudSendSafetyError("Approval must be the exact canonical serialized payload");
  }
  let canonical;
  try {
    canonical = canonicalCloudPayload(parsed, guardOptions);
  } catch (error) {
    if (error instanceof CloudPayloadValidationError) {
      throw new CloudSendSafetyError("Approval payload failed canonical validation");
    }
    throw error;
  }
  if (canonical.serialized !== serialized) {
    throw new CloudSendSafetyError("Approval must be the exact canonical serialized payload");
  }
  assertPlaceholderIntegrity(canonical.payload);
  const id = `user-approval-${nextApprovalId}`;
  nextApprovalId += 1;
  const identifierContext = identifierContextKey(guardOptions);
  const boundContext = retainApproved({
    id,
    schema: "noticelens.cloud-brief.v1",
    canonicalBytes: canonical.serialized,
    noticeGeneration: generation,
    identifierKey: identifierContext,
    responseGoal: canonical.payload.responseGoal,
    circumstanceFlags: canonical.payload.circumstanceFlags ?? [],
    guardOptions,
  });
  return {
    kind: "user-canonical-snapshot",
    id,
    generation,
    serialized: canonical.serialized,
    guardOptions,
    identifierContext,
    cloudSendEnabled: false,
    boundContext,
  };
}

/**
 * Records approval of one exact v2 brief. v1 payloads are rejected.
 * This does not call `CloudPayloadApproval.begin` and does not send.
 */
export function recordClosedBriefApproval(
  serialized: string,
  currentCanonicalSerialized: string,
  generation: number,
  options: CloudPayloadGuardOptions
): UserPayloadApproval {
  if (!Number.isInteger(generation) || generation < 0) {
    throw new CloudSendSafetyError("Approval generation is not current");
  }
  if (serialized !== currentCanonicalSerialized) {
    throw new CloudSendSafetyError("Approval must match the current canonical payload");
  }
  if (serialized !== serialized.trim() || serialized.includes("\n") || serialized.includes("\r")) {
    throw new CloudSendSafetyError("Approval must be the exact canonical serialized payload");
  }
  const guardOptions = copyGuardOptions(options);
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new CloudSendSafetyError("Approval must be the exact canonical serialized payload");
  }
  let canonical;
  try {
    canonical = canonicalClosedCloudBrief(parsed);
  } catch (error) {
    if (error instanceof ClosedCloudBriefValidationError) {
      throw new CloudSendSafetyError("Approval payload failed canonical validation");
    }
    throw error;
  }
  if (canonical.serialized !== serialized) {
    throw new CloudSendSafetyError("Approval must be the exact canonical serialized payload");
  }
  assertPlaceholderIntegrity(canonical.payload);
  const id = `user-approval-${nextApprovalId}`;
  nextApprovalId += 1;
  const identifierContext = identifierContextKey(guardOptions);
  const boundContext = retainApproved({
    id,
    schema: "noticelens.cloud-brief.v2",
    canonicalBytes: canonical.serialized,
    noticeGeneration: generation,
    identifierKey: identifierContext,
    responseGoal: canonical.payload.responseGoal,
    circumstanceFlags: canonical.payload.circumstanceFlags ?? [],
    guardOptions,
  });
  return {
    kind: "user-canonical-snapshot",
    id,
    generation,
    serialized: canonical.serialized,
    guardOptions,
    identifierContext,
    cloudSendEnabled: false,
    boundContext,
  };
}

function explicitIdentifierKey(options: CloudPayloadGuardOptions | undefined): string | null {
  if (!options || !Array.isArray(options.forbiddenIdentifiers)) {
    return null;
  }
  return identifierContextKey(options);
}

function flagsKey(flags: readonly CircumstanceFlag[]): string {
  return [...flags].sort().join("\n");
}

function completeCheckContext(context: ApprovalCheckContext | undefined): ApprovalCheckContext | null {
  if (!context) {
    return null;
  }
  const identifierKey = explicitIdentifierKey(context.guardOptions);
  if (identifierKey === null) {
    return null;
  }
  if (typeof context.responseGoal !== "string" || context.responseGoal.length === 0) {
    return null;
  }
  if (!Array.isArray(context.circumstanceFlags)) {
    return null;
  }
  if (
    typeof context.extractionGeneration !== "number" ||
    !Number.isSafeInteger(context.extractionGeneration) ||
    context.extractionGeneration < 0
  ) {
    return null;
  }
  if (typeof context.documentContextId !== "string" || context.documentContextId.length === 0) {
    return null;
  }
  for (const flag of context.circumstanceFlags) {
    if (typeof flag !== "string") {
      return null;
    }
  }
  return context;
}

/**
 * True only when the unused approval handle is still approved for these exact
 * bytes and the full current context. Omitted or partial context fails closed.
 * Matching JSON bytes alone is not approval.
 */
export function approvalStillMatches(
  approval: UserPayloadApproval | null,
  serialized: string | null,
  generation: number,
  context?: ApprovalCheckContext
): boolean {
  const current = completeCheckContext(context);
  if (!approval || serialized === null || !current || consumedApprovalIds.has(approval.id)) {
    return false;
  }
  const link = links.get(approval.id);
  if (!link || approvalLifecycle(link.handle) !== "APPROVED") {
    return false;
  }
  const presentedKey = explicitIdentifierKey(current.guardOptions);
  return (
    link.binding.canonicalBytes === serialized &&
    link.binding.noticeGeneration === generation &&
    presentedKey === link.identifierKey &&
    approval.identifierContext === link.identifierKey &&
    current.responseGoal === link.binding.responseGoal &&
    flagsKey(current.circumstanceFlags) === flagsKey(link.binding.circumstanceFlags) &&
    current.extractionGeneration === link.binding.extractionGeneration &&
    current.documentContextId === link.binding.documentContextId
  );
}

export function privacyApprovalView(input: {
  serialized: string | null;
  limitations: readonly string[];
  approval: UserPayloadApproval | null;
  generation: number;
  guardOptions?: CloudPayloadGuardOptions;
  context?: ApprovalCheckContext;
}): PrivacyApprovalView {
  const presentedGuard = explicitIdentifierKey(input.guardOptions);
  const contextGuard = explicitIdentifierKey(input.context?.guardOptions);
  const guardsAgree = presentedGuard !== null && contextGuard !== null && presentedGuard === contextGuard;
  const link = input.approval ? links.get(input.approval.id) : undefined;
  const identityMatches = link !== undefined && input.approval?.identifierContext === link.identifierKey;
  const matches =
    guardsAgree &&
    approvalStillMatches(input.approval, input.serialized, input.generation, input.context) &&
    (input.approval === null || identityMatches);
  return {
    serialized: input.serialized,
    limitations: input.limitations,
    approval: matches ? input.approval : null,
    matchesCurrentPayload: matches,
    cloudSendEnabled: false,
    blockedReason: CLOUD_SUBMISSION_BLOCKED_REASON,
  };
}

/**
 * Live submission stays closed. The current snapshot is revalidated with the
 * options stored at approval, then the id is consumed. A failed revalidation
 * uses a generic error and cannot be retried. This does not call
 * `CloudPayloadApproval.begin` and does not connect the cloud-send function.
 */
export function requestApprovedCloudSend(approval: UserPayloadApproval): never {
  if (consumedApprovalIds.has(approval.id)) {
    throw new CloudSendSafetyError("This approval has already been used");
  }
  const link = links.get(approval.id);
  let revalidated = false;
  try {
    const parsed: unknown = JSON.parse(approval.serialized);
    const canonical = canonicalCloudPayload(parsed, approval.guardOptions);
    const presentedKey = identifierContextKey(approval.guardOptions);
    revalidated =
      link !== undefined &&
      approvalLifecycle(link.handle) === "APPROVED" &&
      canonical.serialized === approval.serialized &&
      canonical.serialized === link.binding.canonicalBytes &&
      presentedKey === link.identifierKey &&
      approval.identifierContext === link.identifierKey &&
      approval.generation === link.binding.noticeGeneration;
  } catch (error) {
    if (!(error instanceof CloudPayloadValidationError) && !(error instanceof SyntaxError)) {
      throw error;
    }
    revalidated = false;
  }
  consumedApprovalIds.add(approval.id);
  if (!revalidated || !link) {
    if (link) {
      revokeApproval(link.handle);
      releaseInvalidatedApprovals();
    }
    throw new CloudSendSafetyError("Approval payload failed canonical validation");
  }
  const authorised = authoriseExactApproval(link.handle, link.binding);
  if (!authorised.ok) {
    revokeApproval(link.handle);
    releaseInvalidatedApprovals();
    throw new CloudSendSafetyError("Approval payload failed canonical validation");
  }
  throw new CloudSendSafetyError(CLOUD_SUBMISSION_BLOCKED_REASON);
}

/**
 * Future v2 send entry. Revalidates the approved bytes, consumes the id, and
 * still refuses to send. It does not call `CloudPayloadApproval.begin`.
 */
export function requestClosedBriefSend(approval: UserPayloadApproval): never {
  if (consumedApprovalIds.has(approval.id)) {
    throw new CloudSendSafetyError("This approval has already been used");
  }
  const link = links.get(approval.id);
  let revalidated = false;
  try {
    const parsed: unknown = JSON.parse(approval.serialized);
    const canonical = canonicalClosedCloudBrief(parsed);
    const presentedKey = identifierContextKey(approval.guardOptions);
    revalidated =
      link !== undefined &&
      approvalLifecycle(link.handle) === "APPROVED" &&
      canonical.serialized === approval.serialized &&
      canonical.serialized === link.binding.canonicalBytes &&
      presentedKey === link.identifierKey &&
      approval.identifierContext === link.identifierKey &&
      approval.generation === link.binding.noticeGeneration;
  } catch (error) {
    if (!(error instanceof ClosedCloudBriefValidationError) && !(error instanceof SyntaxError)) {
      throw error;
    }
    revalidated = false;
  }
  consumedApprovalIds.add(approval.id);
  if (!revalidated || !link) {
    if (link) {
      revokeApproval(link.handle);
      releaseInvalidatedApprovals();
    }
    throw new CloudSendSafetyError("Approval payload failed canonical validation");
  }
  const authorised = authoriseExactApproval(link.handle, link.binding);
  if (!authorised.ok) {
    revokeApproval(link.handle);
    releaseInvalidatedApprovals();
    throw new CloudSendSafetyError("Approval payload failed canonical validation");
  }
  throw new CloudSendSafetyError(CLOUD_SUBMISSION_BLOCKED_REASON);
}

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
  approvePending,
  registerApprovablePayload,
  resetApprovalRegistryForTests,
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
  canonicalBytes: string;
  noticeGeneration: number;
}

const links = new Map<string, ApprovalLink>();

export function resetUserApprovalStateForTests(): void {
  nextApprovalId = 1;
  opaqueCounter = 0;
  legacyDocumentCounter = 0;
  consumedApprovalIds.clear();
  opaqueByIdentifierKey.clear();
  links.clear();
  resetApprovalRegistryForTests();
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
}): void {
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
    }
    throw new CloudSendSafetyError("Approval payload failed canonical validation");
  }
  links.set(input.id, {
    handle: registered.handle,
    identifierKey: input.identifierKey,
    canonicalBytes: input.canonicalBytes,
    noticeGeneration: input.noticeGeneration,
  });
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
  retainApproved({
    id,
    schema: "noticelens.cloud-brief.v1",
    canonicalBytes: canonical.serialized,
    noticeGeneration: generation,
    identifierKey: identifierContext,
    responseGoal: canonical.payload.responseGoal,
    circumstanceFlags: canonical.payload.circumstanceFlags ?? [],
  });
  return {
    kind: "user-canonical-snapshot",
    id,
    generation,
    serialized: canonical.serialized,
    guardOptions,
    identifierContext,
    cloudSendEnabled: false,
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
  retainApproved({
    id,
    schema: "noticelens.cloud-brief.v2",
    canonicalBytes: canonical.serialized,
    noticeGeneration: generation,
    identifierKey: identifierContext,
    responseGoal: canonical.payload.responseGoal,
    circumstanceFlags: canonical.payload.circumstanceFlags ?? [],
  });
  return {
    kind: "user-canonical-snapshot",
    id,
    generation,
    serialized: canonical.serialized,
    guardOptions,
    identifierContext,
    cloudSendEnabled: false,
  };
}

/**
 * True only for the same generation, the same canonical bytes, and an unused id.
 * Reverting an edit does not restore a match, because the generation has moved on.
 */
export function approvalStillMatches(
  approval: UserPayloadApproval | null,
  serialized: string | null,
  generation: number
): boolean {
  if (!approval || serialized === null || consumedApprovalIds.has(approval.id)) {
    return false;
  }
  const link = links.get(approval.id);
  if (!link || approvalLifecycle(link.handle) !== "APPROVED") {
    return false;
  }
  return link.canonicalBytes === serialized && link.noticeGeneration === generation;
}

export function privacyApprovalView(input: {
  serialized: string | null;
  limitations: readonly string[];
  approval: UserPayloadApproval | null;
  generation: number;
  guardOptions?: CloudPayloadGuardOptions;
}): PrivacyApprovalView {
  const link = input.approval ? links.get(input.approval.id) : undefined;
  const contextMatches =
    input.guardOptions === undefined ||
    (link !== undefined && link.identifierKey === identifierContextKey(input.guardOptions));
  const identityMatches = link !== undefined && input.approval?.identifierContext === link.identifierKey;
  const matches =
    approvalStillMatches(input.approval, input.serialized, input.generation) &&
    contextMatches &&
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
      canonical.serialized === link.canonicalBytes &&
      presentedKey === link.identifierKey &&
      approval.identifierContext === link.identifierKey &&
      approval.generation === link.noticeGeneration;
  } catch (error) {
    if (!(error instanceof CloudPayloadValidationError) && !(error instanceof SyntaxError)) {
      throw error;
    }
    revalidated = false;
  }
  consumedApprovalIds.add(approval.id);
  if (link) {
    revokeApproval(link.handle);
  }
  if (!revalidated) {
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
      canonical.serialized === link.canonicalBytes &&
      presentedKey === link.identifierKey &&
      approval.identifierContext === link.identifierKey &&
      approval.generation === link.noticeGeneration;
  } catch (error) {
    if (!(error instanceof ClosedCloudBriefValidationError) && !(error instanceof SyntaxError)) {
      throw error;
    }
    revalidated = false;
  }
  consumedApprovalIds.add(approval.id);
  if (link) {
    revokeApproval(link.handle);
  }
  if (!revalidated) {
    throw new CloudSendSafetyError("Approval payload failed canonical validation");
  }
  throw new CloudSendSafetyError(CLOUD_SUBMISSION_BLOCKED_REASON);
}

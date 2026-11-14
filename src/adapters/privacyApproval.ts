import { CLOUD_SUBMISSION_BLOCKED_REASON } from "./cloudApprovalSession";
import { canonicalCloudPayload, CloudPayloadValidationError } from "../domain/cloudPayloadGuard";
import { CloudSendSafetyError } from "../domain/cloudSendApproval";
import {
  hasPartialPlaceholderIdentifier,
  isCanonicalPlaceholder,
  listPlaceholderTokens,
} from "../domain/placeholders";

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
const consumedApprovalIds = new Set<string>();

export function resetUserApprovalStateForTests(): void {
  nextApprovalId = 1;
  consumedApprovalIds.clear();
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

/**
 * Records approval only when the supplied bytes are the current canonical payload.
 * `generation` is the edit generation the person approved. A later edit, including
 * one that restores the same text, uses a newer generation and does not match.
 */
export function recordUserPayloadApproval(
  serialized: string,
  currentCanonicalSerialized: string,
  generation: number
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new CloudSendSafetyError("Approval must be the exact canonical serialized payload");
  }
  let canonical;
  try {
    canonical = canonicalCloudPayload(parsed);
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
  return {
    kind: "user-canonical-snapshot",
    id,
    generation,
    serialized: canonical.serialized,
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
  return Boolean(
    approval &&
      serialized &&
      approval.generation === generation &&
      !consumedApprovalIds.has(approval.id) &&
      approval.serialized === serialized
  );
}

export function privacyApprovalView(input: {
  serialized: string | null;
  limitations: readonly string[];
  approval: UserPayloadApproval | null;
  generation: number;
}): PrivacyApprovalView {
  const matches = approvalStillMatches(input.approval, input.serialized, input.generation);
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
 * Live submission stays closed. The id is consumed before the refusal, so a
 * second call cannot reuse it. This does not call `CloudPayloadApproval.begin`.
 */
export function requestApprovedCloudSend(approval: UserPayloadApproval): never {
  if (consumedApprovalIds.has(approval.id)) {
    throw new CloudSendSafetyError("This approval has already been used");
  }
  consumedApprovalIds.add(approval.id);
  throw new CloudSendSafetyError(CLOUD_SUBMISSION_BLOCKED_REASON);
}

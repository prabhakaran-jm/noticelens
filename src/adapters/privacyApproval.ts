import { CLOUD_SUBMISSION_BLOCKED_REASON } from "./cloudApprovalSession";
import { CloudSendSafetyError } from "../domain/cloudSendApproval";

/**
 * A person's approval of one exact canonical payload.
 * Recording it does not call `CloudPayloadApproval.begin`, so the in-flight
 * lock stays free for a later single acquisition. This object cannot send.
 */
export interface UserPayloadApproval {
  readonly kind: "user-canonical-snapshot";
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

/** Records approval of the exact serialized string. It does not approve itself for sending. */
export function recordUserPayloadApproval(serialized: string): UserPayloadApproval {
  if (!serialized.startsWith('{"schemaVersion":"noticelens.cloud-brief.v1"')) {
    throw new CloudSendSafetyError("Approval must be the exact canonical serialized payload");
  }
  if (serialized !== serialized.trim() || serialized.includes("\n")) {
    throw new CloudSendSafetyError("Approval must be the exact canonical serialized payload");
  }
  return {
    kind: "user-canonical-snapshot",
    serialized,
    cloudSendEnabled: false,
  };
}

/**
 * True only while the stored string equals the current canonical bytes.
 * An edit that is later reverted can match again. Recording this does not
 * invalidate the approval, and it does not check the live canonical payload.
 */
export function approvalStillMatches(
  approval: UserPayloadApproval | null,
  serialized: string | null
): boolean {
  return Boolean(approval && serialized && approval.serialized === serialized);
}

export function privacyApprovalView(input: {
  serialized: string | null;
  limitations: readonly string[];
  approval: UserPayloadApproval | null;
}): PrivacyApprovalView {
  return {
    serialized: input.serialized,
    limitations: input.limitations,
    approval: input.approval,
    matchesCurrentPayload: approvalStillMatches(input.approval, input.serialized),
    cloudSendEnabled: false,
    blockedReason: CLOUD_SUBMISSION_BLOCKED_REASON,
  };
}

/** Live submission stays closed. A matching approval still cannot start a cloud call. */
export function requestApprovedCloudSend(_approval: UserPayloadApproval): never {
  throw new CloudSendSafetyError(CLOUD_SUBMISSION_BLOCKED_REASON);
}

import type { CanonicalCloudPayload } from "../domain/cloudPayloadGuard";
import { approvalLifecycle } from "../domain/approvalRegistry";
import { CloudSendSafetyError } from "../domain/cloudSendApproval";

/**
 * Milestone 2A approval session — design only.
 *
 * A later milestone may bind a user confirmation to `canonical.serialized`
 * with `approveCloudPayload` and check `assertApprovedSnapshot` before any
 * cloud call. `runCloudDraftFromApprovedPayload` begins its own approval, so
 * a UI approval must not also call `begin()` (double-lock).
 *
 * This module does not approve, begin, or send. `cloudSendEnabled` is fixed
 * false so a notice brief cannot leave the browser from this session.
 */
export const CLOUD_SUBMISSION_ENABLED = false as const;

export const CLOUD_SUBMISSION_BLOCKED_REASON =
  "Cloud submission is not connected. Notice text is not sent for drafting until an independent security review allows it.";

export interface CloudApprovalSession {
  readonly cloudSendEnabled: false;
  readonly approval: null;
  readonly canonical: CanonicalCloudPayload | null;
  readonly violations: readonly string[];
  readonly blockedReason: string;
}

export function createCloudApprovalSession(input: {
  canonical: CanonicalCloudPayload | null;
  violations?: readonly string[];
}): CloudApprovalSession {
  return {
    cloudSendEnabled: CLOUD_SUBMISSION_ENABLED,
    approval: null,
    canonical: input.canonical,
    violations: input.violations ?? [],
    blockedReason: CLOUD_SUBMISSION_BLOCKED_REASON,
  };
}

/**
 * Always refuses. A registry record is not permission to send, whether it is
 * missing, pending, approved, or invalidated.
 */
export function requestCloudSubmission(session: CloudApprovalSession): never {
  void approvalLifecycle(session.approval);
  throw new CloudSendSafetyError(CLOUD_SUBMISSION_BLOCKED_REASON);
}

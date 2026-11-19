import { CloudDeliveryStoppedError } from "../ai/cloudCallDelivery";
import {
  draftFromFrozenCanonicalBytes,
  type CloudDraftCallOptions,
  type FrozenCloudDraft,
} from "../ai/cloudDrafter";
import { FirebaseSetupBlockerError } from "../config/firebase";
import { ClosedCloudBriefValidationError } from "../domain/closedCloudBrief";
import { CloudOutputValidationError } from "../domain/cloudOutputGuard";
import { InferenceProvenanceError } from "../domain/inferenceProvenance";
import type { CloudDraftOutput } from "../domain/types";
import { CLOUD_SUBMISSION_ENABLED } from "./cloudApprovalSession";
import {
  evaluateCloudPreflight,
  type CloudPreflightState,
  type LiveCloudPreflightState,
} from "./secureCloudPreflight";

/**
 * Explicit dispatch boundary. It reads the one mounted app that owns the reader.
 * It does not accept a caller-built context, and it does not send.
 * The returned bytes are the exact consumed canonical string.
 * They are not an authorisation token for a later request.
 *
 * Ownership is object identity for this page. Script that is already running
 * in the page can call the same module. This does not prevent XSS.
 */

export type LiveDispatchState = CloudPreflightState | "DISPATCH_DENIED" | "DISPATCH_IN_FLIGHT";

export interface LiveDispatchDecision {
  readonly state: LiveDispatchState;
  readonly authorisesSend: false;
  readonly consumed: boolean;
  readonly canonicalBytes: string | null;
}

export interface DispatchOwner {
  readonly kind: "noticelens.dispatch-owner";
}

type LiveReader = () => LiveCloudPreflightState | null;

interface Lease {
  readonly owner: DispatchOwner;
  readonly read: LiveReader;
}

const ownerBrand = Symbol("noticelens.dispatch-owner");
const leases = new Map<DispatchOwner, Lease>();
let inFlight = false;
let flightToken = 0;

function deny(state: LiveDispatchState): LiveDispatchDecision {
  return Object.freeze({
    state,
    authorisesSend: false,
    consumed: false,
    canonicalBytes: null,
  });
}

export function createDispatchOwner(): DispatchOwner {
  const owner = {};
  Object.defineProperty(owner, ownerBrand, { value: true });
  Object.defineProperty(owner, "kind", {
    value: "noticelens.dispatch-owner",
    enumerable: true,
  });
  return Object.freeze(owner) as DispatchOwner;
}

export function isDispatchOwner(value: unknown): value is DispatchOwner {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, ownerBrand)
  );
}

function plainSnapshot(live: LiveCloudPreflightState): LiveCloudPreflightState | null {
  try {
    const rawNoticeText = live.rawNoticeText;
    const today = live.today;
    const presentedSourceGenerationId = live.presentedSourceGenerationId;
    const noticeGeneration = live.noticeGeneration;
    const extractionGeneration = live.extractionGeneration;
    const identifierContextId = live.identifierContextId;
    const documentContextId = live.documentContextId;
    const responseGoal = live.responseGoal;
    const circumstanceFlags = live.circumstanceFlags;
    const presentedCanonicalBytes = live.presentedCanonicalBytes;
    const approvalHandle = live.approvalHandle;
    const flags = Array.isArray(circumstanceFlags) ? circumstanceFlags.slice() : circumstanceFlags;
    if (typeof presentedCanonicalBytes !== "string") {
      return {
        rawNoticeText,
        today,
        presentedSourceGenerationId,
        noticeGeneration,
        extractionGeneration,
        identifierContextId,
        documentContextId,
        responseGoal,
        circumstanceFlags: flags,
        presentedCanonicalBytes: "",
        approvalHandle,
      };
    }
    return {
      rawNoticeText,
      today,
      presentedSourceGenerationId,
      noticeGeneration,
      extractionGeneration,
      identifierContextId,
      documentContextId,
      responseGoal,
      circumstanceFlags: flags,
      presentedCanonicalBytes,
      approvalHandle,
    };
  } catch {
    return null;
  }
}

function soleReader(): LiveReader | null {
  if (leases.size !== 1) {
    return null;
  }
  const lease = leases.values().next().value;
  if (lease === undefined) {
    return null;
  }
  return lease.read;
}

/**
 * One synchronous attempt. The caller that acquires the lock is the only
 * caller allowed to release it.
 */
function runLocked(): { decision: LiveDispatchDecision; acquired: boolean } {
  if (inFlight) {
    return { decision: deny("DISPATCH_IN_FLIGHT"), acquired: false };
  }
  inFlight = true;
  try {
    const read = soleReader();
    if (read === null) {
      return { decision: deny("DISPATCH_DENIED"), acquired: true };
    }
    let live: LiveCloudPreflightState | null;
    try {
      live = read();
    } catch {
      return { decision: deny("DISPATCH_DENIED"), acquired: true };
    }
    if (live === null) {
      return { decision: deny("DISPATCH_DENIED"), acquired: true };
    }
    const plain = plainSnapshot(live);
    if (plain === null) {
      return { decision: deny("DISPATCH_DENIED"), acquired: true };
    }
    const decision = evaluateCloudPreflight(plain);
    if (decision.state !== "PREFLIGHT_READY" || !decision.consumed) {
      return {
        decision: deny(decision.state === "PREFLIGHT_READY" ? "DISPATCH_DENIED" : decision.state),
        acquired: true,
      };
    }
    return {
      decision: Object.freeze({
        state: "PREFLIGHT_READY",
        authorisesSend: false,
        consumed: true,
        canonicalBytes: plain.presentedCanonicalBytes,
      }),
      acquired: true,
    };
  } catch {
    return { decision: deny("DISPATCH_DENIED"), acquired: true };
  }
}

/**
 * Binds one owner to one reader. A second owner does not replace the first.
 * While more than one owner is bound, dispatch fails closed and reads nobody.
 * The cleanup closes only this binding, so an older cleanup cannot drop a newer reader.
 */
export function bindLiveCloudDispatch(owner: DispatchOwner, read: LiveReader): () => void {
  if (!isDispatchOwner(owner)) {
    return () => undefined;
  }
  const lease: Lease = { owner, read };
  leases.set(owner, lease);
  return () => {
    const current = leases.get(owner);
    if (current === lease) {
      leases.delete(owner);
    }
  };
}

/** Test isolation. Production dispatch does not call this. */
export function resetLiveCloudDispatchForTests(): void {
  leases.clear();
  inFlight = false;
  flightToken += 1;
}

/**
 * One explicit attempt. The lock lasts only for this synchronous call.
 * There is no network call and no await.
 */
export function dispatchLiveCloudBoundary(): LiveDispatchDecision {
  const attempt = runLocked();
  if (attempt.acquired) {
    inFlight = false;
  }
  return attempt.decision;
}

/**
 * Test-only hold. The promise is a signal the test already created.
 * This function does not call it with notice bytes, and it does not open a socket.
 * A production screen does not import it.
 * The production transport is `sendLiveApprovedCloudDraft`. It does not use this hold.
 * Success, rejection, and cancellation leave a consumed approval consumed.
 */
export async function deferredDispatchForTests(gate: Promise<unknown>): Promise<LiveDispatchDecision> {
  const attempt = runLocked();
  if (!attempt.acquired || attempt.decision.state !== "PREFLIGHT_READY" || !attempt.decision.consumed) {
    if (attempt.acquired) {
      inFlight = false;
    }
    return attempt.decision;
  }
  const token = flightToken;
  try {
    await gate;
  } catch {
    // The simulated operation failed or was cancelled. The approval stays consumed.
  } finally {
    if (flightToken === token) {
      inFlight = false;
    }
  }
  return attempt.decision;
}

export type LiveCloudDraftRejection =
  | "timeout"
  | "cancelled"
  | "invalid_output"
  | "network"
  | "app_check"
  | "provenance";

export type LiveCloudDraftResult =
  | { readonly outcome: "disabled" }
  | { readonly outcome: "in_flight" }
  | { readonly outcome: "stale" }
  | { readonly outcome: "denied"; readonly state: LiveDispatchState }
  | {
      readonly outcome: "rejected";
      readonly reason: LiveCloudDraftRejection;
    }
  | {
      readonly outcome: "accepted";
      readonly draft: CloudDraftOutput;
      readonly inferenceSource: "in_cloud";
      readonly modelName: string;
      readonly evidence: FrozenCloudDraft["evidence"];
    };

interface LiveStamp {
  bytes: string;
  generation: number;
  extraction: number;
  identifier: string;
  document: string;
  goal: string;
  flags: string;
}

function liveStamp(): LiveStamp | null {
  const read = soleReader();
  if (read === null) {
    return null;
  }
  let live: LiveCloudPreflightState | null;
  try {
    live = read();
  } catch {
    return null;
  }
  if (live === null || typeof live !== "object") {
    return null;
  }
  const flags = Array.isArray(live.circumstanceFlags) ? live.circumstanceFlags : null;
  return {
    bytes: typeof live.presentedCanonicalBytes === "string" ? live.presentedCanonicalBytes : "",
    generation: typeof live.noticeGeneration === "number" ? live.noticeGeneration : -1,
    extraction: typeof live.extractionGeneration === "number" ? live.extractionGeneration : -1,
    identifier: typeof live.identifierContextId === "string" ? live.identifierContextId : "",
    document: typeof live.documentContextId === "string" ? live.documentContextId : "",
    goal: typeof live.responseGoal === "string" ? live.responseGoal : "",
    flags: JSON.stringify(flags),
  };
}

function sameStamp(left: LiveStamp, right: LiveStamp): boolean {
  return (
    left.bytes === right.bytes &&
    left.generation === right.generation &&
    left.extraction === right.extraction &&
    left.identifier === right.identifier &&
    left.document === right.document &&
    left.goal === right.goal &&
    left.flags === right.flags
  );
}

function rejectDraft(error: unknown): LiveCloudDraftResult {
  if (error instanceof CloudDeliveryStoppedError) {
    return {
      outcome: "rejected",
      reason: error.reason === "timed_out" ? "timeout" : "cancelled",
    };
  }
  if (error instanceof CloudOutputValidationError || error instanceof ClosedCloudBriefValidationError) {
    return { outcome: "rejected", reason: "invalid_output" };
  }
  if (error instanceof InferenceProvenanceError) {
    return { outcome: "rejected", reason: "provenance" };
  }
  if (error instanceof FirebaseSetupBlockerError) {
    return { outcome: "rejected", reason: "app_check" };
  }
  return { outcome: "rejected", reason: "network" };
}

/** Fixed sentences. They do not include the notice, the model text, or an approval handle. */
export function liveCloudDraftMessage(result: LiveCloudDraftResult): string {
  if (result.outcome === "disabled") {
    return "Cloud sending is switched off.";
  }
  if (result.outcome === "in_flight") {
    return "A cloud request is already in progress.";
  }
  if (result.outcome === "stale") {
    return "The notice changed before the cloud result could be accepted. A new privacy approval is required to try again.";
  }
  if (result.outcome === "denied") {
    return "Cloud drafting was not sent. The current notice or approval did not pass the check.";
  }
  if (result.outcome === "accepted") {
    return "Cloud drafting returned a validated draft.";
  }
  if (result.reason === "timeout") {
    return "Cloud drafting timed out. A new privacy approval is required to try again.";
  }
  if (result.reason === "cancelled") {
    return "Cloud drafting was cancelled. A new privacy approval is required to try again.";
  }
  if (result.reason === "invalid_output") {
    return "The cloud response was rejected. A new privacy approval is required to try again.";
  }
  return "Cloud drafting was rejected. A new privacy approval is required to try again.";
}

/**
 * One explicit send. It takes no notice, no canonical bytes, and no reader.
 * A stored preflight result is not read. The live reader is snapshotted,
 * the preflight consumes one Phase 4B approval, and the frozen bytes are
 * the only text wrapped into the prompt.
 * The lock stays held until the Firebase call, or the test double, settles.
 * Failure does not restore the consumed approval.
 * While the production flag is false, a call without the test double returns
 * before that snapshot and does not touch Firebase.
 */
export async function sendLiveApprovedCloudDraft(options?: {
  generate?: CloudDraftCallOptions["generate"];
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<LiveCloudDraftResult> {
  const probe = import.meta.env.PROD ? undefined : options?.generate;
  if (probe === undefined && !CLOUD_SUBMISSION_ENABLED) {
    return { outcome: "disabled" };
  }
  const attempt = runLocked();
  if (!attempt.acquired) {
    return { outcome: "in_flight" };
  }
  const token = flightToken;
  try {
    if (attempt.decision.state !== "PREFLIGHT_READY" || !attempt.decision.consumed) {
      return {
        outcome: "denied",
        state: attempt.decision.state === "PREFLIGHT_READY" ? "DISPATCH_DENIED" : attempt.decision.state,
      };
    }
    const bytes = attempt.decision.canonicalBytes;
    if (bytes === null) {
      return { outcome: "denied", state: "DISPATCH_DENIED" };
    }
    const stamp = liveStamp();
    if (stamp === null || stamp.bytes !== bytes) {
      return { outcome: "stale" };
    }
    const drafted = await draftFromFrozenCanonicalBytes(bytes, options?.signal, {
      timeoutMs: options?.timeoutMs,
      generate: probe,
    });
    const after = liveStamp();
    if (after === null || !sameStamp(stamp, after)) {
      return { outcome: "stale" };
    }
    return {
      outcome: "accepted",
      draft: drafted.output,
      inferenceSource: drafted.inferenceSource,
      modelName: drafted.modelName,
      evidence: drafted.evidence,
    };
  } catch (error) {
    return rejectDraft(error);
  } finally {
    if (flightToken === token) {
      inFlight = false;
    }
  }
}

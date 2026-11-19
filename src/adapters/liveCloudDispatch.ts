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
 * A production screen does not import it. PR #27B would be the transport.
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

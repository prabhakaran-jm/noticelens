import {
  evaluateCloudPreflight,
  type CloudPreflightState,
  type LiveCloudPreflightState,
} from "./secureCloudPreflight";

/**
 * Explicit dispatch boundary. It reads the mounted app's live refs.
 * It does not accept a caller-built context, and it does not send.
 * The returned bytes are the exact consumed canonical string.
 * They are not an authorisation token for a later request.
 */

export type LiveDispatchState = CloudPreflightState | "DISPATCH_DENIED" | "DISPATCH_IN_FLIGHT";

export interface LiveDispatchDecision {
  readonly state: LiveDispatchState;
  readonly authorisesSend: false;
  readonly consumed: boolean;
  readonly canonicalBytes: string | null;
}

type LiveReader = () => LiveCloudPreflightState | null;

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

let reader: LiveReader | null = null;
let inFlight = false;

function deny(state: LiveDispatchState): LiveDispatchDecision {
  return Object.freeze({
    state,
    authorisesSend: false,
    consumed: false,
    canonicalBytes: null,
  });
}

/** Installed by the production app. A later install replaces the previous reader. */
export function bindLiveCloudDispatch(read: LiveReader): () => void {
  reader = read;
  return () => {
    if (reader === read) {
      reader = null;
    }
  };
}

/** Test isolation. Production dispatch does not call this. */
export function resetLiveCloudDispatchForTests(): void {
  reader = null;
  inFlight = false;
}

/**
 * One explicit attempt. Sequence: in-flight lock, synchronous live snapshot,
 * preflight, then stop. There is no network call and no await.
 */
export function dispatchLiveCloudBoundary(): LiveDispatchDecision {
  if (inFlight) {
    return deny("DISPATCH_IN_FLIGHT");
  }
  const read = reader;
  if (read === null) {
    return deny("DISPATCH_DENIED");
  }
  inFlight = true;
  try {
    let live: LiveCloudPreflightState | null;
    try {
      live = read();
    } catch {
      return deny("DISPATCH_DENIED");
    }
    if (live === null) {
      return deny("DISPATCH_DENIED");
    }
    const plain = plainSnapshot(live);
    if (plain === null) {
      return deny("DISPATCH_DENIED");
    }
    const decision = evaluateCloudPreflight(plain);
    if (decision.state !== "PREFLIGHT_READY" || !decision.consumed) {
      return deny(decision.state === "PREFLIGHT_READY" ? "DISPATCH_DENIED" : decision.state);
    }
    return Object.freeze({
      state: "PREFLIGHT_READY",
      authorisesSend: false,
      consumed: true,
      canonicalBytes: plain.presentedCanonicalBytes,
    });
  } finally {
    inFlight = false;
  }
}

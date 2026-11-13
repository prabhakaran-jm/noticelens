/**
 * Decides whether a cloud SDK result may be accepted.
 * Stopping delivery is not the same as confirming that the network request aborted.
 * networkAbortConfirmed is true only when the SDK itself rejects with AbortError.
 */

export const DEFAULT_CLOUD_CALL_TIMEOUT_MS = 20_000;
export const MAX_CLOUD_CALL_TIMEOUT_MS = 60_000;

export type CloudDeliveryStopReason = "cancelled" | "timed_out" | "late_response";

export class CloudDeliveryStoppedError extends Error {
  readonly deliveryStopped = true;
  readonly networkAbortConfirmed: boolean;
  readonly reason: CloudDeliveryStopReason;

  constructor(reason: CloudDeliveryStopReason, networkAbortConfirmed: boolean) {
    super(
      reason === "timed_out"
        ? "Cloud send timed out before a result was accepted"
        : "Cloud send was stopped before a result was accepted"
    );
    this.name = "CloudDeliveryStoppedError";
    this.reason = reason;
    this.networkAbortConfirmed = networkAbortConfirmed;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export async function acceptCloudCallResult<T>(options: {
  signal?: AbortSignal;
  timeoutMs?: number;
  execute: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLOUD_CALL_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_CLOUD_CALL_TIMEOUT_MS) {
    throw new Error("Cloud send timeout is outside the allowed bound");
  }

  const controller = new AbortController();
  let stopReason: "cancelled" | "timed_out" | null = null;
  const stop = (reason: "cancelled" | "timed_out") => {
    if (stopReason === null) {
      stopReason = reason;
    }
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };
  const onCallerAbort = () => stop("cancelled");
  options.signal?.addEventListener("abort", onCallerAbort);
  if (options.signal?.aborted) {
    stop("cancelled");
  }
  const timer = setTimeout(() => stop("timed_out"), timeoutMs);

  const pending = options.execute(controller.signal);
  const guarded = pending.then(
    (value) => ({ kind: "resolved" as const, value }),
    (error: unknown) => ({ kind: "rejected" as const, error })
  );
  const stopped = new Promise<{ kind: "stopped" }>((resolve) => {
    if (stopReason !== null) {
      resolve({ kind: "stopped" });
      return;
    }
    controller.signal.addEventListener("abort", () => resolve({ kind: "stopped" }), {
      once: true,
    });
  });

  try {
    const outcome = await Promise.race([guarded, stopped]);
    if (outcome.kind === "resolved") {
      if (stopReason !== null || options.signal?.aborted || controller.signal.aborted) {
        throw new CloudDeliveryStoppedError(
          stopReason === "timed_out" ? "timed_out" : "late_response",
          false
        );
      }
      return outcome.value;
    }
    if (outcome.kind === "rejected") {
      const aborted = isAbortError(outcome.error);
      if (stopReason !== null || aborted || options.signal?.aborted) {
        throw new CloudDeliveryStoppedError(stopReason ?? "cancelled", aborted);
      }
      throw outcome.error;
    }

    const late = await Promise.race([
      guarded,
      Promise.resolve({ kind: "still_running" as const }),
    ]);
    if (late.kind === "resolved") {
      throw new CloudDeliveryStoppedError(
        stopReason === "timed_out" ? "timed_out" : "late_response",
        false
      );
    }
    if (late.kind === "rejected" && isAbortError(late.error)) {
      throw new CloudDeliveryStoppedError(stopReason ?? "cancelled", true);
    }
    throw new CloudDeliveryStoppedError(stopReason ?? "cancelled", false);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}

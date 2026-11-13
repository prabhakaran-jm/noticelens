import {
  canonicalCloudPayload,
  type CloudPayloadGuardOptions,
} from "./cloudPayloadGuard";
import type { CloudBoundStructuralPayload } from "./types";

export type CloudFlightState = "approved" | "in_flight" | "cancelled" | "settled";

export class CloudSendSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudSendSafetyError";
  }
}

let inFlightSerialized: string | null = null;

/** Test isolation only. Production sends clear the lock by settle or cancel. */
export function resetCloudSendStateForTests(): void {
  inFlightSerialized = null;
}

export class CloudPayloadApproval {
  readonly serialized: string;
  readonly payload: CloudBoundStructuralPayload;
  private state: CloudFlightState = "approved";

  private constructor(serialized: string, payload: CloudBoundStructuralPayload) {
    this.serialized = serialized;
    this.payload = payload;
  }

  static approve(input: unknown, options?: CloudPayloadGuardOptions): CloudPayloadApproval {
    const canonical = canonicalCloudPayload(input, options);
    return new CloudPayloadApproval(canonical.serialized, canonical.payload);
  }

  getState(): CloudFlightState {
    return this.state;
  }

  /** Binds the send to the approved snapshot. A second begin is rejected. */
  begin(): string {
    if (this.state === "cancelled") {
      throw new CloudSendSafetyError("Cloud send was cancelled");
    }
    if (this.state !== "approved") {
      throw new CloudSendSafetyError("Cloud send is not in an approved state");
    }
    if (inFlightSerialized !== null) {
      throw new CloudSendSafetyError("A cloud send is already in flight");
    }
    this.state = "in_flight";
    inFlightSerialized = this.serialized;
    return this.serialized;
  }

  cancel(): void {
    if (this.state === "settled") {
      throw new CloudSendSafetyError("Cloud send is already settled");
    }
    if (this.state === "in_flight" && inFlightSerialized === this.serialized) {
      inFlightSerialized = null;
    }
    this.state = "cancelled";
  }

  settle(): void {
    if (this.state !== "in_flight") {
      throw new CloudSendSafetyError("Cloud send is not in flight");
    }
    if (inFlightSerialized === this.serialized) {
      inFlightSerialized = null;
    }
    this.state = "settled";
  }
}

export function approveCloudPayload(
  input: unknown,
  options?: CloudPayloadGuardOptions
): CloudPayloadApproval {
  return CloudPayloadApproval.approve(input, options);
}

export function assertApprovedSnapshot(approval: CloudPayloadApproval, serialized: string): void {
  if (serialized !== approval.serialized) {
    throw new CloudSendSafetyError("Cloud send body does not match the approved snapshot");
  }
}

export function throwIfCloudSendAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("The operation was aborted.");
    error.name = "AbortError";
    throw error;
  }
}

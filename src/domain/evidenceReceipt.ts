export interface InferenceEvidenceReceipt {
  mode: "on_device" | "in_cloud";
  inferenceSource: "on_device" | "in_cloud" | "unreported";
  latencyMs: number;
  modelName: string | null;
  payloadFingerprint: string | null;
  outcome: "accepted" | "rejected";
}

export interface EvidenceReceiptInput {
  mode: "on_device" | "in_cloud";
  inferenceSource: string | undefined;
  latencyMs: number;
  modelName?: string | null;
  serializedPayload?: string | null;
  outcome: "accepted" | "rejected";
  rawResponseText?: string;
  noticeText?: string;
  identifiers?: readonly string[];
  prompt?: string;
}

function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Receipt safe to retain. Sensitive fields on the input are not copied,
 * even when a caller passes them.
 */
export function buildInferenceEvidenceReceipt(
  input: EvidenceReceiptInput
): InferenceEvidenceReceipt {
  const inferenceSource =
    input.inferenceSource === "on_device" || input.inferenceSource === "in_cloud"
      ? input.inferenceSource
      : "unreported";
  return {
    mode: input.mode,
    inferenceSource,
    latencyMs: Number.isFinite(input.latencyMs) ? Math.max(0, Math.round(input.latencyMs)) : 0,
    modelName: input.modelName ?? null,
    payloadFingerprint: input.serializedPayload ? fingerprint(input.serializedPayload) : null,
    outcome: input.outcome,
  };
}

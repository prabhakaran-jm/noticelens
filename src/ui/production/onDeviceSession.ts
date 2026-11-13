import { buildInferenceEvidenceReceipt } from "../../domain/evidenceReceipt";
import type { InferenceEvidenceReceipt } from "../../domain/evidenceReceipt";
import { requireInferenceSource } from "../../domain/inferenceProvenance";
import type { InferenceCallRecord, RawNoticeExtraction } from "../../domain/types";

/**
 * Accepts only the extractor's reported inferenceSource.
 * The receipt stores that source and the measured latency. It does not copy
 * the notice or the model response.
 */
export function receiptForOnDeviceCall(
  record: InferenceCallRecord<RawNoticeExtraction>
): InferenceEvidenceReceipt {
  requireInferenceSource(record.inferenceSource, "on_device");
  return buildInferenceEvidenceReceipt({
    mode: "on_device",
    inferenceSource: record.inferenceSource,
    latencyMs: record.latencyMs,
    outcome: "accepted",
  });
}

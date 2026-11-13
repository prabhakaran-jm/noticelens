import { getGenerativeModel, InferenceMode } from "firebase/ai";
import {
  getCloudFirebaseAI,
  getConfiguredCloudModelName,
} from "../config/firebase";
import {
  validateCloudBoundPayload,
  type CloudPayloadGuardOptions,
} from "../domain/cloudPayloadGuard";
import type {
  CloudBoundStructuralPayload,
  CloudDraftOutput,
  InferenceCallRecord,
} from "../domain/types";
import { buildOfgemCloudPromptExcerpt } from "../guidance/ofgemBackBilling";
import { CLOUD_DRAFT_SCHEMA } from "./schemas";

export interface CloudDraftCallResult
  extends InferenceCallRecord<CloudDraftOutput> {
  modelName: string;
  validatedPayload: CloudBoundStructuralPayload;
}

export async function runCloudDraftFromApprovedPayload(
  candidatePayload: unknown,
  guardOptions?: CloudPayloadGuardOptions,
  signal?: AbortSignal
): Promise<CloudDraftCallResult> {
  const validatedPayload = validateCloudBoundPayload(
    candidatePayload,
    guardOptions
  );

  const ai = getCloudFirebaseAI();
  const modelName = getConfiguredCloudModelName();

  const model = getGenerativeModel(ai, {
    mode: InferenceMode.ONLY_IN_CLOUD,
    inCloudParams: {
      model: modelName,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: CLOUD_DRAFT_SCHEMA,
      },
    },
  });

  const prompt = [
    "You assist UK households in understanding response options to a redacted structural notice brief.",
    "Never invent personal details; keep placeholders [RECIPIENT_NAME], [ACCOUNT_REF], [SUPPLY_ADDRESS], [ACCOUNT_REFERENCE], and [PROPERTY_ADDRESS] verbatim.",
    "Never state that a notice is legally invalid; explain conditions from the supplied guidance.",
    "",
    "CURATED OFFICIAL GUIDANCE:",
    buildOfgemCloudPromptExcerpt(),
    "",
    "USER-APPROVED REDACTED STRUCTURAL BRIEF (JSON):",
    JSON.stringify(validatedPayload, null, 2),
  ].join("\n");

  const t0 = performance.now();
  const result = await model.generateContent(
    prompt,
    signal ? { signal } : undefined
  );
  const latencyMs = Math.round(performance.now() - t0);

  const rawResponseText = result.response.text();
  const inferenceSource = result.response.inferenceSource;
  const output = JSON.parse(rawResponseText) as CloudDraftOutput;

  return {
    output,
    rawResponseText,
    inferenceSource,
    latencyMs,
    modelName,
    validatedPayload,
  };
}

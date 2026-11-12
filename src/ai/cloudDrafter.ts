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
import { CLOUD_DRAFT_SCHEMA } from "./schemas";

const OFGEM_ATTRIBUTABLE_GUIDANCE_SNIPPET = [
  "Source: Ofgem consumer guidance — 'What to do if you get a back bill' (https://www.ofgem.gov.uk/your-energy-supply/your-energy-bill/what-do-if-you-get-back-bill).",
  "Conditions: Domestic consumers generally cannot be charged for unbilled energy used more than 12 months before the bill date IF they did not previously receive an accurate bill or statement of account for it.",
  "Exceptions: The 12-month limit does NOT apply if the consumer acted unreasonably (e.g. blocking meter access, ignoring supplier requests, or unlawful abstraction).",
  "Boundary: Do NOT declare a bill legally invalid; explain the applicable conditions and draft an editable enquiry using placeholders [RECIPIENT_NAME], [ACCOUNT_REFERENCE], and [PROPERTY_ADDRESS].",
].join("\n");

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
    "Never invent personal details; keep placeholders [RECIPIENT_NAME], [ACCOUNT_REFERENCE], and [PROPERTY_ADDRESS] verbatim.",
    "Never state that a notice is legally invalid; explain conditions from the supplied guidance.",
    "",
    "CURATED OFFICIAL GUIDANCE:",
    OFGEM_ATTRIBUTABLE_GUIDANCE_SNIPPET,
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

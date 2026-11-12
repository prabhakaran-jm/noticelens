import { getGenerativeModel, InferenceMode } from "firebase/ai";
import { getOnDeviceFirebaseAI } from "../config/firebase";
import {
  ALLOWED_NOTICE_CATEGORIES,
  type InferenceCallRecord,
  type NoticeCategory,
  type RawNoticeExtraction,
} from "../domain/types";
import { NOTICE_EXTRACTION_SCHEMA } from "./schemas";

export interface OnDeviceExtractionOptions {
  onDownloadProgress?: (progressZeroToOne: number) => void;
  signal?: AbortSignal;
}

function buildOnDeviceExtractionPrompt(rawNoticeText: string): string {
  return [
    "Extract key factual obligations from the UK household notice below as JSON.",
    "Rules:",
    "- Copy each sourceQuote VERBATIM character-for-character from the notice text.",
    "- Do not paraphrase or invent text inside sourceQuote.",
    "- Set amountGBP to the numeric pound amount requested (e.g. 1280 or 645.5).",
    "- Set responseDeadline to the exact response or payment deadline date in the notice.",
    '- Set billingPeriod to the period stated in the notice, or "not stated" if none appears.',
    "",
    "NOTICE TEXT:",
    rawNoticeText,
  ].join("\n");
}

function coerceParsedExtraction(parsed: unknown): RawNoticeExtraction {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("On-device model output was not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;

  const rawCat = String(obj.noticeCategory ?? "other_household_notice");
  const noticeCategory: NoticeCategory = (
    ALLOWED_NOTICE_CATEGORIES as readonly string[]
  ).includes(rawCat)
    ? (rawCat as NoticeCategory)
    : "other_household_notice";

  const amountGBP =
    typeof obj.amountGBP === "number"
      ? obj.amountGBP
      : Number(String(obj.amountGBP ?? "").replace(/[£,\s]/g, ""));

  if (!Number.isFinite(amountGBP)) {
    throw new Error(`Invalid numeric amountGBP in extraction: ${String(obj.amountGBP)}`);
  }

  const rawObligations = Array.isArray(obj.obligations) ? obj.obligations : [];
  const obligations = rawObligations.map((item) => {
    const rec =
      typeof item === "object" && item !== null
        ? (item as Record<string, unknown>)
        : {};
    const dueStr =
      typeof rec.dueDate === "string" && rec.dueDate.trim().length > 0
        ? rec.dueDate.trim()
        : null;
    return {
      action: String(rec.action ?? "").trim(),
      dueDate: dueStr,
      sourceQuote: String(rec.sourceQuote ?? "").trim(),
    };
  });

  return {
    noticeCategory,
    issueDate: String(obj.issueDate ?? "").trim(),
    billingPeriod: String(obj.billingPeriod ?? "").trim(),
    amountGBP,
    responseDeadline: String(obj.responseDeadline ?? "").trim(),
    obligations,
  };
}

export async function runOnDeviceNoticeExtraction(
  rawNoticeText: string,
  options?: OnDeviceExtractionOptions
): Promise<InferenceCallRecord<RawNoticeExtraction>> {
  if (!rawNoticeText || rawNoticeText.trim().length === 0) {
    throw new Error("Notice text cannot be empty.");
  }

  const ai = getOnDeviceFirebaseAI();

  const model = getGenerativeModel(ai, {
    mode: InferenceMode.ONLY_ON_DEVICE,
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: "text", languages: ["en"] }],
        expectedOutputs: [{ type: "text", languages: ["en"] }],
      },
      promptOptions: {
        responseConstraint: NOTICE_EXTRACTION_SCHEMA,
      },
    },
  });

  const t0 = performance.now();
  await model.initializeDeviceModel(options?.onDownloadProgress);

  const result = await model.generateContent(
    buildOnDeviceExtractionPrompt(rawNoticeText),
    options?.signal ? { signal: options.signal } : undefined
  );
  const latencyMs = Math.round(performance.now() - t0);

  const rawResponseText = result.response.text();
  const inferenceSource = result.response.inferenceSource;
  const output = coerceParsedExtraction(JSON.parse(rawResponseText));

  return {
    output,
    rawResponseText,
    inferenceSource,
    latencyMs,
  };
}

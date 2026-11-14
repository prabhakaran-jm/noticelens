import { buildClosedCloudBrief } from "./buildClosedCloudBrief";
import type { ReadableInspectionRow } from "./cloudBriefBuilder";
import {
  cloudGuardOptionsFromPrivateIdentifiers,
  CLOUD_PAYLOAD_REDACTION_LIMITATION,
  type CloudPayloadGuardOptions,
} from "../domain/cloudPayloadGuard";
import {
  ClosedCloudBriefValidationError,
  STRUCTURAL_VALIDATION_DOES_NOT_ESTABLISH_PAYMENT_CORRECTNESS,
  trustedActionSummaryLabel,
  type CanonicalClosedCloudBrief,
  type ClosedCloudBrief,
} from "../domain/closedCloudBrief";
import { formatDisplayDate, parseCalendarDate } from "../domain/dates";
import {
  redactAndBuildBrief,
  REGEX_REDACTION_LIMITATIONS,
  type RedactAndBriefResult,
} from "../domain/redactAndBrief";
import { GUIDANCE_IDS_BY_CATEGORY, type CircumstanceFlag, type ResponseGoal } from "../domain/types";
import { briefSourceFromGrounded, type GroundedNoticeViewModel } from "./groundNoticeFacts";

export interface ClosedCloudInspection {
  redaction: RedactAndBriefResult;
  canonical: CanonicalClosedCloudBrief | null;
  violations: readonly string[];
  readableRows: readonly ReadableInspectionRow[];
  /** Exact v2 bytes. Not pretty-printed. */
  exactSerialized: string | null;
  /** Pretty JSON for reading. This is not the outbound payload. */
  formattedInspectionJson: string | null;
  guardOptions: CloudPayloadGuardOptions;
  limitations: readonly string[];
  declaredComplete: false;
}

function formatPoint(value: string): string {
  const parsed = parseCalendarDate(value);
  if (parsed) {
    return formatDisplayDate(parsed);
  }
  const month = /^(\d{4})-(\d{2})$/.exec(value);
  if (!month) {
    return value;
  }
  const asDay = parseCalendarDate(`${value}-01`);
  return asDay ? formatDisplayDate(asDay).replace(/^\d+\s/, "") : value;
}

function formatGbp(amount: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
  }).format(amount);
}

/**
 * Readable rows from the canonical v2 object. Action sentences are labels.
 * An empty amountsGBP array is "Not stated", never £0. Conditional fees and
 * unsupported actions are labelled unverified and are not copied into the JSON.
 */
export function readableRowsFromClosedBrief(
  payload: ClosedCloudBrief,
  view: GroundedNoticeViewModel
): ReadableInspectionRow[] {
  const rows: ReadableInspectionRow[] = [
    { label: "Notice category", value: payload.noticeCategory },
    {
      label: "Issue date",
      value: payload.issueDate ? formatPoint(payload.issueDate) : "Not stated",
    },
    {
      label: "Billing period",
      value: payload.billingPeriod
        ? `${formatPoint(payload.billingPeriod.start)} to ${formatPoint(payload.billingPeriod.end)}`
        : "Not stated",
    },
    {
      label: "Amounts",
      value:
        payload.amountsGBP.length === 0
          ? "Not stated"
          : payload.amountsGBP.map((amount) => formatGbp(amount)).join(", "),
    },
    {
      label: "Response deadlines",
      value:
        payload.responseDeadlines.length === 0
          ? "Not stated"
          : payload.responseDeadlines.map((date) => formatPoint(date)).join("; "),
    },
    { label: "Response goal", value: payload.responseGoal },
  ];
  if (view.amount.conditionalFeesGBP.length > 0 || (view.amount.verifiedForDisplay === null && view.amount.classified.length > 0)) {
    rows.push({ label: "Amount status", value: "Unverified" });
  }
  payload.obligations.forEach((item, index) => {
    rows.push({
      label: `Action label ${index + 1}`,
      value: `${trustedActionSummaryLabel(item.actionSummary)}; due ${
        item.dueDate ? formatPoint(item.dueDate) : "Not stated"
      }. Label, not a quotation.`,
    });
  });
  if (view.obligations.some((item) => item.headingSupport !== "supports_claim")) {
    rows.push({ label: "Unsupported actions", value: "Unverified" });
  }
  return rows;
}

/**
 * Production inspection candidate. Built from the grounded view, not from
 * v1 clause replacements. Quotations and the identifier map stay on the
 * local redaction result.
 */
export function buildClosedCloudInspection(input: {
  rawNoticeText: string;
  view: GroundedNoticeViewModel;
  responseGoal: ResponseGoal;
  circumstanceFlags?: readonly CircumstanceFlag[];
  extraKnownIdentifiers?: readonly string[];
}): ClosedCloudInspection {
  const redaction = redactAndBuildBrief({
    rawNoticeText: input.rawNoticeText,
    extraction: briefSourceFromGrounded(input.view),
    responseGoal: input.responseGoal,
    guidanceIds: [...GUIDANCE_IDS_BY_CATEGORY[input.view.noticeCategory]],
    circumstanceFlags: input.circumstanceFlags,
    extraKnownIdentifiers: input.extraKnownIdentifiers,
  });
  const guardOptions = cloudGuardOptionsFromPrivateIdentifiers({
    rawNoticeText: input.rawNoticeText,
    localRawValues: redaction.ok
      ? redaction.localIdentifierMap.entries.map((entry) => entry.rawValue)
      : [],
    extraKnownIdentifiers: input.extraKnownIdentifiers,
  });
  const limitations = [
    ...REGEX_REDACTION_LIMITATIONS,
    CLOUD_PAYLOAD_REDACTION_LIMITATION,
    STRUCTURAL_VALIDATION_DOES_NOT_ESTABLISH_PAYMENT_CORRECTNESS,
  ];
  try {
    const canonical = buildClosedCloudBrief({
      view: input.view,
      responseGoal: input.responseGoal,
      circumstanceFlags: input.circumstanceFlags,
    });
    return {
      redaction,
      canonical,
      violations: [],
      readableRows: readableRowsFromClosedBrief(canonical.payload, input.view),
      exactSerialized: canonical.serialized,
      formattedInspectionJson: JSON.stringify(canonical.payload, null, 2),
      guardOptions,
      limitations,
      declaredComplete: false,
    };
  } catch (error) {
    if (error instanceof ClosedCloudBriefValidationError) {
      return {
        redaction,
        canonical: null,
        violations: error.violations,
        readableRows: [],
        exactSerialized: null,
        formattedInspectionJson: null,
        guardOptions,
        limitations,
        declaredComplete: false,
      };
    }
    throw error;
  }
}

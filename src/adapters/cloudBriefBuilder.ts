import {
  canonicalCloudPayload,
  CloudPayloadValidationError,
  CLOUD_PAYLOAD_REDACTION_LIMITATION,
  type CanonicalCloudPayload,
} from "../domain/cloudPayloadGuard";
import { parseCalendarDate, formatDisplayDate } from "../domain/dates";
import {
  redactAndBuildBrief,
  REGEX_REDACTION_LIMITATIONS,
  type BriefSource,
  type RedactAndBriefResult,
} from "../domain/redactAndBrief";
import {
  GUIDANCE_IDS_BY_CATEGORY,
  type ActionSummaryId,
  type CircumstanceFlag,
  type CloudBoundStructuralPayload,
  type GuidanceId,
  type NoticeCategory,
  type ResponseGoal,
} from "../domain/types";

const ACTION_LABELS: Record<ActionSummaryId, string> = {
  pay_or_contact: "Pay or contact the sender",
  contact_sender: "Contact the sender",
  provide_records: "Provide records",
  request_review: "Request a review",
  pay_stated_balance: "Pay the stated balance",
  review_stated_obligation: "Review the stated obligation",
};

export interface CloudBriefEdits {
  responseGoal: ResponseGoal;
  circumstanceFlags: readonly CircumstanceFlag[];
  extraKnownIdentifiers: readonly string[];
  omittedObligationIndexes?: readonly number[];
  clauseReplacements?: Readonly<Record<number, string>>;
}

export interface ReadableInspectionRow {
  label: string;
  value: string;
}

export interface CloudBriefInspection {
  redaction: RedactAndBriefResult;
  canonical: CanonicalCloudPayload | null;
  violations: readonly string[];
  readableRows: readonly ReadableInspectionRow[];
  /** Exact bytes a future send would use. Not pretty-printed. */
  exactSerialized: string | null;
  /** Pretty JSON for reading. This is not the outbound payload. */
  formattedInspectionJson: string | null;
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

export function actionSummaryLabel(id: ActionSummaryId): string {
  return ACTION_LABELS[id];
}

export function readableRowsFromPayload(
  payload: CloudBoundStructuralPayload
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
  payload.redactedObligations.forEach((item, index) => {
    rows.push({
      label: `Clause ${index + 1}`,
      value: `${actionSummaryLabel(item.actionSummary)}; due ${
        item.dueDate ? formatPoint(item.dueDate) : "Not stated"
      }; ${item.redactedClause}`,
    });
  });
  return rows;
}

function editedPayload(
  brief: CloudBoundStructuralPayload,
  edits: CloudBriefEdits
): CloudBoundStructuralPayload {
  const omitted = new Set(edits.omittedObligationIndexes ?? []);
  const redactedObligations = brief.redactedObligations
    .map((item, index) => ({
      actionSummary: item.actionSummary,
      dueDate: item.dueDate,
      redactedClause: edits.clauseReplacements?.[index] ?? item.redactedClause,
    }))
    .filter((_, index) => !omitted.has(index));
  const next: CloudBoundStructuralPayload = {
    schemaVersion: brief.schemaVersion,
    noticeCategory: brief.noticeCategory,
    issueDate: brief.issueDate,
    billingPeriod: brief.billingPeriod,
    amountsGBP: brief.amountsGBP,
    responseDeadlines: brief.responseDeadlines,
    redactedObligations,
    responseGoal: edits.responseGoal,
    guidanceIds: brief.guidanceIds,
  };
  if (edits.circumstanceFlags.length > 0) {
    next.circumstanceFlags = [...edits.circumstanceFlags];
  }
  return next;
}

export function buildCloudBrief(input: {
  rawNoticeText: string;
  source: BriefSource;
  edits: CloudBriefEdits;
}): CloudBriefInspection {
  const limitations = [...REGEX_REDACTION_LIMITATIONS, CLOUD_PAYLOAD_REDACTION_LIMITATION];
  const redaction = redactAndBuildBrief({
    rawNoticeText: input.rawNoticeText,
    extraction: input.source,
    responseGoal: input.edits.responseGoal,
    guidanceIds: guidanceFor(input.source.noticeCategory),
    circumstanceFlags: input.edits.circumstanceFlags,
    extraKnownIdentifiers: input.edits.extraKnownIdentifiers,
  });
  if (!redaction.ok) {
    return {
      redaction,
      canonical: null,
      violations: redaction.reasons,
      readableRows: [],
      exactSerialized: null,
      formattedInspectionJson: null,
      limitations,
      declaredComplete: false,
    };
  }
  const forbiddenIdentifiers = [
    ...redaction.localIdentifierMap.entries.map((entry) => entry.rawValue),
    ...input.edits.extraKnownIdentifiers,
  ];
  try {
    const canonical = canonicalCloudPayload(editedPayload(redaction.structuralBrief, input.edits), {
      rawNoticeText: input.rawNoticeText,
      forbiddenIdentifiers,
    });
    return {
      redaction,
      canonical,
      violations: [],
      readableRows: readableRowsFromPayload(canonical.payload),
      exactSerialized: canonical.serialized,
      formattedInspectionJson: JSON.stringify(canonical.payload, null, 2),
      limitations,
      declaredComplete: false,
    };
  } catch (error) {
    if (error instanceof CloudPayloadValidationError) {
      return {
        redaction,
        canonical: null,
        violations: error.violations,
        readableRows: readableRowsFromPayload(redaction.structuralBrief),
        exactSerialized: null,
        formattedInspectionJson: null,
        limitations,
        declaredComplete: false,
      };
    }
    throw error;
  }
}

function guidanceFor(category: NoticeCategory): GuidanceId[] {
  return [...GUIDANCE_IDS_BY_CATEGORY[category]];
}

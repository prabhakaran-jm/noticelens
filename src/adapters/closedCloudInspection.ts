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
import { NOTICE_TOO_LONG_MESSAGE, noticeExceedsSupportedSize } from "../domain/noticeInputLimit";
import { GUIDANCE_IDS_BY_CATEGORY, type CircumstanceFlag, type ResponseGoal } from "../domain/types";
import {
  amountFactPresentation,
  briefSourceFromGrounded,
  deadlineFactPresentation,
  isObligationVerifiedForCloud,
  issueDateFactPresentation,
  type FactPresentation,
  type GroundedNoticeViewModel,
} from "./groundNoticeFacts";

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

function omittedCloudField(presentation: FactPresentation): string {
  if (presentation === "needs_review") {
    return "Needs review. A candidate was in the notice and was withheld. The cloud field is empty because it was not verified, not because the notice said it was absent.";
  }
  if (presentation === "conflicting") {
    return "Conflicting. Incompatible candidates were withheld. The cloud field is empty because they were not verified, not because the notice said the fact was absent.";
  }
  return "Not stated";
}

function formatGbp(amount: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
  }).format(amount);
}

function onlyConditionalFeeEvidence(view: GroundedNoticeViewModel): boolean {
  return (
    view.amount.verifiedForDisplay === null &&
    view.amount.conditionalFeesGBP.length > 0 &&
    view.amount.classified.every(
      (item) => item.role === "conditional_fee" || item.support !== "supports_claim"
    )
  );
}

/**
 * Readable rows from the canonical v2 object. Action sentences are labels.
 * An empty amountsGBP array is "Not stated", never £0. A conditional fee is
 * named as unverified and is not described as the current balance. A payment
 * heading whose only evidence is that fee is marked unverified. This display
 * does not change the v2 schema or treat structural validation as payment proof.
 */
export function readableRowsFromClosedBrief(
  payload: ClosedCloudBrief,
  view: GroundedNoticeViewModel
): ReadableInspectionRow[] {
  const rows: ReadableInspectionRow[] = [
    { label: "Notice category", value: payload.noticeCategory },
    {
      label: "Issue date",
      value: payload.issueDate
        ? formatPoint(payload.issueDate)
        : omittedCloudField(issueDateFactPresentation(view)),
    },
    {
      label: "Billing period",
      value: payload.billingPeriod
        ? `${formatPoint(payload.billingPeriod.start)} to ${formatPoint(payload.billingPeriod.end)}`
        : "Not stated",
    },
    {
      label: "Amounts",
      value: amountRowValue(payload, view),
    },
  ];
  if (view.amount.conditionalFeesGBP.length > 0) {
    const listed = view.amount.conditionalFeesGBP.map((amount) => formatGbp(amount)).join(", ");
    rows.push({
      label: "Conditional fee",
      value: `${listed} is unverified and is not the current balance.`,
    });
  }
  const otherUnverified = view.amount.classified.filter(
    (item) => item.role !== "conditional_fee" && item.verifiedForDisplay === null
  );
  if (otherUnverified.length > 0) {
    const listed = otherUnverified.map((item) => formatGbp(item.value)).join(", ");
    rows.push({
      label: "Unverified amount",
      value: `${listed} is unverified.`,
    });
  }
  rows.push(
    {
      label: "Response deadlines",
      value:
        payload.responseDeadlines.length === 0
          ? omittedCloudField(deadlineFactPresentation(view))
          : payload.responseDeadlines.map((date) => formatPoint(date)).join("; "),
    },
    { label: "Response goal", value: payload.responseGoal }
  );
  const feeOnly = onlyConditionalFeeEvidence(view);
  const usedClaims = new Set<string>();
  payload.obligations.forEach((item) => {
    const match = view.obligations.find(
      (candidate) =>
        !usedClaims.has(candidate.id) &&
        isObligationVerifiedForCloud(view, candidate) &&
        candidate.actionSummary === item.actionSummary &&
        sameDue(candidate.dueDate, item.dueDate)
    );
    if (match) {
      usedClaims.add(match.id);
    }
    const claim = match?.id ?? `unmatched-${item.actionSummary}`;
    rows.push({
      label: `Action label ${claim}`,
      value: `${trustedActionSummaryLabel(item.actionSummary)}; claim ${claim}; due ${
        item.dueDate ? formatPoint(item.dueDate) : "Not stated"
      }. Label, not a quotation.`,
    });
  });
  view.obligations.forEach((item) => {
    if (isObligationVerifiedForCloud(view, item)) {
      return;
    }
    const payment =
      item.actionSummary === "pay_stated_balance" || item.actionSummary === "pay_or_contact";
    const feeNote =
      feeOnly && payment
        ? " The only stated amount is a conditional fee, not a current balance."
        : "";
    const conflictNote =
      view.amount.conflict && payment ? " No current balance is established." : "";
    rows.push({
      label: `Unsupported action ${item.id}`,
      value: `${trustedActionSummaryLabel(item.actionSummary)} is unverified. Claim ${item.id}.${feeNote}${conflictNote}`,
    });
  });
  return rows;
}

function sameDue(viewDue: string | null, payloadDue: string | null): boolean {
  const viewIso = viewDue ? parseCalendarDate(viewDue)?.iso ?? viewDue : null;
  return viewIso === payloadDue;
}

function amountRowValue(payload: ClosedCloudBrief, view: GroundedNoticeViewModel): string {
  if (payload.amountsGBP.length > 0) {
    return payload.amountsGBP.map((amount) => formatGbp(amount)).join(", ");
  }
  const rawFigures = view.amount.conflict
    ? view.amount.amountsGBP
    : [
        ...new Set(
          view.amount.classified
            .filter((item) => item.role !== "conditional_fee" && item.verifiedForDisplay === null)
            .map((item) => item.value)
        ),
      ];
  const figures = rawFigures.map((amount) => formatGbp(amount));
  const listed = figures.join(" and ");
  if (view.amount.conflict) {
    return `No supported outstanding balance. ${listed} are unverified, and no current balance is established. amountsGBP is empty because those figures conflict, not because the notice states no amounts.`;
  }
  if (listed) {
    return `No supported outstanding balance. ${listed} is unverified. amountsGBP is empty because no outstanding balance is supported, not because the notice states no amounts.`;
  }
  return omittedCloudField(amountFactPresentation(view));
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
  const noticeText = input.view?.rawText;
  if (
    (typeof noticeText === "string" && noticeExceedsSupportedSize(noticeText)) ||
    noticeExceedsSupportedSize(input.rawNoticeText ?? "")
  ) {
    const redaction = redactAndBuildBrief({
      rawNoticeText: "",
      extraction: {
        noticeCategory: "other_household_notice",
        issueDate: null,
        billingPeriod: null,
        amountGBP: null,
        responseDeadline: null,
        obligations: [],
      },
      responseGoal: input.responseGoal,
      guidanceIds: [],
      circumstanceFlags: input.circumstanceFlags,
      extraKnownIdentifiers: input.extraKnownIdentifiers,
    });
    return {
      redaction,
      canonical: null,
      violations: [NOTICE_TOO_LONG_MESSAGE],
      readableRows: [],
      exactSerialized: null,
      formattedInspectionJson: null,
      guardOptions: cloudGuardOptionsFromPrivateIdentifiers({
        rawNoticeText: "",
        localRawValues: [],
        extraKnownIdentifiers: input.extraKnownIdentifiers,
      }),
      limitations: [
        ...REGEX_REDACTION_LIMITATIONS,
        CLOUD_PAYLOAD_REDACTION_LIMITATION,
        STRUCTURAL_VALIDATION_DOES_NOT_ESTABLISH_PAYMENT_CORRECTNESS,
      ],
      declaredComplete: false,
    };
  }
  if (typeof noticeText !== "string" || input.rawNoticeText !== noticeText) {
    const redaction = redactAndBuildBrief({
      rawNoticeText: typeof noticeText === "string" ? noticeText : "",
      extraction: input.view ? briefSourceFromGrounded(input.view) : {
        noticeCategory: "other_household_notice",
        issueDate: null,
        billingPeriod: null,
        amountGBP: null,
        responseDeadline: null,
        obligations: [],
      },
      responseGoal: input.responseGoal,
      guidanceIds: [],
      circumstanceFlags: input.circumstanceFlags,
      extraKnownIdentifiers: input.extraKnownIdentifiers,
    });
    const guardOptions = cloudGuardOptionsFromPrivateIdentifiers({
      rawNoticeText: typeof noticeText === "string" ? noticeText : "",
      localRawValues: redaction.ok
        ? redaction.localIdentifierMap.entries.map((entry) => entry.rawValue)
        : [],
      extraKnownIdentifiers: input.extraKnownIdentifiers,
    });
    return {
      redaction,
      canonical: null,
      violations: [
        "closed brief safety gate: rawNoticeText does not match the grounded notice",
      ],
      readableRows: [],
      exactSerialized: null,
      formattedInspectionJson: null,
      guardOptions,
      limitations: [
        ...REGEX_REDACTION_LIMITATIONS,
        CLOUD_PAYLOAD_REDACTION_LIMITATION,
        STRUCTURAL_VALIDATION_DOES_NOT_ESTABLISH_PAYMENT_CORRECTNESS,
      ],
      declaredComplete: false,
    };
  }
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

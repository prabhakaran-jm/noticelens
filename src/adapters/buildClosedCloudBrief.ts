import {
  canonicalClosedCloudBrief,
  ClosedCloudBriefValidationError,
  type CanonicalClosedCloudBrief,
  type ClosedCloudObligation,
} from "../domain/closedCloudBrief";
import { parseBillingWindow, parseCalendarDate } from "../domain/dates";
import type { NoticeEligibility } from "../domain/eligibility";
import { decideNoticeCategory } from "../domain/noticeCategory";
import { noticeExceedsSupportedSize } from "../domain/noticeInputLimit";
import { analyseNoticeEligibility } from "../domain/sourceGrounding";
import {
  ALLOWED_ACTION_SUMMARIES,
  GUIDANCE_IDS_BY_CATEGORY,
  type ActionSummaryId,
  type CircumstanceFlag,
  type CloudBillingWindow,
  type ResponseGoal,
} from "../domain/types";
import {
  claimOwnsPaymentSpan,
  displayVerifiedAmount,
  displayVerifiedBillingPeriod,
  hasValidSourceOffsets,
  isObligationVerifiedForCloud,
  verifiedIssueDateIso,
  verifiedResponseDeadlineIso,
  type GroundedNoticeViewModel,
} from "./groundNoticeFacts";

function eligibilityMatchesAuthority(
  supplied: NoticeEligibility | null | undefined,
  authority: NoticeEligibility
): boolean {
  if (!supplied || supplied.decisions.length !== authority.decisions.length) {
    return false;
  }
  if (
    supplied.paymentActionSupported !== authority.paymentActionSupported ||
    supplied.deadlineSupported !== authority.deadlineSupported ||
    supplied.paymentDeadlineConflict !== authority.paymentDeadlineConflict ||
    supplied.correspondenceDeadlineConflict !== authority.correspondenceDeadlineConflict ||
    supplied.issueDateConflict !== authority.issueDateConflict ||
    supplied.eligibleAmountsGBP.length !== authority.eligibleAmountsGBP.length ||
    supplied.correspondenceDeadlinesIso.length !== authority.correspondenceDeadlinesIso.length
  ) {
    return false;
  }
  for (let index = 0; index < authority.decisions.length; index += 1) {
    const left = supplied.decisions[index];
    const right = authority.decisions[index];
    if (
      !left ||
      !right ||
      left.id !== right.id ||
      left.status !== right.status ||
      left.reason !== right.reason ||
      left.amount !== right.amount ||
      left.paymentActionSupported !== right.paymentActionSupported ||
      left.deadlineSupported !== right.deadlineSupported ||
      left.deadlineConflict !== right.deadlineConflict ||
      left.deadlineIso !== right.deadlineIso ||
      left.dateIso !== right.dateIso ||
      left.evidence.start !== right.evidence.start ||
      left.evidence.end !== right.evidence.end
    ) {
      return false;
    }
  }
  return true;
}

function verifiedBillingPeriodWindow(
  view: GroundedNoticeViewModel,
  authority: NoticeEligibility
): CloudBillingWindow | null {
  const verifiedPhrase = displayVerifiedBillingPeriod(view, authority);
  return verifiedPhrase ? parseBillingWindow(verifiedPhrase) : null;
}

/**
 * Builds a closed v2 brief from the grounded view after passing the final
 * local fact-safety gate. Quotations, the redaction preview, and the
 * identifier map stay local. Every included fact must match the fresh
 * per-occurrence authority derived from `view.rawText`; tampered views fail
 * closed rather than upgrading uncertain or ineligible items.
 */
export function buildClosedCloudBrief(input: {
  view: GroundedNoticeViewModel;
  responseGoal: ResponseGoal;
  circumstanceFlags?: readonly CircumstanceFlag[];
}): CanonicalClosedCloudBrief {
  const { view } = input;
  if (typeof view?.rawText !== "string") {
    throw new ClosedCloudBriefValidationError([
      "closed brief safety gate: missing authoritative notice context",
    ]);
  }
  if (noticeExceedsSupportedSize(view.rawText)) {
    throw new ClosedCloudBriefValidationError([
      "closed brief safety gate: notice exceeds the supported input size",
    ]);
  }
  const authority = analyseNoticeEligibility(view.rawText);
  if (!eligibilityMatchesAuthority(view.eligibility, authority)) {
    throw new ClosedCloudBriefValidationError([
      "closed brief safety gate: view eligibility does not match source authority",
    ]);
  }

  const issueDate = verifiedIssueDateIso(view, authority);
  const billingPeriod = verifiedBillingPeriodWindow(view, authority);
  const verifiedAmount = displayVerifiedAmount(view, authority);
  const amountsGBP = verifiedAmount === null ? [] : [verifiedAmount];
  const deadline = verifiedResponseDeadlineIso(view, authority, issueDate);

  const obligations: ClosedCloudObligation[] = [];
  const seenObligations = new Set<string>();
  for (const item of view.obligations) {
    if (
      !isObligationVerifiedForCloud(view, item, authority) ||
      item.verifiedForDisplay === null ||
      !(ALLOWED_ACTION_SUMMARIES as readonly string[]).includes(item.verifiedForDisplay)
    ) {
      continue;
    }
    const actionSummary = item.verifiedForDisplay as ActionSummaryId;
    const payable = actionSummary === "pay_stated_balance" || actionSummary === "pay_or_contact";
    const linked = item.claimId
      ? authority.decisions.find((decision) => decision.id === item.claimId) ?? null
      : null;
    if (
      payable &&
      (amountsGBP.length !== 1 ||
        !linked ||
        linked.status !== "ELIGIBLE" ||
        !linked.paymentActionSupported ||
        !hasValidSourceOffsets(item.verification, view.rawText.length) ||
        !claimOwnsPaymentSpan(linked, item.verification.startOffset, item.verification.endOffset))
    ) {
      continue;
    }
    const parsedDue = item.dueDate ? parseCalendarDate(item.dueDate) : null;
    let dueDate: string | null = null;
    if (parsedDue && parsedDue.iso !== issueDate) {
      if (payable) {
        if (
          !authority.paymentDeadlineConflict &&
          linked &&
          linked.deadlineSupported &&
          linked.deadlineIso === parsedDue.iso
        ) {
          dueDate = parsedDue.iso;
        }
      } else if (
        !authority.correspondenceDeadlineConflict &&
        authority.correspondenceDeadlinesIso.includes(parsedDue.iso)
      ) {
        dueDate = parsedDue.iso;
      }
    }
    const key = `${actionSummary}\u0000${dueDate ?? ""}`;
    if (seenObligations.has(key)) {
      continue;
    }
    seenObligations.add(key);
    obligations.push({
      actionSummary,
      dueDate,
    });
  }

  const verifiedCategory = decideNoticeCategory(view.rawText, view.noticeCategory).noticeCategory;
  const draft: Record<string, unknown> = {
    schemaVersion: "noticelens.cloud-brief.v2",
    noticeCategory: verifiedCategory,
    issueDate,
    billingPeriod,
    amountsGBP,
    responseDeadlines: deadline ? [deadline] : [],
    obligations,
    responseGoal: input.responseGoal,
    guidanceIds: [...GUIDANCE_IDS_BY_CATEGORY[verifiedCategory]],
  };
  if (input.circumstanceFlags && input.circumstanceFlags.length > 0) {
    draft.circumstanceFlags = [...input.circumstanceFlags];
  }
  return canonicalClosedCloudBrief(draft);
}

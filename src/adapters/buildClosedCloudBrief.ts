import {
  canonicalClosedCloudBrief,
  type CanonicalClosedCloudBrief,
  type ClosedCloudObligation,
} from "../domain/closedCloudBrief";
import { parseBillingWindow, parseCalendarDate } from "../domain/dates";
import {
  ALLOWED_ACTION_SUMMARIES,
  GUIDANCE_IDS_BY_CATEGORY,
  type ActionSummaryId,
  type CircumstanceFlag,
  type ResponseGoal,
} from "../domain/types";
import type { GroundedNoticeViewModel } from "./groundNoticeFacts";

/**
 * Builds a closed v2 brief from the grounded view.
 * Source quotations, the redaction preview, and the identifier map stay local.
 * Only facts with support `supports_claim` are copied, and ambiguous amounts
 * or obligations are omitted. This does not decide that R5-3 grounding is correct.
 */
export function buildClosedCloudBrief(input: {
  view: GroundedNoticeViewModel;
  responseGoal: ResponseGoal;
  circumstanceFlags?: readonly CircumstanceFlag[];
}): CanonicalClosedCloudBrief {
  const { view } = input;
  const issueDate =
    view.eligibility.decisions.some((item) => item.reason === "issue_date" && item.status === "ELIGIBLE") &&
    view.issueDate.support === "supports_claim" &&
    view.issueDate.verifiedForDisplay
      ? view.issueDate.verifiedForDisplay
      : null;
  const billingPeriod =
    view.billingPeriod.support === "supports_claim"
      ? parseBillingWindow(view.billingPeriod.verifiedForDisplay)
      : null;
  const eligibleAmounts = [
    ...new Set(
      view.eligibility.decisions
        .filter(
          (item) =>
            item.status === "ELIGIBLE" &&
            item.amount !== null &&
            (item.reason === "current_balance" ||
              item.reason === "explicit_reinstatement" ||
              item.reason === "distinct_new_charge")
        )
        .map((item) => item.amount ?? 0)
    ),
  ];
  const amountsGBP =
    view.amount.conflict ||
    view.amount.verifiedForDisplay === null ||
    eligibleAmounts.length !== 1 ||
    Math.abs(eligibleAmounts[0]! - view.amount.verifiedForDisplay) >= 0.001
      ? []
      : [view.amount.verifiedForDisplay];
  const claimDeadlines = [
    ...new Set(
      view.eligibility.decisions
        .filter((item) => item.status === "ELIGIBLE" && item.deadlineSupported && item.deadlineIso)
        .map((item) => item.deadlineIso ?? "")
    ),
  ];
  const viewDeadline =
    !view.responseDeadlines.conflicting &&
    view.responseDeadlines.support === "supports_claim" &&
    view.responseDeadlines.verifiedForDisplay &&
    view.responseDeadlines.verifiedForDisplay !== issueDate
      ? view.responseDeadlines.verifiedForDisplay
      : null;
  const deadline =
    claimDeadlines.length === 1
      ? claimDeadlines[0] !== issueDate
        ? claimDeadlines[0]!
        : null
      : claimDeadlines.length > 1
        ? null
        : viewDeadline;
  const obligations: ClosedCloudObligation[] = [];
  const seenObligations = new Set<string>();
  for (const item of view.obligations) {
    if (
      item.headingSupport !== "supports_claim" ||
      item.verifiedForDisplay === null ||
      !(ALLOWED_ACTION_SUMMARIES as readonly string[]).includes(item.verifiedForDisplay)
    ) {
      continue;
    }
    const actionSummary = item.verifiedForDisplay as ActionSummaryId;
    const payable = actionSummary === "pay_stated_balance" || actionSummary === "pay_or_contact";
    const linked = item.claimId
      ? view.eligibility.decisions.find((decision) => decision.id === item.claimId) ?? null
      : null;
    if (payable && (amountsGBP.length === 0 || !linked || linked.status !== "ELIGIBLE" || !linked.paymentActionSupported)) {
      continue;
    }
    const parsedDue = item.dueDate ? parseCalendarDate(item.dueDate) : null;
    let dueDate = parsedDue && parsedDue.iso !== issueDate ? parsedDue.iso : null;
    if (payable && dueDate && linked?.deadlineIso && dueDate !== linked.deadlineIso) {
      dueDate = null;
    }
    if (payable && dueDate && linked && !linked.deadlineSupported) {
      dueDate = null;
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
  const draft: Record<string, unknown> = {
    schemaVersion: "noticelens.cloud-brief.v2",
    noticeCategory: view.noticeCategory,
    issueDate,
    billingPeriod,
    amountsGBP,
    responseDeadlines: deadline ? [deadline] : [],
    obligations,
    responseGoal: input.responseGoal,
    guidanceIds: [...GUIDANCE_IDS_BY_CATEGORY[view.noticeCategory]],
  };
  if (input.circumstanceFlags && input.circumstanceFlags.length > 0) {
    draft.circumstanceFlags = [...input.circumstanceFlags];
  }
  return canonicalClosedCloudBrief(draft);
}

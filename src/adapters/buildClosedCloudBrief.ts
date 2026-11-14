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
    view.issueDate.support === "supports_claim" && view.issueDate.verifiedForDisplay
      ? view.issueDate.verifiedForDisplay
      : null;
  const billingPeriod =
    view.billingPeriod.support === "supports_claim"
      ? parseBillingWindow(view.billingPeriod.verifiedForDisplay)
      : null;
  const amountsGBP =
    view.amount.conflict || view.amount.verifiedForDisplay === null
      ? []
      : [view.amount.verifiedForDisplay];
  const deadline =
    !view.responseDeadlines.conflicting &&
    view.responseDeadlines.support === "supports_claim" &&
    view.responseDeadlines.verifiedForDisplay &&
    view.responseDeadlines.verifiedForDisplay !== issueDate
      ? view.responseDeadlines.verifiedForDisplay
      : null;
  const obligations: ClosedCloudObligation[] = [];
  for (const item of view.obligations) {
    if (
      item.headingSupport !== "supports_claim" ||
      item.verifiedForDisplay === null ||
      !(ALLOWED_ACTION_SUMMARIES as readonly string[]).includes(item.verifiedForDisplay)
    ) {
      continue;
    }
    const actionSummary = item.verifiedForDisplay as ActionSummaryId;
    const parsedDue = item.dueDate ? parseCalendarDate(item.dueDate) : null;
    const dueDate = parsedDue && parsedDue.iso !== issueDate ? parsedDue.iso : null;
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

import {
  distinctAmountValues,
  findExplicitGbpAmounts,
  type SourcedAmount,
} from "../domain/amounts";
import {
  extractComparableFacts,
  type ComparableNoticeFacts,
} from "../domain/compareNotices";
import {
  assessBillingPeriodGap,
  assessDeadlines,
  assessIssueDate,
  parseCalendarDate,
  type BillingPeriodGap,
  type DeadlineSetAssessment,
  type IssueDateAssessment,
} from "../domain/dates";
import type { BriefSource, BriefSourceObligation } from "../domain/redactAndBrief";
import { EMPTY_ELIGIBILITY, type EligibilityDecision, type NoticeEligibility } from "../domain/eligibility";
import {
  actionSummaryFromQuote,
  analyseNoticeEligibility,
  extractCorrespondenceDeadlineIsos,
  extractIssueDateCandidateInSpan,
  extractPaymentDeadlineIso,
  groundBillingPeriod,
  groundCalendarDate,
  groundMonetaryAmount,
  groundObligation,
  isAdjacentFeeAmount,
  normalizeForRole,
  noticeSentenceSpans,
  paymentQuoteUndermined,
  paymentSentenceRole,
  sentenceSupportsResponseDeadline,
  type ClaimSupport,
  type NoticeSentenceSpan,
} from "../domain/sourceGrounding";
import { decideNoticeCategory, type NoticeCategoryDecision } from "../domain/noticeCategory";
import type {
  ActionSummaryId,
  NoticeCategory,
  QuoteVerificationResult,
  RawNoticeExtraction,
} from "../domain/types";
import { actionSummaryLabel } from "./cloudBriefBuilder";

const MONTH =
  "January|February|March|April|May|June|July|August|September|October|November|December";

const DATE_TOKEN = new RegExp(
  `\\b(\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\s+(?:${MONTH})\\s+\\d{4})\\b`,
  "gi"
);

export interface ClassifiedAmount {
  value: number;
  raw: string;
  quote: string;
  role: "balance" | "conditional_fee" | "other";
  support: ClaimSupport;
  verifiedForDisplay: number | null;
  verification: QuoteVerificationResult | null;
}

export interface GroundedAmountView {
  /** Main balance only. A conditional fee never fills this. Missing stays null. */
  value: number | null;
  verifiedForDisplay: number | null;
  amountsGBP: number[];
  conditionalFeesGBP: number[];
  support: ClaimSupport;
  conflict: boolean;
  quote: string | null;
  verification: QuoteVerificationResult | null;
  classified: ClassifiedAmount[];
}

export interface GroundedDateView {
  stated: string | null;
  iso: string | null;
  allStated: string[];
  allIso: string[];
  quote: string | null;
  support: ClaimSupport;
  verifiedForDisplay: string | null;
  verification: QuoteVerificationResult | null;
  conflicting: boolean;
}

export interface GroundedObligationView {
  id: string;
  /** Free-text action from the model or a local paraphrase. Never the card heading. */
  action: string;
  /** Deterministic classification of the quotation, not of the free-text action. */
  actionSummary: ActionSummaryId;
  /**
   * True only when every substantive word, amount, and date in `action` is in the quotation.
   * A word-for-word quote location does not set this.
   */
  modelActionSupported: boolean;
  dueDate: string | null;
  sourceQuote: string;
  /** Quote-level support, including amount and date claims the quotation does not contain. */
  support: ClaimSupport;
  /**
   * Status of the deterministic heading. `supports_claim` requires action words in the
   * quotation. Finding the quotation in the notice is not enough.
   */
  headingSupport: ClaimSupport;
  verifiedForDisplay: string | null;
  verification: QuoteVerificationResult | null;
  claimExceedsQuote: boolean;
  /** Eligibility decision this action belongs to. Local only. Absent from v2. */
  claimId: string | null;
}

export interface GroundedNoticeViewModel {
  rawText: string;
  noticeCategory: NoticeCategory;
  categoryDecision: NoticeCategoryDecision;
  issueDate: GroundedDateView & { assessment: IssueDateAssessment };
  amount: GroundedAmountView;
  billingPeriod: {
    stated: string | null;
    quote: string | null;
    support: ClaimSupport;
    verifiedForDisplay: string | null;
    verification: QuoteVerificationResult | null;
    gap: BillingPeriodGap;
  };
  responseDeadlines: GroundedDateView & { assessment: DeadlineSetAssessment };
  obligations: GroundedObligationView[];
  comparable: ComparableNoticeFacts;
  /** Computed once. Screens and the v2 builder must not upgrade a non-eligible claim. */
  eligibility: NoticeEligibility;
}

const BALANCE_DECISION_REASONS = new Set<EligibilityDecision["reason"]>([
  "current_balance",
  "explicit_reinstatement",
  "distinct_new_charge",
]);

export function hasValidSourceOffsets(
  verification: QuoteVerificationResult | null | undefined,
  rawTextLength: number
): verification is QuoteVerificationResult & { startOffset: number; endOffset: number } {
  if (!verification || verification.verified !== true) {
    return false;
  }
  const { startOffset, endOffset } = verification;
  return (
    typeof startOffset === "number" &&
    typeof endOffset === "number" &&
    Number.isInteger(startOffset) &&
    Number.isInteger(endOffset) &&
    startOffset >= 0 &&
    endOffset > startOffset &&
    endOffset <= rawTextLength
  );
}

export function displayVerifiedAmount(
  view: GroundedNoticeViewModel,
  authority: NoticeEligibility = view.eligibility
): number | null {
  const raw = view.amount.verifiedForDisplay;
  if (raw === null || view.amount.conflict || view.amount.support !== "supports_claim") {
    return null;
  }
  if (!hasValidSourceOffsets(view.amount.verification, view.rawText.length)) {
    return null;
  }
  if (authority.decisions.some((item) => item.status === "NEEDS_REVIEW" && item.reason === "conflicting_balances")) {
    return null;
  }
  const eligibleBalances = authority.decisions.filter(
    (item) => item.status === "ELIGIBLE" && item.amount !== null && BALANCE_DECISION_REASONS.has(item.reason)
  );
  const distinctValues = distinctAmountValues(
    eligibleBalances.map((item) => ({ value: item.amount!, raw: String(item.amount), index: 0 }))
  );
  if (distinctValues.length !== 1 || Math.abs(distinctValues[0]! - raw) >= 0.001) {
    return null;
  }
  const { startOffset, endOffset } = view.amount.verification;
  const matched = eligibleBalances.some(
    (item) =>
      Math.abs(item.amount! - raw) < 0.001 &&
      item.evidence.start <= startOffset &&
      endOffset <= item.evidence.end
  );
  return matched ? raw : null;
}

export function verifiedIssueDateIso(
  view: GroundedNoticeViewModel,
  authority: NoticeEligibility = view.eligibility
): string | null {
  const iso = view.issueDate.verifiedForDisplay;
  if (!iso || view.issueDate.conflicting || view.issueDate.support !== "supports_claim") {
    return null;
  }
  if (authority.issueDateConflict) {
    return null;
  }
  if (!hasValidSourceOffsets(view.issueDate.verification, view.rawText.length)) {
    return null;
  }
  const eligibleIssueDecisions = authority.decisions.filter(
    (item) => item.status === "ELIGIBLE" && item.reason === "issue_date" && item.dateIso !== null
  );
  const distinctIsos = [...new Set(eligibleIssueDecisions.map((item) => item.dateIso!))];
  if (distinctIsos.length !== 1 || distinctIsos[0] !== iso) {
    return null;
  }
  const { startOffset, endOffset } = view.issueDate.verification;
  const matched = eligibleIssueDecisions.some(
    (item) =>
      item.dateIso === iso &&
      item.evidence.start <= startOffset &&
      endOffset <= item.evidence.end
  );
  return matched ? iso : null;
}

export function displayVerifiedIssueDate(
  view: GroundedNoticeViewModel,
  authority: NoticeEligibility = view.eligibility
): string | null {
  const iso = verifiedIssueDateIso(view, authority);
  const raw = view.issueDate.stated;
  if (!iso || !raw) {
    return null;
  }
  const parsedStated = parseCalendarDate(raw.replace(/(\d{1,2})(?:st|nd|rd|th)\b/i, "$1"))?.iso ?? null;
  return parsedStated === iso ? raw : null;
}

export function verifiedResponseDeadlineIso(
  view: GroundedNoticeViewModel,
  authority: NoticeEligibility = view.eligibility,
  issueDateIso: string | null = verifiedIssueDateIso(view, authority)
): string | null {
  if (
    view.responseDeadlines.conflicting ||
    view.responseDeadlines.support !== "supports_claim" ||
    !view.responseDeadlines.verifiedForDisplay
  ) {
    return null;
  }
  if (authority.paymentDeadlineConflict || authority.correspondenceDeadlineConflict) {
    return null;
  }
  const claimDeadlines = [
    ...new Set(
      authority.decisions
        .filter(
          (item) =>
            item.status === "ELIGIBLE" &&
            item.amount !== null &&
            BALANCE_DECISION_REASONS.has(item.reason) &&
            item.deadlineSupported &&
            item.deadlineIso &&
            item.deadlineIso !== issueDateIso
        )
        .map((item) => item.deadlineIso!)
    ),
  ];
  const corrDeadlines = authority.correspondenceDeadlinesIso.filter((iso) => iso !== issueDateIso);
  if (claimDeadlines.length > 1 || corrDeadlines.length > 1) {
    return null;
  }
  if (claimDeadlines.length === 1 && corrDeadlines.length === 1 && claimDeadlines[0] !== corrDeadlines[0]) {
    return null;
  }
  const authoritativeIso = claimDeadlines[0] ?? corrDeadlines[0] ?? null;
  if (!authoritativeIso || authoritativeIso === issueDateIso) {
    return null;
  }
  return view.responseDeadlines.verifiedForDisplay === authoritativeIso ? authoritativeIso : null;
}

export function displayVerifiedBillingPeriod(
  view: GroundedNoticeViewModel,
  authority: NoticeEligibility = view.eligibility
): string | null {
  const phrase = view.billingPeriod.verifiedForDisplay;
  if (!phrase || view.billingPeriod.support !== "supports_claim") {
    return null;
  }
  if (!hasValidSourceOffsets(view.billingPeriod.verification, view.rawText.length)) {
    return null;
  }
  const { startOffset, endOffset } = view.billingPeriod.verification;
  const blocked = authority.decisions.some(
    (item) =>
      item.reason === "model_directed" &&
      item.evidence.start < endOffset &&
      startOffset < item.evidence.end
  );
  if (blocked) {
    return null;
  }
  const slice = view.rawText.slice(startOffset, endOffset);
  const rechecked = groundBillingPeriod(view.rawText, phrase, slice);
  if (rechecked.support !== "supports_claim" || rechecked.verifiedForDisplay !== phrase) {
    return null;
  }
  return phrase;
}

export function isObligationVerifiedForCloud(
  view: GroundedNoticeViewModel,
  item: GroundedObligationView,
  authority: NoticeEligibility = view.eligibility
): boolean {
  if (item.headingSupport !== "supports_claim" || item.verifiedForDisplay !== item.actionSummary) {
    return false;
  }
  if (!hasValidSourceOffsets(item.verification, view.rawText.length)) {
    return false;
  }
  const { startOffset, endOffset } = item.verification;
  const slice = view.rawText.slice(startOffset, endOffset);
  if (actionSummaryFromQuote(slice) !== item.actionSummary) {
    return false;
  }
  const rechecked = groundObligation(view.rawText, "", slice);
  if (rechecked.support !== "supports_claim" || rechecked.value !== item.actionSummary) {
    return false;
  }
  if (paymentQuoteUndermined(slice, item.actionSummary, authority.eligibleAmountsGBP)) {
    return false;
  }
  const blockedByInjection = authority.decisions.some(
    (decision) =>
      decision.reason === "model_directed" &&
      decision.evidence.start < endOffset &&
      startOffset < decision.evidence.end
  );
  if (blockedByInjection) {
    return false;
  }
  const payment = item.actionSummary === "pay_stated_balance" || item.actionSummary === "pay_or_contact";
  if (!payment) {
    return true;
  }
  if (displayVerifiedAmount(view, authority) === null) {
    return false;
  }
  const linked = item.claimId
    ? authority.decisions.find((decision) => decision.id === item.claimId) ?? null
    : null;
  return (
    linked !== null &&
    linked.status === "ELIGIBLE" &&
    linked.paymentActionSupported &&
    claimOwnsPaymentSpan(linked, startOffset, endOffset)
  );
}

export function claimSupportLabel(support: ClaimSupport): string {
  switch (support) {
    case "supports_claim":
      return "Verified in notice";
    case "substring_only":
      return "Insufficient evidence — quote does not support the full claim";
    case "insufficient":
      return "Insufficient evidence — quoted fragment too short";
    case "ambiguous":
      return "Ambiguous — multiple figures or dates in the passage";
    case "incomplete":
      return "Incomplete quote — the quotation does not contain the whole sentence";
    case "missing":
      return "Not stated";
    case "unverified":
      return "Unverified — quote not found word-for-word";
  }
}

function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const endBreak = text.indexOf("\n", index);
  const end = endBreak === -1 ? text.length : endBreak;
  return text.slice(start, end).replace(/\r$/, "").trim();
}

function sentenceAt(text: string, index: number): string {
  const masked = text.replace(/"[^"]*"|“[^”]*”/g, (match) => match.replace(/[.!?]/g, " "));
  let start = 0;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const char = masked[cursor];
    if (char === "\n" || char === "." || char === "!" || char === "?") {
      start = cursor + 1;
      break;
    }
  }
  let end = text.length;
  for (let cursor = index; cursor < masked.length; cursor += 1) {
    const char = masked[cursor];
    if (char === "\n") {
      end = cursor;
      break;
    }
    if (char === "." || char === "!" || char === "?") {
      end = cursor + 1;
      break;
    }
  }
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function appearsOnlyAsByDate(text: string, token: string | null): boolean {
  if (!token) {
    return false;
  }
  const escaped = escapeRegExp(token);
  if (!new RegExp(`\\bby\\s+${escaped}\\b`, "i").test(text)) {
    return false;
  }
  const withoutBy = text.replace(new RegExp(`\\bby\\s+${escaped}\\b`, "gi"), " ");
  return !new RegExp(`\\b${escaped}\\b`, "i").test(withoutBy);
}

function calendarIsoDates(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(DATE_TOKEN)) {
    const parsed = parseCalendarDate(match[1] ?? "");
    if (parsed && !found.includes(parsed.iso)) {
      found.push(parsed.iso);
    }
  }
  return found;
}

function isDeadlineLine(line: string): boolean {
  return /\b(by|deadline|due|no later than|respond)\b/i.test(line);
}

function categoryDecisionFor(
  text: string,
  extraction?: RawNoticeExtraction | null,
  explicit?: NoticeCategory
): NoticeCategoryDecision {
  return decideNoticeCategory(text, explicit ?? extraction?.noticeCategory ?? null);
}

function isConditionalFee(sentence: string, raw: string): boolean {
  if (!/\b(if|unless|may|might|could)\b/i.test(sentence)) {
    return false;
  }
  if (!/\b(fee|surcharge|penalty)\b/i.test(sentence)) {
    return false;
  }
  const token = escapeRegExp(raw.trim());
  const balanceNear = new RegExp(
    `\\b(?:outstanding\\s+balance|balance\\s+of|balance\\s+now\\s+requested|amount\\s+due)\\s+(?:of\\s+)?${token}\\b`,
    "i"
  );
  if (balanceNear.test(sentence)) {
    return false;
  }
  const feeNear = new RegExp(
    `\\b(?:fee|surcharge|penalty)\\b(?:[^.]{0,48})${token}\\b|\\b${token}\\b(?:[^.]{0,48})\\b(?:fee|surcharge|penalty)\\b`,
    "i"
  );
  return feeNear.test(sentence);
}

function isBalanceSentence(sentence: string, raw: string): boolean {
  const token = escapeRegExp(raw.trim());
  return new RegExp(
    `\\b(?:outstanding\\s+balance|balance\\s+of|balance\\s+now\\s+requested|amount\\s+due)\\b(?:[^.]{0,40})\\b${token}\\b|\\b${token}\\b(?:[^.]{0,40})\\b(?:outstanding\\s+balance|balance)\\b`,
    "i"
  ).test(sentence);
}

function classifyAmounts(
  text: string,
  sentenceSpans: readonly NoticeSentenceSpan[],
  eligibility: NoticeEligibility
): ClassifiedAmount[] {
  return findExplicitGbpAmounts(text).amounts.map((amount) => {
    const ownerSpan =
      sentenceSpans.find((span) => span.start <= amount.index && amount.index < span.end) ?? null;
    const sentence = ownerSpan
      ? ownerSpan.raw
      : sentenceAt(text, amount.index) || lineAt(text, amount.index);
    const normSentence = normalizeForRole(sentence);
    const blockedByInjection =
      ownerSpan !== null &&
      eligibility.decisions.some(
        (decision) =>
          decision.evidence.sentenceIndex === ownerSpan.sentenceIndex &&
          decision.reason === "model_directed"
      );
    const paymentRole: ReturnType<typeof paymentSentenceRole> = blockedByInjection
      ? "injected_command"
      : paymentSentenceRole(sentence);
    const relIndex = ownerSpan ? amount.index - ownerSpan.start : sentence.indexOf(amount.raw);
    const feeFigure = isAdjacentFeeAmount(sentence, Math.max(relIndex, 0), amount.raw);
    const includedFee =
      feeFigure &&
      /\b(?:includes?|including)\b/i.test(normSentence) &&
      /\b(?:outstanding\s+balance|total\s+to\s+pay|balance)\b/i.test(normSentence);
    const retiredFee = paymentRole === "waived" || paymentRole === "refunded_payment";
    const role =
      includedFee || retiredFee
        ? "other"
        : feeFigure || paymentRole === "conditional_fee" || isConditionalFee(normSentence, amount.raw)
          ? "conditional_fee"
          : isBalanceSentence(normSentence, amount.raw) ||
              paymentRole === "current_balance" ||
              paymentRole === "reinstated_demand"
            ? "balance"
            : "other";
    const fact = groundMonetaryAmount(text, amount.value, sentence);
    const verification: QuoteVerificationResult | null =
      ownerSpan && fact.verification?.verified
        ? {
            ...fact.verification,
            startOffset: ownerSpan.start,
            endOffset: ownerSpan.end,
            matchedSubstring: text.slice(ownerSpan.start, ownerSpan.end),
          }
        : fact.verification;
    if (blockedByInjection) {
      return {
        value: amount.value,
        raw: amount.raw,
        quote: sentence,
        role: "other",
        support: "unverified",
        verifiedForDisplay: null,
        verification,
      };
    }
    const otherAmountsAreFees = findExplicitGbpAmounts(sentence).amounts
      .filter((item) => Math.abs(item.value - amount.value) >= 0.001)
      .every((item) => isAdjacentFeeAmount(sentence, item.index, item.raw));
    const includedBalance =
      !feeFigure &&
      fact.support === "ambiguous" &&
      otherAmountsAreFees &&
      /\boutstanding\s+balance\b/i.test(normSentence);
    return {
      value: amount.value,
      raw: amount.raw,
      quote: sentence,
      role,
      support: includedBalance ? "supports_claim" : fact.support,
      verifiedForDisplay: includedBalance ? amount.value : fact.verifiedForDisplay,
      verification,
    };
  });
}

function amountView(classified: ClassifiedAmount[], resolved: readonly number[]): GroundedAmountView {
  const conflictCandidates = resolved.length > 1;
  const allowed = new Set(conflictCandidates ? [] : resolved);
  const adjusted = classified.map((item) => {
    if (
      item.support === "ambiguous" &&
      resolved.length === 1 &&
      Math.abs(item.value - resolved[0]!) < 0.001 &&
      /\b(?:replac|supersed)/i.test(item.quote)
    ) {
      return {
        ...item,
        role: "balance" as const,
        support: "supports_claim" as const,
        verifiedForDisplay: item.value,
      };
    }
    if (
      resolved.length === 1 &&
      item.role !== "conditional_fee" &&
      Math.abs(item.value - resolved[0]!) < 0.001 &&
      (paymentSentenceRole(item.quote) === "current_balance" ||
        paymentSentenceRole(item.quote) === "reinstated_demand")
    ) {
      return {
        ...item,
        role: "balance" as const,
        support: "supports_claim" as const,
        verifiedForDisplay: item.value,
      };
    }
    if (item.role === "conditional_fee" || item.support !== "supports_claim") {
      return item;
    }
    if (allowed.has(item.value)) {
      return item;
    }
    return {
      ...item,
      support: conflictCandidates ? ("ambiguous" as const) : ("unverified" as const),
      verifiedForDisplay: null,
    };
  });
  const fees = adjusted.filter((item) => item.role === "conditional_fee");
  const supported = adjusted.filter(
    (item) => item.role !== "conditional_fee" && item.support === "supports_claim"
  );
  const preferred = supported.filter((item) => item.role === "balance");
  const balances = preferred.length > 0 ? preferred : supported;
  const distinctBalances = distinctAmountValues(
    balances.map((item) => ({ value: item.value, raw: item.raw, index: 0 }))
  );
  const conflict = distinctBalances.length > 1;
  const main = !conflict && distinctBalances.length === 1 ? distinctBalances[0]! : null;
  const mainItem = balances.find((item) => main !== null && Math.abs(item.value - main) < 0.001);
  const onlyFees = adjusted.length > 0 && fees.length === adjusted.length;
  const support: ClaimSupport = conflict
    ? "ambiguous"
    : mainItem
      ? "supports_claim"
      : adjusted.length === 0 || onlyFees
        ? "missing"
        : "ambiguous";
  const view: GroundedAmountView = {
    value: main,
    verifiedForDisplay: conflict ? null : mainItem?.verifiedForDisplay ?? null,
    amountsGBP: distinctBalances,
    conditionalFeesGBP: distinctAmountValues(
      fees.map((item) => ({ value: item.value, raw: item.raw, index: 0 }) satisfies SourcedAmount)
    ),
    support,
    conflict,
    quote: mainItem?.quote ?? null,
    verification: mainItem?.verification ?? null,
    classified: adjusted,
  };
  if (!conflictCandidates) {
    return view;
  }
  return {
    ...view,
    value: null,
    verifiedForDisplay: null,
    amountsGBP: [...resolved],
    support: "ambiguous",
    conflict: true,
  };
}

function dateView(
  stated: string[],
  quoteFor: (stated: string) => string | null,
  source: string
): GroundedDateView {
  const unique = [...new Set(stated.filter((item) => item.trim().length > 0))];
  const allIso = unique.flatMap((item) => {
    const parsed = parseCalendarDate(item);
    return parsed ? [parsed.iso] : calendarIsoDates(item);
  });
  const distinctIso = [...new Set(allIso)];
  const conflicting = distinctIso.length > 1;
  const primary = conflicting ? null : unique[0] ?? null;
  const quote = primary ? quoteFor(primary) : unique[0] ? quoteFor(unique[0]) : null;
  const claimedIso = primary ? parseCalendarDate(primary)?.iso ?? calendarIsoDates(primary)[0] ?? null : null;
  if (conflicting) {
    return {
      stated: null,
      iso: null,
      allStated: unique,
      allIso: distinctIso,
      quote,
      support: "ambiguous",
      verifiedForDisplay: null,
      verification: quote ? groundCalendarDate(source, claimedIso, quote).verification : null,
      conflicting: true,
    };
  }
  const fact = groundCalendarDate(source, claimedIso, quote);
  return {
    stated: primary,
    iso: fact.support === "supports_claim" ? fact.verifiedForDisplay : claimedIso,
    allStated: unique,
    allIso: distinctIso,
    quote,
    support: fact.support,
    verifiedForDisplay: fact.verifiedForDisplay,
    verification: fact.verification,
    conflicting: false,
  };
}

function soleDateToken(text: string): string | null {
  const matches = [...text.matchAll(new RegExp(DATE_TOKEN.source, "gi"))];
  if (matches.length !== 1) {
    return null;
  }
  return matches[0]?.[1] ?? null;
}

const ACTION_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "you",
  "your",
  "our",
  "this",
  "that",
  "with",
  "about",
  "from",
  "have",
  "has",
  "been",
  "will",
  "are",
  "was",
  "were",
  "not",
  "but",
  "please",
  "must",
  "may",
  "can",
  "into",
  "onto",
  "than",
  "then",
  "when",
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "where",
  "while",
  "after",
  "before",
  "their",
  "they",
  "them",
  "his",
  "her",
  "its",
  "any",
  "all",
  "each",
]);

function contentWords(text: string): string[] {
  return [...text.toLowerCase().matchAll(/\p{L}[\p{L}\p{M}'-]*/gu)]
    .map((match) => match[0] ?? "")
    .filter((word) => word.length >= 3 && !ACTION_STOPWORDS.has(word));
}

function actionClaimsUnsupportedDetail(action: string, quote: string): boolean {
  const actionAmounts = distinctAmountValues(findExplicitGbpAmounts(action).amounts);
  const quoteAmounts = distinctAmountValues(findExplicitGbpAmounts(quote).amounts);
  if (
    actionAmounts.some(
      (amount) => !quoteAmounts.some((quoted) => Math.abs(quoted - amount) < 0.001)
    )
  ) {
    return true;
  }
  const actionDates = calendarIsoDates(action);
  const quoteDates = calendarIsoDates(quote);
  return actionDates.some((iso) => !quoteDates.includes(iso));
}

/**
 * The quotation supports the whole free-text claim only when it contains that claim's
 * amounts, dates, and content words. A located quotation is not this check.
 */
function quoteSupportsEntireAction(action: string, quote: string): boolean {
  if (/\.{3}|…|\u2026/.test(quote) || actionClaimsUnsupportedDetail(action, quote)) {
    return false;
  }
  const words = contentWords(action);
  if (words.length === 0) {
    return false;
  }
  const quoted = new Set(contentWords(quote));
  return words.every((word) => quoted.has(word));
}

function claimIdentity(action: string, actionSummary: string, quote: string, start: number): string {
  const basis = `${actionSummary}\u001f${action.trim()}\u001f${quote.trim()}\u001f${start}`;
  let hash = 2166136261;
  for (let index = 0; index < basis.length; index += 1) {
    hash ^= basis.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `claim-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function locateQuote(
  text: string,
  quote: string,
  used: Set<number>,
  fallbackVerification?: QuoteVerificationResult | null
): { start: number; end: number } | null {
  const trimmed = quote.trim();
  if (!trimmed) {
    return null;
  }
  let from = 0;
  let last: { start: number; end: number } | null = null;
  while (from <= text.length) {
    const at = text.indexOf(trimmed, from);
    if (at < 0) {
      break;
    }
    last = { start: at, end: at + trimmed.length };
    if (!used.has(at)) {
      used.add(at);
      return last;
    }
    from = at + 1;
  }
  if (last) {
    return last;
  }
  if (hasValidSourceOffsets(fallbackVerification, text.length)) {
    used.add(fallbackVerification.startOffset);
    return {
      start: fallbackVerification.startOffset,
      end: fallbackVerification.endOffset,
    };
  }
  return null;
}

export function claimOwnsPaymentSpan(
  claim: NoticeEligibility["decisions"][number],
  start: number,
  end: number
): boolean {
  if (claim.status !== "ELIGIBLE" || !claim.paymentActionSupported) {
    return false;
  }
  const candidates = [
    claim.actionEvidence,
    ...claim.supporting,
  ].filter((item): item is NonNullable<typeof item> => item !== null);
  return candidates.some((item) => item.start <= start && end <= item.end);
}

function claimForSpan(
  eligibility: NoticeEligibility,
  start: number,
  end: number
): NoticeEligibility["decisions"][number] | null {
  const paymentOwner = eligibility.decisions.find(
    (item) => item.status === "ELIGIBLE" && item.amount !== null && claimOwnsPaymentSpan(item, start, end)
  );
  if (paymentOwner) {
    return paymentOwner;
  }
  const inside = eligibility.decisions.filter(
    (item) => item.evidence.start <= start && end <= item.evidence.end && item.amount !== null
  );
  const amount = inside.find((item) => item.status === "ELIGIBLE");
  return amount ?? null;
}

function headingSupportFor(
  quoteSupport: ClaimSupport,
  quote: string
): ClaimSupport {
  if (quoteSupport !== "supports_claim") {
    return quoteSupport;
  }
  // The fallback summary is chosen when the quotation has no action words.
  // Locating that quotation must not mark "Review the stated obligation" as verified.
  if (actionSummaryFromQuote(quote) === "review_stated_obligation") {
    return "substring_only";
  }
  return "supports_claim";
}

function obligationViews(
  text: string,
  comparable: ComparableNoticeFacts,
  eligibility: NoticeEligibility,
  verifiedIssueIso: string | null,
  extraction?: RawNoticeExtraction | null
): GroundedObligationView[] {
  const seeded =
    extraction && extraction.obligations.length > 0
      ? extraction.obligations.map((item) => ({
          action: item.action,
          dueDate: item.dueDate,
          sourceQuote: item.sourceQuote,
        }))
      : comparable.actionQuote
        ? [
            {
              action: comparable.statedAction ?? comparable.actionQuote,
              dueDate: null,
              sourceQuote: comparable.actionQuote,
            },
          ]
        : [];
  const resolved = eligibility.eligibleAmountsGBP;
  const usedQuotes = new Set<number>();
  return seeded.map((item) => {
    const fact = groundObligation(text, item.action, item.sourceQuote);
    const claimExceedsQuote = actionClaimsUnsupportedDetail(item.action, item.sourceQuote);
    const support =
      claimExceedsQuote && fact.support === "supports_claim" ? "substring_only" : fact.support;
    const actionSummary = fact.value ?? actionSummaryFromQuote(item.sourceQuote);
    const quoteHeading = headingSupportFor(support, item.sourceQuote);
    const undermined =
      paymentQuoteUndermined(item.sourceQuote, actionSummary, resolved) && quoteHeading === "supports_claim"
        ? "substring_only"
        : quoteHeading;
    const located = locateQuote(text, item.sourceQuote, usedQuotes, fact.verification);
    const verification: QuoteVerificationResult | null =
      located && fact.verification?.verified
        ? {
            ...fact.verification,
            startOffset: located.start,
            endOffset: located.end,
            matchedSubstring: text.slice(located.start, located.end),
          }
        : fact.verification;
    const blockedByInjection =
      located !== null &&
      eligibility.decisions.some(
        (decision) =>
          decision.reason === "model_directed" &&
          decision.evidence.start < located.end &&
          located.start < decision.evidence.end
      );
    const linked = located ? claimForSpan(eligibility, located.start, located.end) : null;
    const payment =
      actionSummary === "pay_stated_balance" || actionSummary === "pay_or_contact";
    const headingSupport: ClaimSupport = blockedByInjection
      ? "unverified"
      : payment &&
          undermined === "supports_claim" &&
          (!linked ||
            linked.status !== "ELIGIBLE" ||
            !linked.paymentActionSupported ||
            !located ||
            !claimOwnsPaymentSpan(linked, located.start, located.end))
        ? "substring_only"
        : undermined;
    const quotedDate = soleDateToken(normalizeForRole(item.sourceQuote));
    const dueInQuote =
      item.dueDate !== null &&
      calendarIsoDates(normalizeForRole(item.sourceQuote)).includes(parseCalendarDate(item.dueDate)?.iso ?? "");
    const rawDue = dueInQuote ? item.dueDate : quotedDate;
    const dueIso = rawDue ? parseCalendarDate(rawDue)?.iso ?? null : null;
    let linkedDue: string | null = null;
    if (rawDue && dueIso && dueIso !== verifiedIssueIso) {
      if (payment) {
        if (
          !eligibility.paymentDeadlineConflict &&
          linked &&
          linked.status === "ELIGIBLE" &&
          linked.deadlineSupported &&
          linked.deadlineIso === dueIso
        ) {
          linkedDue = rawDue;
        }
      } else if (
        !eligibility.correspondenceDeadlineConflict &&
        eligibility.correspondenceDeadlinesIso.includes(dueIso)
      ) {
        linkedDue = rawDue;
      }
    }
    return {
      id: claimIdentity(item.action, actionSummary, item.sourceQuote, located?.start ?? -1),
      action: item.action,
      actionSummary,
      modelActionSupported: quoteSupportsEntireAction(item.action, item.sourceQuote),
      dueDate: linkedDue,
      sourceQuote: item.sourceQuote,
      support,
      headingSupport,
      verifiedForDisplay: headingSupport === "supports_claim" ? actionSummary : null,
      verification,
      claimExceedsQuote,
      claimId: linked?.id ?? null,
    };
  });
}

function emptyAmount(): GroundedAmountView {
  return {
    value: null,
    verifiedForDisplay: null,
    amountsGBP: [],
    conditionalFeesGBP: [],
    support: "missing",
    conflict: false,
    quote: null,
    verification: null,
    classified: [],
  };
}

function deepFreeze<T>(target: T): T {
  if (target === null || typeof target !== "object" || Object.isFrozen(target)) {
    return target;
  }
  Object.freeze(target);
  for (const key of Object.keys(target as Record<string, unknown>)) {
    deepFreeze((target as Record<string, unknown>)[key]);
  }
  return target;
}

export function groundNoticeFacts(input: {
  rawNoticeText: string;
  extraction?: RawNoticeExtraction | null;
  today: string;
  noticeCategory?: NoticeCategory;
}): GroundedNoticeViewModel {
  const rawText = input.rawNoticeText ?? "";
  const comparable = extractComparableFacts(rawText);
  const categoryDecision = categoryDecisionFor(
    rawText,
    input.extraction ?? null,
    input.noticeCategory
  );
  const noticeCategory = categoryDecision.noticeCategory;
  if (rawText.trim().length === 0) {
    return deepFreeze({
      rawText,
      noticeCategory,
      categoryDecision,
      issueDate: {
        stated: null,
        iso: null,
        allStated: [],
        allIso: [],
        quote: null,
        support: "missing",
        verifiedForDisplay: null,
        verification: null,
        conflicting: false,
        assessment: assessIssueDate(null, input.today),
      },
      amount: emptyAmount(),
      billingPeriod: {
        stated: null,
        quote: null,
        support: "missing",
        verifiedForDisplay: null,
        verification: null,
        gap: assessBillingPeriodGap(null, null),
      },
      responseDeadlines: {
        stated: null,
        iso: null,
        allStated: [],
        allIso: [],
        quote: null,
        support: "missing",
        verifiedForDisplay: null,
        verification: null,
        conflicting: false,
        assessment: assessDeadlines([], input.today),
      },
      obligations: [],
      comparable,
      eligibility: EMPTY_ELIGIBILITY,
    });
  }

  const sentenceSpans = noticeSentenceSpans(rawText);
  const eligibility = analyseNoticeEligibility(rawText);
  const resolvedBalances = eligibility.eligibleAmountsGBP;

  const issueCandidates = sentenceSpans
    .map((span) => {
      const blocked = eligibility.decisions.some(
        (item) => item.evidence.sentenceIndex === span.sentenceIndex && item.reason === "model_directed"
      );
      return extractIssueDateCandidateInSpan(rawText, span, blocked);
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  let supportedIssue: GroundedDateView;
  if (eligibility.issueDateConflict && issueCandidates.length > 1) {
    supportedIssue = {
      stated: null,
      iso: null,
      allStated: [...new Set(issueCandidates.map((item) => item.stated))],
      allIso: [...new Set(issueCandidates.map((item) => item.iso))],
      quote: issueCandidates[0]?.quote ?? null,
      support: "ambiguous",
      verifiedForDisplay: null,
      verification: null,
      conflicting: true,
    };
  } else if (!eligibility.issueDateConflict && issueCandidates.length > 0) {
    const primary = issueCandidates[0]!;
    const fact = groundCalendarDate(rawText, primary.stated, primary.quote);
    const onlyAsBy = appearsOnlyAsByDate(rawText, primary.stated);
    const eligibleDecisionExists = eligibility.decisions.some(
      (item) =>
        item.status === "ELIGIBLE" &&
        item.reason === "issue_date" &&
        item.dateIso === primary.iso &&
        item.evidence.start <= primary.start &&
        primary.end <= item.evidence.end
    );
    if (!onlyAsBy && eligibleDecisionExists && (fact.support === "supports_claim" || fact.support === "insufficient")) {
      supportedIssue = {
        stated: primary.stated,
        iso: primary.iso,
        allStated: [primary.stated],
        allIso: [primary.iso],
        quote: primary.quote,
        support: "supports_claim",
        verifiedForDisplay: primary.iso,
        verification: {
          verified: true,
          matchMode: "exact",
          startOffset: primary.start,
          endOffset: primary.end,
          matchedSubstring: rawText.slice(primary.start, primary.end),
          unverifiedReason: null,
        },
        conflicting: false,
      };
    } else {
      supportedIssue = {
        stated: null,
        iso: null,
        allStated: [primary.stated],
        allIso: [primary.iso],
        quote: primary.quote,
        support: "unverified",
        verifiedForDisplay: null,
        verification: null,
        conflicting: false,
      };
    }
  } else {
    const rawCandidatePresent = Boolean(comparable.issueDate || input.extraction?.issueDate?.trim());
    supportedIssue = {
      stated: null,
      iso: null,
      allStated: [],
      allIso: [],
      quote: null,
      support: rawCandidatePresent ? "unverified" : "missing",
      verifiedForDisplay: null,
      verification: null,
      conflicting: false,
    };
  }

  const verifiedIssue = supportedIssue.conflicting ? null : supportedIssue.verifiedForDisplay;

  // Gather candidate deadline tokens across both `by <DATE>` and structured payment/correspondence deadline lines.
  const candidateDeadlineTokens: string[] = [];
  const seenDeadlineIsos = new Set<string>();
  const pushDeadlineToken = (token: string, span: NoticeSentenceSpan | null) => {
    const clean = token.replace(/(\d{1,2})(?:st|nd|rd|th)\b/i, "$1").trim();
    const parsed = parseCalendarDate(clean);
    if (!parsed) {
      return;
    }
    if (verifiedIssue && parsed.iso === verifiedIssue) {
      const checkLine = span ? span.norm : comparable.deadlineQuote ?? "";
      if (!isDeadlineLine(checkLine) && extractPaymentDeadlineIso(checkLine) === null && extractCorrespondenceDeadlineIsos(checkLine).length === 0) {
        return;
      }
    }
    if (seenDeadlineIsos.has(parsed.iso)) {
      return;
    }
    seenDeadlineIsos.add(parsed.iso);
    candidateDeadlineTokens.push(clean);
  };

  for (const span of sentenceSpans) {
    const blocked = eligibility.decisions.some(
      (item) => item.evidence.sentenceIndex === span.sentenceIndex && item.reason === "model_directed"
    );
    if (blocked) {
      continue;
    }
    const role = paymentSentenceRole(span.raw);
    if (
      role === "conditional_fee" ||
      role === "conditional_obligation" ||
      role === "injected_command" ||
      role === "ambiguous" ||
      role === "historical_payment"
    ) {
      continue;
    }
    const payIso = extractPaymentDeadlineIso(span.raw);
    const corrIsos = extractCorrespondenceDeadlineIsos(span.raw);
    if (payIso === null && corrIsos.length === 0) {
      continue;
    }
    const owner = eligibility.decisions.find(
      (item) =>
        item.amount !== null &&
        item.evidence.sentenceIndex === span.sentenceIndex &&
        item.reason !== "conditional_fee" &&
        item.reason !== "waived_fee" &&
        item.reason !== "refunded_fee" &&
        item.reason !== "included_fee"
    );
    if (owner && owner.status !== "ELIGIBLE") {
      continue;
    }
    if (payIso !== null && resolvedBalances.length !== 1) {
      continue;
    }
    const dateMatches = [...span.norm.matchAll(new RegExp(DATE_TOKEN.source, "gi"))];
    for (const m of dateMatches) {
      const tok = m[1];
      if (!tok) {
        continue;
      }
      const iso = parseCalendarDate(tok)?.iso ?? null;
      if (iso && (iso === payIso || corrIsos.includes(iso))) {
        pushDeadlineToken(tok, span);
      }
    }
  }

  for (const token of comparable.responseDeadlines) {
    const normText = normalizeForRole(rawText);
    const at = normText.toLowerCase().indexOf(normalizeForRole(token).toLowerCase());
    const span =
      sentenceSpans.find((item) => normalizeForRole(item.raw).toLowerCase().includes(normalizeForRole(token).toLowerCase())) ??
      null;
    const sentence = span ? span.raw : at < 0 ? token : sentenceAt(rawText, at);
    if (!sentenceSupportsResponseDeadline(sentence, resolvedBalances)) {
      continue;
    }
    if (span) {
      const owner = eligibility.decisions.find(
        (item) => item.amount !== null && item.evidence.sentenceIndex === span.sentenceIndex
      );
      if (owner && owner.status !== "ELIGIBLE") {
        continue;
      }
    }
    pushDeadlineToken(token, span);
  }

  const deadlines = dateView(
    candidateDeadlineTokens,
    (stated) => {
      const span = sentenceSpans.find((item) =>
        normalizeForRole(item.raw).toLowerCase().includes(normalizeForRole(stated).toLowerCase())
      );
      if (span) {
        return span.raw;
      }
      const quoted = comparable.deadlineQuote;
      if (quoted && normalizeForRole(quoted).includes(normalizeForRole(stated))) {
        return quoted;
      }
      return stated;
    },
    rawText
  );

  const claimDeadlineIsos = [
    ...new Set(
      eligibility.decisions
        .filter(
          (item) =>
            item.status === "ELIGIBLE" &&
            item.amount !== null &&
            BALANCE_DECISION_REASONS.has(item.reason) &&
            item.deadlineSupported &&
            item.deadlineIso &&
            item.deadlineIso !== verifiedIssue
        )
        .map((item) => item.deadlineIso!)
    ),
  ];
  const corrDeadlineIsos = eligibility.correspondenceDeadlinesIso.filter(
    (iso) => iso !== verifiedIssue
  );
  const crossRoleDeadlineConflict =
    claimDeadlineIsos.length === 1 &&
    corrDeadlineIsos.length === 1 &&
    claimDeadlineIsos[0] !== corrDeadlineIsos[0];
  const anyDeadlineConflict =
    eligibility.paymentDeadlineConflict ||
    eligibility.correspondenceDeadlineConflict ||
    claimDeadlineIsos.length > 1 ||
    corrDeadlineIsos.length > 1 ||
    crossRoleDeadlineConflict;

  const targetDeadlineIso = anyDeadlineConflict
    ? null
    : claimDeadlineIsos[0] ?? corrDeadlineIsos[0] ?? null;

  const authoritativeDeadlines: GroundedDateView = anyDeadlineConflict
    ? {
        ...deadlines,
        stated: null,
        iso: null,
        conflicting: true,
        verifiedForDisplay: null,
        support: "ambiguous",
      }
    : targetDeadlineIso !== null
      ? {
          ...deadlines,
          iso: targetDeadlineIso,
          verifiedForDisplay: targetDeadlineIso,
          support: "supports_claim",
          conflicting: false,
          stated:
            deadlines.allStated.find((token) => parseCalendarDate(token)?.iso === targetDeadlineIso) ??
            deadlines.stated ??
            targetDeadlineIso,
        }
      : {
          ...deadlines,
          verifiedForDisplay: null,
          conflicting: false,
          support: deadlines.allStated.length > 0 ? "unverified" : "missing",
        };

  const periodPhrase = comparable.billingPeriod;
  const periodQuote = comparable.billingPeriodQuote;
  const periodFact = groundBillingPeriod(rawText, periodPhrase, periodQuote);
  const periodBlockedByInjection =
    hasValidSourceOffsets(periodFact.verification, rawText.length) &&
    eligibility.decisions.some(
      (item) =>
        item.reason === "model_directed" &&
        item.evidence.start < periodFact.verification!.endOffset! &&
        periodFact.verification!.startOffset! < item.evidence.end
    );
  const effectivePeriodSupport: ClaimSupport = periodBlockedByInjection ? "unverified" : periodFact.support;
  const effectivePeriodVerified = periodBlockedByInjection ? null : periodFact.verifiedForDisplay;
  const issueForGap = supportedIssue.verifiedForDisplay ?? supportedIssue.stated;
  const amount = amountView(classifyAmounts(rawText, sentenceSpans, eligibility), resolvedBalances);

  return deepFreeze({
    rawText,
    noticeCategory,
    categoryDecision,
    issueDate: { ...supportedIssue, assessment: assessIssueDate(supportedIssue.stated, input.today) },
    amount,
    billingPeriod: {
      stated: effectivePeriodSupport === "supports_claim" ? effectivePeriodVerified : periodPhrase,
      quote: periodQuote,
      support: effectivePeriodSupport,
      verifiedForDisplay: effectivePeriodVerified,
      verification: periodFact.verification,
      gap: assessBillingPeriodGap(
        effectivePeriodSupport === "supports_claim" ? effectivePeriodVerified : null,
        issueForGap
      ),
    },
    responseDeadlines: {
      ...authoritativeDeadlines,
      assessment: assessDeadlines(
        authoritativeDeadlines.conflicting
          ? authoritativeDeadlines.allStated
          : authoritativeDeadlines.verifiedForDisplay
            ? [authoritativeDeadlines.stated ?? authoritativeDeadlines.verifiedForDisplay]
            : authoritativeDeadlines.allStated,
        input.today
      ),
    },
    obligations: obligationViews(rawText, comparable, eligibility, verifiedIssue, input.extraction),
    comparable,
    eligibility,
  });
}

function briefDate(view: GroundedDateView): string | null {
  if (view.conflicting) {
    return null;
  }
  return view.support === "supports_claim" ? view.quote ?? view.stated : null;
}

/**
 * Brief fields are limited to facts the source passage supports.
 * Issue dates are not copied into response deadlines. Conditional fees are omitted.
 */
export function briefSourceFromGrounded(view: GroundedNoticeViewModel): BriefSource {
  const verifiedAmt = displayVerifiedAmount(view);
  const verifiedIssue = displayVerifiedIssueDate(view);
  const verifiedDeadline = verifiedResponseDeadlineIso(view);
  const obligations: BriefSourceObligation[] = view.obligations
    .filter((item) => isObligationVerifiedForCloud(view, item))
    .map((item) => ({
      action: actionSummaryLabel(item.actionSummary),
      dueDate: item.dueDate,
      sourceQuote: item.sourceQuote,
    }));
  const deadlineQuotes = view.responseDeadlines.conflicting
    ? view.responseDeadlines.allStated
    : verifiedDeadline && briefDate(view.responseDeadlines)
      ? [briefDate(view.responseDeadlines)!]
      : [];
  return {
    noticeCategory: view.noticeCategory,
    issueDate: verifiedIssue ? briefDate(view.issueDate) : null,
    billingPeriod:
      view.billingPeriod.support === "supports_claim" ? view.billingPeriod.verifiedForDisplay : null,
    amountGBP: verifiedAmt,
    amountsGBP: view.amount.conflict ? view.amount.amountsGBP : verifiedAmt === null ? [] : [verifiedAmt],
    responseDeadline: view.responseDeadlines.conflicting ? null : deadlineQuotes[0] ?? null,
    responseDeadlines: view.responseDeadlines.conflicting ? view.responseDeadlines.allStated : deadlineQuotes,
    obligations,
  };
}

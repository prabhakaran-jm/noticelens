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
import {
  actionSummaryFromQuote,
  groundBillingPeriod,
  groundCalendarDate,
  groundMonetaryAmount,
  groundObligation,
  paymentQuoteUndermined,
  paymentSentenceRole,
  resolvedCurrentBalanceAmounts,
  sentenceSupportsResponseDeadline,
  type ClaimSupport,
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
  let start = 0;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const char = text[cursor];
    if (char === "\n" || char === "." || char === "!" || char === "?") {
      start = cursor + 1;
      break;
    }
  }
  let end = text.length;
  for (let cursor = index; cursor < text.length; cursor += 1) {
    const char = text[cursor];
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

function classifyAmounts(text: string): ClassifiedAmount[] {
  return findExplicitGbpAmounts(text).amounts.map((amount) => {
    const sentence = sentenceAt(text, amount.index) || lineAt(text, amount.index);
    const role = isConditionalFee(sentence, amount.raw)
      ? "conditional_fee"
      : isBalanceSentence(sentence, amount.raw)
        ? "balance"
        : "other";
    const fact = groundMonetaryAmount(text, amount.value, sentence);
    return {
      value: amount.value,
      raw: amount.raw,
      quote: sentence,
      role,
      support: fact.support,
      verifiedForDisplay: fact.verifiedForDisplay,
      verification: fact.verification,
    };
  });
}

function amountView(classified: ClassifiedAmount[], resolved: readonly number[]): GroundedAmountView {
  const conflictCandidates = resolved.length > 1;
  const allowed = new Set(conflictCandidates ? [] : resolved);
  const adjusted = classified.map((item) => {
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
        : "unverified";
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

function claimIdentity(action: string, actionSummary: string, quote: string): string {
  const basis = `${actionSummary}\u001f${action.trim()}\u001f${quote.trim()}`;
  let hash = 2166136261;
  for (let index = 0; index < basis.length; index += 1) {
    hash ^= basis.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `claim-${(hash >>> 0).toString(16).padStart(8, "0")}`;
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
  const resolved = resolvedCurrentBalanceAmounts(text);
  return seeded.map((item) => {
    const fact = groundObligation(text, item.action, item.sourceQuote);
    const claimExceedsQuote = actionClaimsUnsupportedDetail(item.action, item.sourceQuote);
    const support =
      claimExceedsQuote && fact.support === "supports_claim" ? "substring_only" : fact.support;
    const actionSummary = fact.value ?? actionSummaryFromQuote(item.sourceQuote);
    const quoteHeading = headingSupportFor(support, item.sourceQuote);
    const headingSupport =
      paymentQuoteUndermined(item.sourceQuote, actionSummary, resolved) && quoteHeading === "supports_claim"
        ? "substring_only"
        : quoteHeading;
    const quotedDate = soleDateToken(item.sourceQuote);
    const dueInQuote =
      item.dueDate !== null &&
      calendarIsoDates(item.sourceQuote).includes(parseCalendarDate(item.dueDate)?.iso ?? "");
    return {
      id: claimIdentity(item.action, actionSummary, item.sourceQuote),
      action: item.action,
      actionSummary,
      modelActionSupported: quoteSupportsEntireAction(item.action, item.sourceQuote),
      dueDate: dueInQuote ? item.dueDate : quotedDate,
      sourceQuote: item.sourceQuote,
      support,
      headingSupport,
      verifiedForDisplay: headingSupport === "supports_claim" ? actionSummary : null,
      verification: fact.verification,
      claimExceedsQuote,
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
    return {
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
    };
  }

  const issueQuote = comparable.issueDateQuote
    ? lineAt(rawText, rawText.indexOf(comparable.issueDateQuote))
    : null;
  const resolvedBalances = resolvedCurrentBalanceAmounts(rawText);
  const issue = dateView(
    comparable.issueDate ? [comparable.issueDate] : [],
    () => issueQuote,
    rawText
  );
  const issueSentence = comparable.issueDate
    ? sentenceAt(rawText, Math.max(rawText.toLowerCase().indexOf(comparable.issueDate.toLowerCase()), 0))
    : "";
  const issueRole = paymentSentenceRole(issueSentence);
  const supportedIssue =
    issue.support === "supports_claim" &&
    !appearsOnlyAsByDate(rawText, comparable.issueDate) &&
    issueRole !== "conditional_fee" &&
    issueRole !== "injected_command"
      ? issue
      : {
          ...issue,
          support: issue.support === "missing" ? ("missing" as const) : ("unverified" as const),
          verifiedForDisplay: null,
        };

  const deadlineStated = comparable.responseDeadlines.filter((token) => {
    const iso = parseCalendarDate(token)?.iso ?? null;
    if (iso && issue.verifiedForDisplay === iso && !comparable.deadlineConflict) {
      const quote = comparable.deadlineQuote ?? "";
      if (!isDeadlineLine(quote) && quote === comparable.issueDateQuote) {
        return false;
      }
    }
    return true;
  });
  const supportedDeadlineStated = deadlineStated.filter((token) => {
    const at = rawText.toLowerCase().indexOf(token.toLowerCase());
    const sentence = at < 0 ? token : sentenceAt(rawText, at);
    return sentenceSupportsResponseDeadline(sentence, resolvedBalances);
  });
  const deadlines = dateView(
    supportedDeadlineStated,
    (stated) => {
      const quoted = comparable.deadlineQuote;
      if (quoted && quoted.includes(stated)) {
        return quoted;
      }
      const line = rawText
        .split(/\n/)
        .map((item) => item.trim())
        .find((item) => item.includes(stated) && isDeadlineLine(item));
      return line ?? stated;
    },
    rawText
  );

  const periodPhrase = comparable.billingPeriod;
  const periodQuote = comparable.billingPeriodQuote;
  const periodFact = groundBillingPeriod(rawText, periodPhrase, periodQuote);
  const issueForGap = supportedIssue.verifiedForDisplay ?? supportedIssue.stated;
  const amount = amountView(classifyAmounts(rawText), resolvedBalances);

  return {
    rawText,
    noticeCategory,
    categoryDecision,
    issueDate: { ...supportedIssue, assessment: assessIssueDate(supportedIssue.stated, input.today) },
    amount,
    billingPeriod: {
      stated: periodFact.support === "supports_claim" ? periodFact.verifiedForDisplay : periodPhrase,
      quote: periodQuote,
      support: periodFact.support,
      verifiedForDisplay: periodFact.verifiedForDisplay,
      verification: periodFact.verification,
      gap: assessBillingPeriodGap(
        periodFact.support === "supports_claim" ? periodFact.verifiedForDisplay : null,
        issueForGap
      ),
    },
    responseDeadlines: {
      ...deadlines,
      assessment: assessDeadlines(
        deadlines.conflicting ? deadlines.allStated : deadlines.verifiedForDisplay ? [deadlines.verifiedForDisplay] : deadlines.allStated,
        input.today
      ),
    },
    obligations: obligationViews(rawText, comparable, input.extraction),
    comparable,
  };
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
  const obligations: BriefSourceObligation[] = view.obligations
    .filter((item) => item.headingSupport === "supports_claim")
    .map((item) => ({
      action: actionSummaryLabel(item.actionSummary),
      dueDate: item.dueDate,
      sourceQuote: item.sourceQuote,
    }));
  const deadlineQuotes = view.responseDeadlines.conflicting
    ? view.responseDeadlines.allStated
    : briefDate(view.responseDeadlines)
      ? [briefDate(view.responseDeadlines)!]
      : [];
  return {
    noticeCategory: view.noticeCategory,
    issueDate: briefDate(view.issueDate),
    billingPeriod:
      view.billingPeriod.support === "supports_claim" ? view.billingPeriod.verifiedForDisplay : null,
    amountGBP: view.amount.verifiedForDisplay,
    amountsGBP: view.amount.conflict ? view.amount.amountsGBP : view.amount.verifiedForDisplay === null ? [] : [view.amount.verifiedForDisplay],
    responseDeadline: view.responseDeadlines.conflicting ? null : deadlineQuotes[0] ?? null,
    responseDeadlines: view.responseDeadlines.conflicting ? view.responseDeadlines.allStated : deadlineQuotes,
    obligations,
  };
}

import {
  distinctAmountValues,
  findExplicitGbpAmounts,
  type SourcedAmount,
} from "./amounts";
import { parseBillingWindow, parseCalendarDate } from "./dates";
import type { ActionSummaryId, QuoteVerificationResult } from "./types";
import type { EligibilityDecision, NoticeEligibility } from "./eligibility";
import {
  genericDateRowIsNotIssueDate,
  independentClaimLabel,
  instructionOwnsSelectedBalance,
  introducesHistoricalCopy,
  isCompletedDisposition,
  isContingentBalanceStatement,
  isModelOrParserDirected,
} from "./supportedNoticePolicy";
import { sentenceDisposesCurrentClaim, sentenceHasUnresolvedContext } from "./claimContext";
import { introducesParagraphFrame, introducesUntrustedFrame, matchesSupportedBalanceStructure } from "./supportedStructures";
import { noticeExceedsSupportedSize } from "./noticeInputLimit";
import { verifyQuoteInSource } from "./verifyQuotes";

export type ClaimSupport =
  | "supports_claim"
  | "substring_only"
  | "insufficient"
  | "ambiguous"
  | "incomplete"
  | "missing"
  | "unverified";

export interface GroundedFact<T> {
  value: T | null;
  quote: string | null;
  /** True only when the quotation occurs in the source. This is not claim support. */
  substringExists: boolean;
  support: ClaimSupport;
  /** Value when support is supports_claim. Otherwise null so a display cannot treat it as verified. */
  verifiedForDisplay: T | null;
  verification: QuoteVerificationResult | null;
}

const MONTH_WORD =
  "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";

function grounded<T>(
  value: T | null,
  quote: string | null,
  support: ClaimSupport,
  verification: QuoteVerificationResult | null
): GroundedFact<T> {
  return {
    value,
    quote,
    substringExists: verification?.verified === true,
    support,
    verifiedForDisplay: support === "supports_claim" ? value : null,
    verification,
  };
}

function quotationProblem(
  quote: string | null,
  verification: QuoteVerificationResult | null
): ClaimSupport | null {
  if (quote === null || quote.trim().length === 0) {
    return "missing";
  }
  if (/\.{3}|…|\u2026/.test(quote)) {
    return "incomplete";
  }
  if (!verification?.verified) {
    return "unverified";
  }
  if (quote.replace(/\s+/g, "").length < 12) {
    return "insufficient";
  }
  return null;
}

function amountValuesIn(text: string): number[] {
  return distinctAmountValues(findExplicitGbpAmounts(text).amounts);
}

export function groundMonetaryAmount(
  source: string,
  amount: number | null,
  quote: string | null
): GroundedFact<number> {
  const verification = quote ? verifyQuoteInSource(source, quote) : null;
  const problem = quotationProblem(quote, verification);
  if (amount === null) {
    return grounded<number>(
      null,
      quote,
      problem === "incomplete" ? "incomplete" : "missing",
      verification
    );
  }
  if (problem) {
    return grounded(amount, quote, problem, verification);
  }
  const amounts = amountValuesIn(quote ?? "");
  const matchesClaim = amounts.some((value) => Math.abs(value - amount) < 0.001);
  if (!matchesClaim) {
    return grounded(amount, quote, "substring_only", verification);
  }
  if (amounts.length > 1) {
    return grounded(amount, quote, "ambiguous", verification);
  }
  if (
    quotedStatementOnly(source, quote ?? "") ||
    claimedAmountOnlyInsideQuotes(source, quote ?? "", amount)
  ) {
    return grounded(amount, quote, "substring_only", verification);
  }
  if (quoteTruncatesSentence(source, quote ?? "")) {
    return grounded(amount, quote, "incomplete", verification);
  }
  const role = paymentSentenceRole(quote ?? "");
  if (role === "injected_command") {
    return grounded(amount, quote, "unverified", verification);
  }
  if (role === "ambiguous") {
    return grounded(amount, quote, "ambiguous", verification);
  }
  if (role === "conditional_fee" || role === "current_balance" || role === "reinstated_demand") {
    return grounded(amount, quote, "supports_claim", verification);
  }
  if (role !== "unsupported") {
    return grounded(amount, quote, "substring_only", verification);
  }
  const disposition = obligationDisposition(quote ?? "");
  if (disposition) {
    return grounded(amount, quote, disposition, verification);
  }
  // The figure occurs in this quotation. Whether it is the current balance is
  // decided from the whole notice, not from the currency token alone.
  return grounded(amount, quote, "supports_claim", verification);
}

function indexInsideQuotes(text: string, index: number): boolean {
  let doubleQuote = false;
  let curlyQuote = false;
  for (let cursor = 0; cursor < index && cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (char === '"' && !curlyQuote) {
      doubleQuote = !doubleQuote;
    } else if (char === "\u201C" && !doubleQuote) {
      curlyQuote = true;
    } else if (char === "\u201D" && curlyQuote) {
      curlyQuote = false;
    }
  }
  return doubleQuote || curlyQuote;
}

function outsideQuotes(quote: string): string {
  return quote.replace(/"[^"]*"|“[^”]*”/g, " ");
}

function quotedStatementOnly(source: string, quote: string): boolean {
  const needle = quote.trim();
  if (needle.length < 12) {
    return false;
  }
  let from = 0;
  let found = false;
  while (from < source.length) {
    const at = source.indexOf(needle, from);
    if (at < 0) {
      break;
    }
    found = true;
    if (!indexInsideQuotes(source, at)) {
      return false;
    }
    from = at + Math.max(needle.length, 1);
  }
  return found;
}

function claimedAmountOnlyInsideQuotes(source: string, quote: string, amount: number): boolean {
  const needle = quote.trim();
  if (!needle) {
    return false;
  }
  const pattern = /£\s?[\d,]+(?:\.\d{1,2})?/g;
  let from = 0;
  let saw = false;
  while (from < source.length) {
    const at = source.indexOf(needle, from);
    if (at < 0) {
      break;
    }
    let localSaw = false;
    for (const match of needle.matchAll(pattern)) {
      const values = amountValuesIn(match[0]);
      if (!values.some((value) => Math.abs(value - amount) < 0.001)) {
        continue;
      }
      localSaw = true;
      saw = true;
      if (!indexInsideQuotes(source, at + (match.index ?? 0))) {
        return false;
      }
    }
    if (!localSaw) {
      return false;
    }
    from = at + Math.max(needle.length, 1);
  }
  return saw;
}

export function normalizeForRole(raw: string): string {
  return raw
    .replace(/\p{Cf}/gu, "")
    .replace(/[\u2018\u2019\u02BC\uFF07]/g, "'")
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-")
    .replace(/[\u00A0\t\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .normalize("NFC");
}

function figureContextNegated(quote: string): boolean {
  const s = normalizeForRole(quote);
  return (
    /\b(?:not|no longer|never)\s+(?:due|owed|payable)\b/i.test(s) ||
    /£[\d,]+(?:\.\d+)?\s+is\s+not\b/i.test(s) ||
    /\b(?:balance|amount|fee)\s+is\s+not\b/i.test(s)
  );
}

const PASSIVE_AUX =
  "(?:has|have|had|is|are|was|were)(?:\\s+(?:now|already|since|hereby|officially|formally))?(?:\\s+been)?";

function explicitlyCancelled(quote: string): boolean {
  const s = normalizeForRole(quote);
  if (deniesCancellation(s)) {
    return false;
  }
  const hasTarget =
    /\b(?:bill|charge|demand|balance|debt|notice|statement|invoice|account|amount|payment|request)\b/i.test(s) ||
    amountValuesIn(s).length > 0;
  return (
    new RegExp(`\\b${PASSIVE_AUX}\\s+(?:cancell?ed|rescinded|revoked|annulled)\\b`, "i").test(s) ||
    /\bcancell?ed\s+(?:demand|notice|balance|payment|debt|request|charge|amount|bill|letter|statement|invoice)\b/i.test(
      s
    ) ||
    ((/\bcancell/i.test(s) || /\brescinded\b/i.test(s)) && hasTarget) ||
    /\bsupersed(?:e|ed|es)\b/i.test(s)
  );
}

function explicitlyWithdrawn(quote: string): boolean {
  const s = normalizeForRole(quote);
  if (/\bmay\s+be\s+withdrawn\b/i.test(s)) {
    return false;
  }
  if (new RegExp(`\\b${PASSIVE_AUX}\\s+(?:withdrawn|retracted)\\b`, "i").test(s)) {
    return true;
  }
  return /\b(?:payment\s+request|demand|bill|notice|charge|letter)\b[^.]{0,80}\bwithdrawn\b/i.test(s);
}

function explicitlyNegated(quote: string): boolean {
  const s = normalizeForRole(quote);
  return (
    figureContextNegated(s) ||
    /\bdo\s+not\s+need\s+to\s+pay\b/i.test(s) ||
    /\b(?:do(?:\s+not|n't)|will\s+not|won't|are\s+not|aren't|is\s+not|isn't|no\s+longer|never)\s+(?:have\s+to|need\s+to|required\s+to|obliged\s+to|obligated\s+to|liable\s+to|expected\s+to)\s+pay\b/i.test(
      s
    ) ||
    /\bwon't\s+need\s+to\s+pay\b/i.test(s) ||
    /\bowe(?:\s+us)?\s+nothing\b/i.test(s) ||
    /\b(?:don't|do\s+not)\s+owe\b/i.test(s) ||
    /\bnothing\s+to\s+pay\b/i.test(s) ||
    /\bdo\s+not\s+need\s+to\s+contact\b/i.test(s) ||
    /\bpay\s+nothing\b/i.test(s)
  );
}

function historicalPayment(quote: string): boolean {
  const s = normalizeForRole(quote);
  return (
    /\balready\s+paid\b/i.test(s) ||
    /\balready\s+received\b/i.test(s) ||
    /\bthank\s+you\s+for\s+(?:your\s+)?payment\b/i.test(s) ||
    /\b(?:we|our records)\s+(?:have\s+)?received\s+(?:your\s+)?payment\b/i.test(s) ||
    /\bpayment\b[^.]{0,48}\b(?:was|were|has been|have been)\s+received\b/i.test(s)
  );
}

export type PaymentSentenceRole =
  | "current_balance"
  | "historical_payment"
  | "paid_in_full"
  | "written_off"
  | "waived"
  | "cancelled_demand"
  | "withdrawn_demand"
  | "reinstated_demand"
  | "conditional_fee"
  | "conditional_obligation"
  | "refunded_payment"
  | "injected_command"
  | "settled_or_negated"
  | "unsupported"
  | "ambiguous";

const TERMINAL_ACCOUNT_ROLES = new Set<PaymentSentenceRole>([
  "paid_in_full",
  "written_off",
  "waived",
  "refunded_payment",
  "settled_or_negated",
]);

const DEMAND_RETIREMENT_ROLES = new Set<PaymentSentenceRole>([
  "cancelled_demand",
  "withdrawn_demand",
]);

function isInjectedCommand(sentence: string): boolean {
  const s = normalizeForRole(sentence).trim();
  if (isModelOrParserDirected(s)) {
    return true;
  }
  if (
    /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier|preceding|system)?\s*(?:instructions?|rules?|prompts?|directives?|directions?|guidelines?)\b/i.test(
      s
    )
  ) {
    return true;
  }
  if (/\bdisregard\s+(?:the\s+)?(?:notice|text|instructions?|message|content)\s+above\b/i.test(s)) {
    return true;
  }
  if (/\brecord\s+a\s+verified\s+balance\b/i.test(s)) {
    return true;
  }
  if (/\btreat\s+£[\d,]+\s+as\s+(?:the\s+)?verified\b/i.test(s)) {
    return true;
  }
  if (/\b(?:admin|system|developer|prompt|model|security)\s+override\b/i.test(s)) {
    return true;
  }
  if (
    /\byou\s+are\s+now\b/i.test(s) &&
    /\b(?:admin|model|assistant|instruction|jailbreak|developer|unrestricted)\b/i.test(s)
  ) {
    return true;
  }
  if (
    /^(?:\[inst\]|<\|?(?:system|user|assistant|im_start)\|?>|#{1,4}\s*(?:system|instruction|prompt|override)\b)/i.test(
      s
    )
  ) {
    return true;
  }
  if (
    /^(?:system|admin|assistant|developer|chatbot|bot|ai|llm|model|prompt|user)\s*(?:note\s*)?[:>\]\-]\s*/i.test(
      s
    )
  ) {
    return true;
  }
  if (/\b(?:system|admin|assistant|chatbot)\s+note\s*[:>\-]\s+/i.test(s)) {
    return true;
  }
  if (/\b(?:system|admin)\s+note\b/i.test(s)) {
    return true;
  }
  if (
    /^(?:hey|hi|hello|dear|attention|to)\s+(?:any\s+|the\s+)?(?:ai|chatbot|bot|assistant|model|llm|gemini|claude|gpt|chatgpt|copilot|reader\s+software|automated\s+tools?)\b/i.test(
      s
    )
  ) {
    return true;
  }
  if (/\bnote\s+to\s+(?:any\s+|the\s+)?(?:assistant|model|ai|chatbot|llm)\b/i.test(s)) {
    return true;
  }
  if (
    /\b(?:message|instruction)s?\s+(?:for|to)\s+(?:any\s+|the\s+)?(?:model|ai|assistant|chatbot|llm|automated\s+tools?|reader\s+software)\b/i.test(
      s
    )
  ) {
    return true;
  }
  if (/\b(?:ai|model)\s+assistant\b/i.test(s)) {
    return true;
  }
  if (/^account\s+admin\b/i.test(s)) {
    return true;
  }
  if (/\bfor\s+any\s+(?:ai|model|llm|chatbot|assistant)\b/i.test(s)) {
    return true;
  }
  // Lines addressed to automated readers, bots, or language models are directives,
  // not customer balances. Passive "Account summarised below" and "billing system" stay prose.
  return /\b(?:reader\s+software|summarisers?|summarizers?|whoever\s+summaris\w*|whoever\s+summariz\w*|(?:any|the|to)\s+summaris\w*|(?:any|the|to)\s+summariz\w*|automated\s+tools?|language\s+models?|llms?|chatbots?)\b/i.test(
    s
  );
}

function isConditionalFeeSentence(sentence: string): boolean {
  const s = normalizeForRole(sentence);
  if (!/\b(?:fee|surcharge|penalty)\b/i.test(s)) {
    return false;
  }
  if (
    /\b(?:outstanding\s+balance|total\s+to\s+pay|balance\s+due)\b/i.test(s) &&
    /\b(?:includes?|including)\b/i.test(s)
  ) {
    return false;
  }
  if (/\bquestions?\b/i.test(s) && !/\b(?:may|might|could)\s+(?:apply|be)\b/i.test(s)) {
    return false;
  }
  return (
    /\b(?:if|unless|may|might|could)\b/i.test(s) ||
    /\bwill\s+be\s+(?:charged|added|applied)\b/i.test(s) ||
    /\b(?:late|administration)\s+(?:payment\s+)?fee\b/i.test(s)
  );
}

function isConditionalObligation(sentence: string): boolean {
  const s = normalizeForRole(sentence);
  if (isContingentBalanceStatement(s)) {
    return true;
  }
  if (/\bmay\s+be\s+withdrawn\b/i.test(s)) {
    return false;
  }
  const hasAmount = amountValuesIn(s).length > 0;
  if (/^(?:should|assuming|were|had|supposing)\b/i.test(s) && hasAmount) {
    return true;
  }
  if (
    /\b(?:depending\s+on|in\s+case|on\s+condition(?:\s+that)?|subject\s+to|assuming(?:\s+that)?|supposing(?:\s+that)?)\b/i.test(
      s
    ) &&
    hasAmount
  ) {
    return true;
  }
  if (/\bwould\s+have\s+been\b/i.test(s) && hasAmount) {
    return true;
  }
  if (/\bcould\s+reach\b/i.test(s)) {
    return true;
  }
  if (/\bshould\s+(?:your|the|a|an|this|that|it|our|we|you)\b/i.test(s) && hasAmount) {
    return true;
  }
  if (/\bwhere\s+(?:your|the|a|an)\b/i.test(s) && hasAmount) {
    return true;
  }
  if (/\bonce\s+(?:your|the|a|an)\b/i.test(s) && hasAmount) {
    return true;
  }
  if (/\bonly\s+(?:if|after|once|when|where)\b/i.test(s)) {
    return true;
  }
  if (/\b(?:pending|provided|providing|unless)\b/i.test(s) && hasAmount) {
    return true;
  }
  if (/\bin\s+the\s+event\b/i.test(s)) {
    return true;
  }
  if (/\b(?:would|will)\s+(?:be|become|arise)\b/i.test(s) && hasAmount) {
    return true;
  }
  if (/\bmay\s+be\s+payable\b/i.test(s)) {
    return true;
  }
  if (/\bwould\s+be\s+due\b/i.test(s)) {
    return true;
  }
  if (/\bsubject\s+to\s+(?:confirmation|verification)\b/i.test(s)) {
    return true;
  }
  if (/\bshould\s+the\b/i.test(s) && /\b(?:confirmed|due)\b/i.test(s)) {
    return true;
  }
  if (
    /\bif\b/i.test(s) &&
    hasAmount &&
    !/\bif\s+you\s+(?:think|believe|have\s+(?:any\s+)?questions|wish|want|need\s+help)\b/i.test(s)
  ) {
    return true;
  }
  return /\bmust\s+pay\b/i.test(s) && /\bif\b/i.test(s);
}

function deniesCancellation(sentence: string): boolean {
  return /\bnot\s+a\s+cancellation\b/i.test(normalizeForRole(sentence));
}

function quotedDemandContradiction(sentence: string): boolean {
  const quotes = sentence.match(/"[^"]*"|“[^”]*”/g) ?? [];
  return quotes.some((quoted) => {
    const role = detectBlockingRole(quoted);
    return role !== null && role !== "historical_payment";
  });
}

function isNegativeReinstatement(sentence: string): boolean {
  const s = normalizeForRole(sentence);
  return (
    /\b(?:not|never|no|none|neither|won't|will\s+not)\b[\s\S]{0,48}\breinstat/i.test(s) ||
    /\bagainst\s+reinstat/i.test(s)
  );
}

function isReinstatement(sentence: string): boolean {
  const s = normalizeForRole(sentence);
  if (isNegativeReinstatement(s)) {
    return false;
  }
  if (/\b(?:no|nothing)(?:\s+\w+){0,3}\s+remains\s+payable\b/i.test(s)) {
    return false;
  }
  return (
    /\b(?:has|have|is|are|was|were)\b(?:\s+\w+){0,4}\s+reinstated\b/i.test(s) ||
    /\bdisregard\s+the\s+cancellation\b/i.test(s)
  );
}

function closesObligation(sentence: string): boolean {
  const s = normalizeForRole(sentence);
  if (deniesCancellation(s)) {
    return false;
  }
  const target = /\b(?:balance|bill|charge|debt|amount|payment|demand|account|sum|request|invoice|claim)\b/i;
  const hasTarget = target.test(s) || amountValuesIn(s).length > 0;
  if (/\b(?:void(?:ed)?|dropp(?:ed|ing)|abandon(?:ed)?|forgiv(?:en)?)\b/i.test(s) && hasTarget) {
    return true;
  }
  if (/\bwrit(?:e|ten|ing)\b[\s\S]{0,40}\boff\b/i.test(s) && hasTarget) {
    return true;
  }
  if (/\b(?:revers(?:e|ed|ing)|credit(?:ed)?)\b/i.test(s) && hasTarget) {
    return true;
  }
  if (/\bcancell?ing\b/i.test(s) && hasTarget) {
    return true;
  }
  if (/\bno\s+longer\s+liable\b/i.test(s)) {
    return true;
  }
  if (/\bnothing\s+more\b[\s\S]{0,40}\bpay\b/i.test(s)) {
    return true;
  }
  if (/\b(?:don't|do\s+not)\s+owe\b/i.test(s)) {
    return true;
  }
  if (/\b(?:won't|will\s+not|needn't|need\s+not)\b[\s\S]{0,24}\bpay\b/i.test(s)) {
    return true;
  }
  return /\b(?:will\s+not|won't)\s+be\s+pursuing\b/i.test(s);
}

function isStructuralSettlement(sentence: string): boolean {
  const s = normalizeForRole(sentence);
  const paymentNoun = /\b(?:balance|amount|charge|payment|debt|sum|account|demand|request|bill|invoice|claim)\b/i;
  const hasTarget = paymentNoun.test(s) || amountValuesIn(s).length > 0;
  const completed =
    (/\b(?:cleared|discharged|extinguished|settled|paid\s+off|completed)\b/i.test(s) && hasTarget) ||
    /\bsettlement\s+of\b/i.test(s);
  const dutyNegated =
    /\b(?:need\s+not\s+pay|needn't\s+pay|(?:do(?:\s+not|n't)|will\s+not|won't|are\s+not|aren't|is\s+not|isn't|no\s+longer|never)\s+(?:have\s+to|need\s+to|required\s+to|obliged\s+to|obligated\s+to|liable\s+to|expected\s+to)\s+pay|must\s+pay\s+nothing|(?:no|nothing)(?:\s+\w+){0,3}\s+remains\s+payable|no\s+(?:payment|amount|balance|charge|sum)\s+(?:is\s+)?(?:due|payable|owed|required|needed|outstanding)|no\s+payment\s+to\s+make|nothing\s+to\s+pay|no\s+longer\s+required|pay\s+nothing|owe(?:\s+us)?\s+nothing)\b/i.test(
      s
    );
  const disregard =
    /\b(?:disregard|ignore)\b/i.test(s) &&
    /\b(?:balance|demand|request|pay|figure|amount)\b/i.test(s) &&
    !/\bdisregard\s+the\s+cancellation\b/i.test(s);
  const closed =
    /\bas\s+closed\b/i.test(s) ||
    (/\bis\s+closed\b/i.test(s) && hasTarget) ||
    (/\bnow\s+clear\b/i.test(s) && hasTarget) ||
    /\bno\s+balance\s+of\b/i.test(s) ||
    /\bbalance\s+is\s+now\s+zero\b/i.test(s) ||
    /\bnow\s+zero\b/i.test(s) ||
    /\bcredited\s+back\b/i.test(s) ||
    (/\bsent\s+in\s+error\b/i.test(s) && !/\bif\b/i.test(s)) ||
    /\bissued\s+by\s+mistake\b/i.test(s) ||
    /\bnot\s+to\s+charge\b/i.test(s) ||
    /\babsorbed\s+this\s+amount\b/i.test(s) ||
    closesObligation(s);
  return completed || dutyNegated || disregard || closed || isCompletedDisposition(s);
}

function isPositiveCurrentBalance(sentence: string): boolean {
  const s = normalizeForRole(sentence);
  if (
    /\b(?:no|not|never)\s+(?:outstanding\s+)?(?:balance|amount|payment|sum|total)\b/i.test(s) ||
    /\bno\s+longer\b/i.test(s)
  ) {
    return false;
  }
  if (/\bbalance\s+was\b/i.test(s) || /\bwas\s+£/i.test(s)) {
    return false;
  }
  if (/\bowe(?:\s+us)?\s+nothing\b/i.test(s)) {
    return false;
  }
  if (sentenceHasUnresolvedContext(s)) {
    return false;
  }
  return matchesSupportedBalanceStructure(s);
}

function detectBlockingRole(sentence: string): PaymentSentenceRole | null {
  const s = normalizeForRole(sentence);
  if (/\bprevious\s+balance\b/i.test(s)) {
    return "historical_payment";
  }
  if (historicalPayment(s)) {
    return "historical_payment";
  }
  if (
    !deniesCancellation(s) &&
    (explicitlyCancelled(s) ||
      /\bcancel(?:s|led|lation)?\s+(?:of\s+)?(?:this|the|that)\s+(?:demand|charge|balance|bill|notice)\b/i.test(s) ||
      /\bwe(?:'ve|\s+have)\s+cancell?ed\s+it\b/i.test(s) ||
      /\bcancell?ed\s+this\s+demand\b/i.test(s) ||
      /\bsupersed(?:e|ed|es)\b/i.test(s))
  ) {
    return "cancelled_demand";
  }
  if (explicitlyWithdrawn(s) || /\bdemand\s+is\s+withdrawn\b/i.test(s)) {
    return "withdrawn_demand";
  }
  if (/\bprevious\s+(?:bill|statement|invoice|demand|charge)\b/i.test(s)) {
    return "historical_payment";
  }
  if (/\bpaid\s+in\s+full\b/i.test(s)) {
    return "paid_in_full";
  }
  if (/\bwritten\s+off\b/i.test(s)) {
    return "written_off";
  }
  if (/\bwaiv(?:e|ed|er)\b/i.test(s)) {
    return "waived";
  }
  if (/\brefunded\b/i.test(s)) {
    return "refunded_payment";
  }
  if (isStructuralSettlement(s) || explicitlyNegated(s) || settledPayment(s)) {
    return "settled_or_negated";
  }
  return null;
}

function withoutModelAsides(sentence: string): string {
  return sentence.replace(/\([^)]*\b(?:assistant|system|admin|model|ai)\b[^)]*\)/gi, " ");
}

export function paymentSentenceRole(sentence: string): PaymentSentenceRole {
  const text = normalizeForRole(withoutModelAsides(sentence)).replace(/\s+/g, " ").trim();
  if (!text) {
    return "unsupported";
  }
  if (isInjectedCommand(text)) {
    return "injected_command";
  }
  const outside = outsideQuotes(text).replace(/\s+/g, " ").trim();
  if (!outside) {
    return "unsupported";
  }
  if (/\b(?:fee|surcharge|penalty)\b/i.test(outside) && /\bwaiv/i.test(outside)) {
    return "waived";
  }
  if (/\b(?:fee|surcharge|penalty)\b/i.test(outside) && /\brefund/i.test(outside)) {
    return "refunded_payment";
  }
  if (isConditionalFeeSentence(outside)) {
    return "conditional_fee";
  }
  if (isConditionalObligation(outside)) {
    return "conditional_obligation";
  }
  if (isNegativeReinstatement(outside)) {
    return "settled_or_negated";
  }
  if (isReinstatement(outside)) {
    return "reinstated_demand";
  }
  const blockingSource = deniesCancellation(outside)
    ? outside.replace(/\bcancell(?:ed|ation|ing)?\b/gi, " ")
    : outside;
  const blocking = detectBlockingRole(blockingSource);
  const positive = isPositiveCurrentBalance(outside);
  if (positive && (blocking || quotedDemandContradiction(text))) {
    return "ambiguous";
  }
  if (blocking) {
    return blocking;
  }
  if (positive) {
    const amounts = amountValuesIn(outside);
    if (amounts.length > 0 && amounts.every((amount) => amount === 0)) {
      return "settled_or_negated";
    }
    return "current_balance";
  }
  return "unsupported";
}

const LINE_CONTINUATION_START =
  /^(?:only|if|and|or|unless|subject\b|after|when|but|provided|once|pending|until|while|should|where|assuming|were|depending\s+on|in\s+case|supposing|on\s+condition)\b/i;

const STANDALONE_HEADER_LINE =
  /^(?:---|dear\b|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+\d{4}\.?$|(?:date|issue\s+date|notice\s+date|letter\s+date|statement\s+date|issued|dated|due\s+date|payment\s+due|payment\s+deadline|response\s+deadline|final\s+date|account\s+ref|billing\s+period)\b)/i;

function quoteTruncatesSentence(source: string, quote: string): boolean {
  const trimmed = quote.trim();
  if (!trimmed || /\.{3}|…|\u2026/.test(trimmed) || /[.!?]["”'\u201D\u2019]?$/.test(trimmed)) {
    return false;
  }
  const index = source.indexOf(trimmed);
  if (index < 0) {
    return false;
  }
  const after = source.slice(index + trimmed.length);
  if (!after.trim() || /^\s*[.!?]/.test(after)) {
    return false;
  }
  if (/^\s*(?:\r\n|\r|\n|\u2028|\u2029)/.test(after)) {
    const next = normalizeForRole(after.replace(/^[\s\u2028\u2029]+/, ""));
    return LINE_CONTINUATION_START.test(next) || /^\p{Ll}/u.test(next);
  }
  return true;
}

export interface NoticeSentenceSpan {
  sentenceIndex: number;
  start: number;
  end: number;
  raw: string;
  norm: string;
  precedingHeaderLine: string | null;
  inHeaderPreamble: boolean;
}

function isHorizontalOrBreakSpace(ch: string): boolean {
  return /[\s\u2028\u2029]/.test(ch);
}

export function noticeSentenceSpans(text: string): NoticeSentenceSpan[] {
  const dearMatch = /\bDear\b/i.exec(text);
  const dearIndex = dearMatch?.index ?? Number.POSITIVE_INFINITY;

  interface RawLine {
    start: number;
    end: number;
    norm: string;
    precedingHeaderLine: string | null;
  }

  const lines: RawLine[] = [];
  const breakRegex = /\r\n|\r|\n|\u2028|\u2029/g;
  let lineCursor = 0;
  let prevLineNorm: string | null = null;

  const pushTrimmedLine = (segStart: number, segEnd: number) => {
    let s = segStart;
    let e = segEnd;
    while (s < e && isHorizontalOrBreakSpace(text[s]!)) {
      s += 1;
    }
    while (e > s && isHorizontalOrBreakSpace(text[e - 1]!)) {
      e -= 1;
    }
    if (s >= e) {
      return;
    }
    const norm = normalizeForRole(text.slice(s, e)).replace(/\s+/g, " ").trim();
    if (!norm) {
      return;
    }
    lines.push({
      start: s,
      end: e,
      norm,
      precedingHeaderLine: prevLineNorm,
    });
    prevLineNorm = norm;
  };

  for (const match of text.matchAll(breakRegex)) {
    const at = match.index ?? 0;
    pushTrimmedLine(lineCursor, at);
    lineCursor = at + match[0].length;
  }
  pushTrimmedLine(lineCursor, text.length);

  interface MergedBlock {
    start: number;
    end: number;
    norm: string;
    precedingHeaderLine: string | null;
  }

  const blocks: MergedBlock[] = [];
  for (const line of lines) {
    const previous = blocks[blocks.length - 1];
    if (
      previous &&
      !/[.!?]["”'\u201D\u2019]?$/.test(previous.norm) &&
      !STANDALONE_HEADER_LINE.test(previous.norm) &&
      (LINE_CONTINUATION_START.test(line.norm) ||
        /^\p{Ll}/u.test(line.norm) ||
        (LINE_CONTINUATION_START.test(previous.norm) && /,$/.test(previous.norm)))
    ) {
      previous.end = line.end;
      previous.norm = `${previous.norm} ${line.norm}`;
      continue;
    }
    blocks.push({
      start: line.start,
      end: line.end,
      norm: line.norm,
      precedingHeaderLine: line.precedingHeaderLine,
    });
  }

  const result: NoticeSentenceSpan[] = [];
  let seenSubstantiveBody = false;

  for (const block of blocks) {
    const rawBlock = text.slice(block.start, block.end);
    let doubleQuote = false;
    let curlyQuote = false;
    let masked = "";
    for (let i = 0; i < rawBlock.length; i += 1) {
      const ch = rawBlock[i]!;
      if (ch === '"' && !curlyQuote) {
        doubleQuote = !doubleQuote;
        masked += ch;
      } else if (ch === "\u201C" && !doubleQuote) {
        curlyQuote = true;
        masked += ch;
      } else if (ch === "\u201D" && curlyQuote) {
        curlyQuote = false;
        masked += ch;
      } else if ((doubleQuote || curlyQuote) && (ch === "." || ch === "!" || ch === "?")) {
        masked += " ";
      } else if (ch === "\r" || ch === "\n" || ch === "\u2028" || ch === "\u2029") {
        masked += " ";
      } else {
        masked += ch;
      }
    }

    const pushPiece = (relStart: number, relEnd: number, firstInBlock: boolean) => {
      let s = block.start + relStart;
      let e = block.start + relEnd;
      while (s < e && isHorizontalOrBreakSpace(text[s]!)) {
        s += 1;
      }
      while (e > s && isHorizontalOrBreakSpace(text[e - 1]!)) {
        e -= 1;
      }
      if (s >= e) {
        return;
      }
      const raw = text.slice(s, e);
      const norm = normalizeForRole(raw).replace(/\s+/g, " ").trim();
      if (!norm) {
        return;
      }
      const inHeaderPreamble = s < dearIndex && !seenSubstantiveBody;
      result.push({
        sentenceIndex: result.length,
        start: s,
        end: e,
        raw,
        norm,
        precedingHeaderLine: firstInBlock ? block.precedingHeaderLine : null,
        inHeaderPreamble,
      });
      if (amountValuesIn(norm).length > 0 || /\b(?:please\s+pay|respond|contact|balance|account\s+was|cancelled|withdrawn)\b/i.test(norm)) {
        seenSubstantiveBody = true;
      }
    };

    let relStart = 0;
    let firstInBlock = true;
    for (const match of masked.matchAll(/(?<=[.!?]["”'\u201D\u2019]?)\s+(?=[A-Z"“\u201C£\d])/g)) {
      const at = match.index ?? 0;
      pushPiece(relStart, at, firstInBlock);
      firstInBlock = false;
      relStart = at + match[0].length;
    }
    pushPiece(relStart, rawBlock.length, firstInBlock);
  }

  return result;
}

function noticeSentences(text: string): string[] {
  return noticeSentenceSpans(text).map((item) => item.norm);
}

function sameAmount(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.001;
}

function pointsAtAmountBelow(sentence: string, amounts: readonly number[]): boolean {
  return (
    amounts.length === 0 &&
    /\b(?:below|following)\b/i.test(sentence) &&
    /\b(?:amount|balance|charge|sum)\b/i.test(sentence)
  );
}

function statedAmounts(sentence: string) {
  return findExplicitGbpAmounts(sentence).amounts;
}

export function isAdjacentFeeAmount(sentence: string, index: number, raw: string): boolean {
  const feeMatch = /\b(?:fee|surcharge|penalty)\b/i.exec(sentence);
  if (!feeMatch || feeMatch.index === undefined) {
    return false;
  }
  const start = Math.min(index + raw.length, feeMatch.index);
  const end = Math.max(index, feeMatch.index);
  const between = sentence.slice(start, end);
  return !/£/.test(between) && between.length <= 40;
}

export function nonFeeAmountValues(sentence: string): number[] {
  return distinctAmountValues(
    statedAmounts(sentence).filter((amount) => !isAdjacentFeeAmount(sentence, amount.index, amount.raw))
  ).filter((amount) => amount > 0);
}

function namesDistinctNewCharge(sentence: string): boolean {
  const text = normalizeForRole(sentence);
  if (
    /\bno\s+(?:new|separate)\s+charge\b/i.test(text) ||
    /\bnot\s+a\s+(?:new|separate)\s+charge\b/i.test(text)
  ) {
    return false;
  }
  return /\b(?:new\s+and\s+separate|separate\s+(?:charge|bill)|new\s+charge|corrected\s+bill|replacement\s+(?:charge|bill))\b/i.test(
    text
  );
}

function deniesDistinctNewCharge(sentence: string): boolean {
  const text = normalizeForRole(sentence);
  return (
    /\bno\s+(?:new|separate)\s+charge\b/i.test(text) ||
    /\bnot\s+a\s+(?:new|separate)\s+charge\b/i.test(text)
  );
}

/** Account-level closure. A later slip does not revive a balance. */
function closesWholeAccount(sentence: string): boolean {
  const text = normalizeForRole(sentence);
  if (/\bpaid\s+in\s+full\b/i.test(text) || /\bwritten\s+off\b/i.test(text)) {
    return true;
  }
  if (
    /\b(?:account|balance|debt)\b/i.test(text) &&
    /\b(?:was|is|has\s+been|have\s+been|now)\s+(?:settled(?:\s+in\s+full)?|cleared|clear|discharged|zero)\b/i.test(
      text
    )
  ) {
    return true;
  }
  return /\b(?:account|balance)\s+is\s+(?:now\s+)?clear\b/i.test(text);
}

function opensFreshBalance(sentence: string): boolean {
  const s = normalizeForRole(sentence);
  return (
    /\boutstanding\s+balance\s+(?:is|of|now|:)\b/i.test(s) ||
    /\byou\s+owe\s+£/i.test(s) ||
    /\b(?:total\s+to\s+pay|balance\s+due|amount\s+payable)\b/i.test(s) ||
    /\bamount\s+due\s+is\b/i.test(s) ||
    /\bplease\s+pay\s+the\s+(?:outstanding\s+)?balance\b/i.test(s) ||
    /\bplease\s+pay\s+£/i.test(s) ||
    isReinstatement(s)
  );
}

function replacementSplit(sentence: string): { current: number[]; retired: number[] } | null {
  const match = /^(.*)\b(replac(?:e|ing|ed)|supersed(?:e|ed|es))\b(.*)$/i.exec(sentence);
  if (!match) {
    return null;
  }
  const before = amountValuesIn(match[1] ?? "");
  const after = amountValuesIn(match[3] ?? "");
  if (before.length === 0 || after.length === 0) {
    return null;
  }
  if (/^replac/i.test(match[2] ?? "")) {
    return { current: before, retired: after };
  }
  return { current: after, retired: before };
}

export interface PaymentClaimAssessment {
  id: string;
  sentenceIndex: number;
  sentence: string;
  amount: number | null;
  role: PaymentSentenceRole;
  positiveEvidence: boolean;
  settlement: boolean;
  cancellation: boolean;
  waiver: boolean;
  conditional: boolean;
  reinstatement: "positive" | "negative" | "none";
  contradiction: boolean;
  injected: boolean;
  sourceSpan: string;
  evidenceComplete: boolean;
  decision: "current" | "not_current" | "unverified";
}

function claimKey(sentenceIndex: number, amount: number | null, role: string): string {
  const basis = `${sentenceIndex}|${amount ?? ""}|${role}`;
  let hash = 2166136261;
  for (let index = 0; index < basis.length; index += 1) {
    hash ^= basis.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `claim-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Figures that survive as the current outstanding balance.
 * A terminal account settlement is not undone by repeating an amount the
 * notice had already introduced. A later positive balance after a named
 * cancellation, or a different later amount, can remain. A forward
 * "amount below" negation covers only the next stated amount.
 */
function rememberPositive(acceptedAt: Map<number, number[]>, amount: number, index: number, lastPositive: Map<number, number>) {
  lastPositive.set(amount, index);
  const seen = acceptedAt.get(amount);
  if (seen) {
    seen.push(index);
  } else {
    acceptedAt.set(amount, [index]);
  }
}

function untrustedSentenceIndexes(text: string, spans: readonly NoticeSentenceSpan[]): Set<number> {
  const flagged = new Set<number>();
  let carry = false;
  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i]!;
    if (i > 0) {
      const gap = text.slice(spans[i - 1]!.end, span.start);
      if (/\n\s*\n/.test(gap)) {
        carry = false;
      }
    }
    const header = span.precedingHeaderLine ?? "";
    const headerIsLabel = header.length > 0 && !/[.!?]$/.test(header.trim());
    if (headerIsLabel && (introducesParagraphFrame(span.norm) || introducesParagraphFrame(header))) {
      carry = true;
    } else if (introducesParagraphFrame(span.norm)) {
      carry = true;
    }
    if (
      carry ||
      introducesUntrustedFrame(span.norm) ||
      (headerIsLabel && introducesUntrustedFrame(header))
    ) {
      flagged.add(span.sentenceIndex);
    }
  }
  return flagged;
}

function walkCurrentBalances(text: string): {
  current: number[];
  acceptedAt: Map<number, number[]>;
  reinstatedAt: Map<number, number>;
  injectedBlockedSentences: Set<number>;
  untrustedSentences: Set<number>;
} {
  const spans = noticeSentenceSpans(text);
  const sentences = spans.map((span) => span.norm);
  const untrustedSentences = untrustedSentenceIndexes(text, spans);
  let lastUnscopedTerminal = -1;
  let accountClosed = false;
  const introducedAtTerminal = new Set<number>();
  const lastScopedTerminal = new Map<number, number>();
  let lastUnscopedRetirement = -1;
  const lastScopedRetirement = new Map<number, number>();
  let lastUnscopedHistorical = -1;
  const lastScopedHistorical = new Map<number, number>();
  const lastPositive = new Map<number, number>();
  const acceptedAt = new Map<number, number[]>();
  const lastReinstatement = new Map<number, number>();
  const injectedBlockedSentences = new Set<number>();
  const seen = new Set<number>();
  let forwardBlock = false;
  let forwardInjectedBlock = false;
  sentences.forEach((sentence, index) => {
    if (untrustedSentences.has(index)) {
      return;
    }
    const amounts = amountValuesIn(sentence);
    const role = paymentSentenceRole(sentence);
    if (role === "injected_command") {
      const isBareOverridePreamble =
        amounts.length === 0 &&
        /^(?:please\s+)?(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier|preceding|system)?\s*(?:instructions?|rules?|prompts?|directives?|notice|text)(?:\s+above)?[.!]?$/i.test(
          normalizeForRole(sentence).trim()
        );
      forwardInjectedBlock = isBareOverridePreamble;
      return;
    }
    if (forwardInjectedBlock) {
      forwardInjectedBlock = false;
      injectedBlockedSentences.add(index);
      return;
    }
    for (const amount of amounts) {
      seen.add(amount);
    }
    if (forwardBlock && amounts.length > 0) {
      forwardBlock = false;
      for (const amount of amounts) {
        introducedAtTerminal.add(amount);
        lastScopedTerminal.set(amount, index);
      }
      return;
    }
    if (
      sentenceDisposesCurrentClaim(sentence) &&
      !namesDistinctNewCharge(sentence) &&
      !isReinstatement(sentence) &&
      !(
        matchesSupportedBalanceStructure(sentence) &&
        /\b(?:still\s+due|remains\s+due|remains\s+payable)\b/i.test(sentence)
      )
    ) {
      // A completed disposition names its amount, or it follows the one
      // amount already introduced. Several open amounts and no named figure
      // are not retired here: that association is uncertain, and a single
      // verified balance is withheld by the existing conflict check.
      const retired = amounts.length > 0 ? amounts : seen.size === 1 ? [...seen] : [];
      for (const amount of retired) {
        lastScopedRetirement.set(amount, index);
      }
      return;
    }
    if (
      role === "conditional_fee" ||
      role === "conditional_obligation" ||
      role === "ambiguous" ||
      role === "unsupported"
    ) {
      return;
    }
    if (role === "reinstated_demand") {
      if (amounts.length === 0) {
        return;
      }
      for (const amount of amounts) {
        lastReinstatement.set(amount, index);
        rememberPositive(acceptedAt, amount, index, lastPositive);
      }
      return;
    }
    if (role === "historical_payment") {
      if (amounts.length === 0) {
        if (!/\b(?:previous|last|earlier|prior)\s+(?:bill|balance|statement|payment|invoice)\b/i.test(sentence)) {
          lastUnscopedHistorical = index;
        }
      } else {
        for (const amount of amounts) {
          lastScopedHistorical.set(amount, index);
        }
      }
      return;
    }
    if (TERMINAL_ACCOUNT_ROLES.has(role)) {
      if (pointsAtAmountBelow(sentence, amounts)) {
        forwardBlock = true;
      }
      if (amounts.length === 0) {
        lastUnscopedTerminal = index;
        if (closesWholeAccount(sentence)) {
          accountClosed = true;
        }
        for (const amount of seen) {
          introducedAtTerminal.add(amount);
        }
      } else {
        for (const amount of amounts) {
          lastScopedTerminal.set(amount, index);
          introducedAtTerminal.add(amount);
        }
      }
      return;
    }
    if (DEMAND_RETIREMENT_ROLES.has(role)) {
      if (pointsAtAmountBelow(sentence, amounts)) {
        forwardBlock = true;
      }
      if (amounts.length === 0) {
        lastUnscopedRetirement = index;
      } else {
        for (const amount of amounts) {
          lastScopedRetirement.set(amount, index);
        }
      }
      return;
    }
    if (role === "current_balance") {
      if (forwardBlock) {
        forwardBlock = false;
        for (const amount of amounts) {
          introducedAtTerminal.add(amount);
          lastScopedTerminal.set(amount, index);
        }
        return;
      }
      const settledBefore = lastUnscopedTerminal >= 0 && lastUnscopedTerminal < index;
      const retiredBefore =
        (lastUnscopedRetirement >= 0 && lastUnscopedRetirement < index) ||
        amounts.some((amount) => {
          const retired = lastScopedRetirement.get(amount);
          return retired !== undefined && retired < index;
        });
      const deniesNew = deniesDistinctNewCharge(sentence);
      const distinctNew = namesDistinctNewCharge(sentence);
      if (
        (settledBefore || retiredBefore) &&
        (!opensFreshBalance(sentence) || deniesNew) &&
        !distinctNew
      ) {
        return;
      }
      const replacement = replacementSplit(sentence);
      if (replacement) {
        for (const amount of replacement.retired) {
          lastScopedRetirement.set(amount, index);
        }
        for (const amount of replacement.current.filter((amount) => amount > 0)) {
          rememberPositive(acceptedAt, amount, index, lastPositive);
        }
        return;
      }
      for (const amount of nonFeeAmountValues(sentence)) {
        const retiredAt = lastScopedRetirement.get(amount);
        const sameAmountRetired = retiredAt !== undefined && retiredAt < index;
        if (accountClosed && !distinctNew && !isReinstatement(sentence)) {
          continue;
        }
        // Repeating a retired amount is not a new debt. A different fuel,
        // account, or invoice label does not prove a separate obligation.
        // Only an explicit reinstatement or an explicitly separate new charge
        // can put that same amount back.
        if (sameAmountRetired && !distinctNew && !isReinstatement(sentence)) {
          continue;
        }
        rememberPositive(acceptedAt, amount, index, lastPositive);
      }
    }
  });

  const current: number[] = [];
  for (const [amount, positiveAt] of lastPositive) {
    const reinstatedAt = lastReinstatement.get(amount) ?? -1;
    const terminalAt = Math.max(lastScopedTerminal.get(amount) ?? -1, lastUnscopedTerminal);
    const retiredAt = Math.max(lastScopedRetirement.get(amount) ?? -1, lastUnscopedRetirement);
    const historicalAt = Math.max(lastScopedHistorical.get(amount) ?? -1, lastUnscopedHistorical);
    if (
      reinstatedAt >= positiveAt &&
      reinstatedAt >= terminalAt &&
      reinstatedAt >= retiredAt &&
      reinstatedAt >= historicalAt
    ) {
      current.push(amount);
      continue;
    }
    if (terminalAt > positiveAt) {
      continue;
    }
    if (
      terminalAt >= 0 &&
      terminalAt < positiveAt &&
      introducedAtTerminal.has(amount) &&
      reinstatedAt <= terminalAt
    ) {
      continue;
    }
    if (retiredAt > positiveAt || historicalAt > positiveAt) {
      continue;
    }
    current.push(amount);
  }
  current.sort((left, right) => left - right);
  return {
    current: current.filter((amount) => amount > 0),
    acceptedAt,
    reinstatedAt: lastReinstatement,
    injectedBlockedSentences,
    untrustedSentences,
  };
}

export function resolvedCurrentBalanceAmounts(text: string): number[] {
  return walkCurrentBalances(text).current;
}

const ISSUE_DATE_LABEL_PREFIX =
  /^(?:date\s*:\s*|date\s+of\s+(?:this\s+)?(?:issue|notice|letter|statement)\s*:?\s*|issue\s+date\s*:?\s*|notice\s+date\s*:?\s*|letter\s+date\s*:?\s*|statement\s+date\s*:?\s*|issued(?:\s+on)?\s*:?\s*|dated\s*:?\s*)(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{4})\b/i;

const DISQUALIFYING_PRECEDING_DATE_LABEL =
  /\b(?:due\s+date|payment\s+due|payment\s+deadline|response\s+deadline|deadline|pay\s+by|respond\s+by|meter\s+reading|last\s+payment|previous\s+payment|effective\s+date|cancellation\s+date|period\s+(?:start|end|from|to)|billing\s+period|supply\s+period|closing\s+date|expiry\s+date|final\s+date)\s*:?$/i;

/** A preamble date under one of these headings is not the notice issue date. */
const NON_ISSUE_SECTION =
  /\b(?:activity|readings|telephone|phone\s+call|call\s+with|new\s+price|service\s+table|direct\s+debit|account\s+summary|payment\s+received|next\s+collection|engineer\s+visit|price\s+change)\b/i;

function normalizeDateToken(token: string): string {
  return token.replace(/(\d{1,2})(?:st|nd|rd|th)\b/i, "$1");
}

/** A notice date needs an explicit issue/notice/letter/dated label or a preamble bare date line. */
export function isPositiveIssueDateEvidence(
  sentence: string,
  options?: { precedingHeaderLine?: string | null; inHeaderPreamble?: boolean }
): boolean {
  const trimmed = normalizeForRole(sentence).trim();
  if (!trimmed) {
    return false;
  }
  if (
    /\b(?:previous|earlier|prior|old|cancelled|withdrawn|superseded|original)\s+(?:bill|letter|notice|statement|demand|invoice)\b/i.test(
      trimmed
    )
  ) {
    return false;
  }
  if (/^\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+\d{4}\.?$/.test(trimmed)) {
    const header = options?.precedingHeaderLine ?? "";
    if (header && (DISQUALIFYING_PRECEDING_DATE_LABEL.test(header) || NON_ISSUE_SECTION.test(header))) {
      return false;
    }
    if (options?.inHeaderPreamble === false) {
      return false;
    }
    return parseCalendarDate(normalizeDateToken(trimmed.replace(/\.$/, ""))) !== null;
  }
  const match = ISSUE_DATE_LABEL_PREFIX.exec(trimmed);
  if (!match?.[1]) {
    return false;
  }
  const genericDate = /^date\s*:/i.test(trimmed) && !/^(?:issue|notice|letter|statement)\s+date\b/i.test(trimmed);
  if (genericDate) {
    if (options?.inHeaderPreamble !== true) {
      return false;
    }
    if (genericDateRowIsNotIssueDate(trimmed, options?.precedingHeaderLine)) {
      return false;
    }
  }
  return parseCalendarDate(normalizeDateToken(match[1])) !== null;
}

export interface IssueDateCandidate {
  sentenceIndex: number;
  start: number;
  end: number;
  stated: string;
  iso: string;
  quote: string;
}

export function extractIssueDateCandidateInSpan(
  rawText: string,
  span: NoticeSentenceSpan,
  blockedByInjection: boolean
): IssueDateCandidate | null {
  if (blockedByInjection) {
    return null;
  }
  const role = paymentSentenceRole(span.raw);
  if (
    role === "injected_command" ||
    role === "conditional_fee" ||
    role === "conditional_obligation" ||
    role === "cancelled_demand" ||
    role === "withdrawn_demand" ||
    role === "historical_payment" ||
    TERMINAL_ACCOUNT_ROLES.has(role)
  ) {
    return null;
  }
  if (
    !isPositiveIssueDateEvidence(span.raw, {
      precedingHeaderLine: span.precedingHeaderLine,
      inHeaderPreamble: span.inHeaderPreamble,
    })
  ) {
    return null;
  }
  const trimmedNorm = span.norm.trim();
  if (/^\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+\d{4}\.?$/.test(trimmedNorm)) {
    const cleanToken = normalizeDateToken(trimmedNorm.replace(/\.$/, ""));
    const parsed = parseCalendarDate(cleanToken);
    if (!parsed) {
      return null;
    }
    return {
      sentenceIndex: span.sentenceIndex,
      start: span.start,
      end: span.end,
      stated: cleanToken,
      iso: parsed.iso,
      quote: rawText.slice(span.start, span.end),
    };
  }
  const match = ISSUE_DATE_LABEL_PREFIX.exec(trimmedNorm);
  if (!match?.[1]) {
    return null;
  }
  const cleanToken = normalizeDateToken(match[1]);
  const parsed = parseCalendarDate(cleanToken);
  if (!parsed) {
    return null;
  }
  // If the sentence contains a later comma/semicolon clause with another date (e.g. "Issued 1 Nov, due 9 Dec"),
  // scope the issue-date evidence to the issue clause itself so the two dates do not conflate.
  let clauseEnd = span.end;
  const rawSlice = rawText.slice(span.start, span.end);
  const commaAt = rawSlice.search(/[,;]/);
  if (commaAt > 0) {
    const firstClause = rawSlice.slice(0, commaAt).trim();
    if (isoDatesIn(normalizeForRole(firstClause)).includes(parsed.iso)) {
      clauseEnd = span.start + firstClause.length;
    }
  }
  return {
    sentenceIndex: span.sentenceIndex,
    start: span.start,
    end: clauseEnd,
    stated: cleanToken,
    iso: parsed.iso,
    quote: rawText.slice(span.start, clauseEnd),
  };
}

const BALANCE_REASONS = new Set<EligibilityDecision["reason"]>([
  "current_balance",
  "explicit_reinstatement",
  "distinct_new_charge",
]);

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function occurrenceId(
  docSig: string,
  start: number,
  end: number,
  kind: string,
  amount: number | null,
  role: string
): string {
  return `claim-${hashText(`${docSig}|${start}|${end}|${kind}|${amount ?? ""}|${role}`)}`;
}

export function isReportedOrPriorInstruction(sentence: string): boolean {
  const s = normalizeForRole(sentence);
  if (DEMAND_RETIREMENT_ROLES.has(paymentSentenceRole(s))) {
    return true;
  }
  if (
    /\b(?:since\s+withdrawn|(?:previous|earlier|old|prior|former|cancelled|withdrawn|superseded|original)\s+(?:letter|bill|notice|statement|demand|invoice|request))\b/i.test(
      s
    )
  ) {
    return true;
  }
  if (
    /\b(?:letter|bill|notice|statement|demand|invoice|reminder|message|correspondence|it|we|they)\b[^.]{0,48}\b(?:said|stated|wrote|asked|told|requested|advised|read)\b/i.test(
      s
    )
  ) {
    return true;
  }
  return /\b(?:as\s+we\s+wrote|last\s+month\s+we\s+wrote|in\s+[A-Za-z]+\s+we\s+(?:said|wrote|asked))\b/i.test(s);
}

function hasDisqualifyingPaymentDirectionOrPayee(normSentence: string): boolean {
  if (/\b(?:instalments?|a\s+month|per\s+month|monthly)\b/i.test(normSentence)) {
    return true;
  }
  if (
    /\b(?:into\s+(?:your|a|an)\s+(?:bank|account)|refund|rebate|in\s+credit|credit\s+note|cheque|check|voucher|compensation)\b/i.test(
      normSentence
    )
  ) {
    return true;
  }
  if (/\b(?:separate|other|another|different|external|third[- ]party)\b/i.test(normSentence)) {
    return true;
  }
  // Paying a named third-party entity ("to Aqua Ltd", "directly to XYZ Council") is not this sender's balance.
  return /\b(?:pay|paid|payable|payment)\b[^.]{0,64}\b(?:directly\s+)?to\s+(?!us\b|our\b)[A-Z]/.test(
    normSentence
  );
}

/**
 * Positive structural check that an imperative payment instruction refers to the
 * notice's own stated balance/account (or explicit amount), not an unrelated obligation.
 */
export function hasPositiveBalancePaymentSyntax(normSentence: string): boolean {
  if (isReportedOrPriorInstruction(normSentence) || hasDisqualifyingPaymentDirectionOrPayee(normSentence)) {
    return false;
  }
  const outside = outsideQuotes(normSentence).replace(/\s+/g, " ").trim();
  if (!outside) {
    return false;
  }
  if (/\b(?:please\s+|kindly\s+|you\s+must\s+|must\s+)?make\s+a\s+payment(?:\s+(?:by|before|no\s+later\s+than|on\s+or\s+before|now|today|online)\b|[.!]?$)/i.test(outside)) {
    return true;
  }
  if (/\b(?:please\s+|kindly\s+)?settle\s+(?:your|this|the)\s+(?:account|balance|bill)\b/i.test(outside)) {
    return true;
  }
  if (/\bby\s+paying\s+£/i.test(outside)) {
    return true;
  }
  const payMatch = /\b(?:please\s+|kindly\s+|you\s+must\s+|must\s+|^)pay\s+(.+)$/i.exec(outside);
  if (!payMatch?.[1]) {
    return false;
  }
  const rest = payMatch[1].trim();
  if (/^(?:by|before|no\s+later\s+than|on\s+or\s+before|or\s+contact|now|today|immediately|in\s+full|online)\b/i.test(rest)) {
    return true;
  }
  if (/^£\s*\d/.test(rest)) {
    return true;
  }
  if (
    /^(?:it|this)(?:\s+(?:by|before|no\s+later\s+than|on\s+or\s+before|now|today|in\s+full|immediately|as\s+soon\s+as\s+possible|promptly|without\s+delay|online)\b|[.!]?$)/i.test(
      rest
    )
  ) {
    return true;
  }
  return /^(?:the|this|your)\s+(?:(?:outstanding|current|full|total|stated|revised|remaining|overdue)\s+)*(?:balance|amount(?:\s+(?:due|owed|payable))?|sum(?:\s+due)?|total|account)(?:\s+of\s+£[\d,.]+)?(?:\s+(?:by|before|no\s+later\s+than|on\s+or\s+before|or\b|now|today|in\s+full|immediately|as\s+soon\s+as\s+possible|promptly|without\s+delay|to\s+discuss|online|remains|is)|[.!]?$)/i.test(
    rest
  );
}

function isPaymentInstruction(sentence: string): boolean {
  return hasPositiveBalancePaymentSyntax(normalizeForRole(sentence));
}

const DATE_CAPTURE = "(\\d{1,2}(?:st|nd|rd|th)?\\s+[A-Za-z]+\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2})";

export function extractPaymentDeadlineIso(sentence: string): string | null {
  const s = outsideQuotes(normalizeForRole(sentence)).replace(/\s+/g, " ").trim();
  if (!s || isReportedOrPriorInstruction(s) || hasDisqualifyingPaymentDirectionOrPayee(s)) {
    return null;
  }
  if (hasPositiveBalancePaymentSyntax(s)) {
    const match = new RegExp(
      `\\b(?:by|before|no\\s+later\\s+than|on\\s+or\\s+before)\\s+${DATE_CAPTURE}\\b`,
      "i"
    ).exec(s);
    if (match?.[1]) {
      return parseCalendarDate(normalizeDateToken(match[1]))?.iso ?? null;
    }
  }
  // Declarative / labelled payment deadlines ("balance is due by ...", "must be received no later than ...",
  // "Final date for payment: ...", "Payment due: ...", "Payment must reach us by ...").
  const patterns = [
    new RegExp(
      `\\b(?:outstanding\\s+balance|full\\s+balance|amount\\s+due|balance(?:\\s+of\\s+£[\\d,.]+)?|corrected\\s+bill|payment)\\b[^.]{0,64}\\b(?:is\\s+(?:still\\s+)?)?(?:due|payable)\\s+(?:by|before|on\\s+or\\s+before|no\\s+later\\s+than)\\s+${DATE_CAPTURE}\\b`,
      "i"
    ),
    new RegExp(
      `\\b(?:full\\s+balance|outstanding\\s+balance|balance|payment|amount(?:\\s+due)?)\\b[^.]{0,64}\\b(?:must|should)\\s+(?:be\\s+received|reach\\s+us|be\\s+paid|be\\s+made)\\s+(?:by|before|on\\s+or\\s+before|no\\s+later\\s+than)\\s+${DATE_CAPTURE}\\b`,
      "i"
    ),
    new RegExp(
      `^(?:final\\s+date\\s+for\\s+payment|payment\\s+deadline|payment\\s+due(?:\\s+date)?)\\s*:\\s*${DATE_CAPTURE}\\b`,
      "i"
    ),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(s);
    if (match?.[1]) {
      return parseCalendarDate(normalizeDateToken(match[1]))?.iso ?? null;
    }
  }
  return null;
}

export function extractCorrespondenceDeadlineIsos(sentence: string): string[] {
  const s = outsideQuotes(normalizeForRole(sentence)).replace(/\s+/g, " ").trim();
  if (!s || isReportedOrPriorInstruction(s) || hasDisqualifyingPaymentDirectionOrPayee(s)) {
    return [];
  }
  const role = paymentSentenceRole(s);
  if (
    role === "conditional_fee" ||
    role === "conditional_obligation" ||
    role === "injected_command" ||
    role === "ambiguous" ||
    role === "historical_payment" ||
    TERMINAL_ACCOUNT_ROLES.has(role) ||
    DEMAND_RETIREMENT_ROLES.has(role)
  ) {
    return [];
  }
  // If the sentence is a payment instruction or payment deadline, it is not a correspondence-only deadline.
  if (hasPositiveBalancePaymentSyntax(s) || extractPaymentDeadlineIso(s) !== null) {
    return [];
  }
  if (/\b(?:pay|payment|payable)\b/i.test(s)) {
    return [];
  }
  const results: string[] = [];
  const labelMatch = new RegExp(`^response\\s+deadline\\s*:\\s*${DATE_CAPTURE}\\b`, "i").exec(s);
  if (labelMatch?.[1]) {
    const parsed = parseCalendarDate(normalizeDateToken(labelMatch[1]));
    if (parsed) {
      results.push(parsed.iso);
    }
    return results;
  }
  if (!/\b(?:please\s+)?(?:respond|contact(?:\s+our|\s+us|\s+the)?)\b/i.test(s)) {
    return [];
  }
  const byRegex = new RegExp(`\\b(?:by|before|no\\s+later\\s+than)\\s+${DATE_CAPTURE}\\b`, "gi");
  for (const match of s.matchAll(byRegex)) {
    if (!match[1]) {
      continue;
    }
    const parsed = parseCalendarDate(normalizeDateToken(match[1]));
    if (parsed && !results.includes(parsed.iso)) {
      results.push(parsed.iso);
    }
  }
  return results;
}

function uniqueAmounts(amounts: readonly number[]): number[] {
  const unique: number[] = [];
  for (const amount of amounts) {
    if (!unique.some((item) => sameAmount(item, amount))) {
      unique.push(amount);
    }
  }
  unique.sort((left, right) => left - right);
  return unique;
}

function freezeEligibility(value: NoticeEligibility): NoticeEligibility {
  for (const decision of value.decisions) {
    Object.freeze(decision.evidence);
    if (decision.actionEvidence) {
      Object.freeze(decision.actionEvidence);
    }
    for (const ref of decision.supporting) {
      Object.freeze(ref);
    }
    for (const ref of decision.contradicting) {
      Object.freeze(ref);
    }
    Object.freeze(decision.supporting);
    Object.freeze(decision.contradicting);
    Object.freeze(decision);
  }
  Object.freeze(value.decisions);
  Object.freeze(value.eligibleAmountsGBP);
  Object.freeze(value.correspondenceDeadlinesIso);
  return Object.freeze(value);
}

/**
 * One eligibility result. Each occurrence is judged on its own. A shared
 * amount does not make a different occurrence eligible, and a notice-level
 * flag does not verify every payment action. The summaries are derived
 * from the decisions and then frozen.
 */
export function analyseNoticeEligibility(text: string): NoticeEligibility {
  const docSig = hashText(text);
  const walk = walkCurrentBalances(text);
  const sentenceSpans = noticeSentenceSpans(text);
  const decisions: EligibilityDecision[] = [];
  const retirementSpans: { sentenceIndex: number; start: number; end: number }[] = [];
  const issueCandidates: { decision: EligibilityDecision; iso: string }[] = [];
  const correspondenceCandidates: { decision: EligibilityDecision; iso: string }[] = [];

  sentenceSpans.forEach((span) => {
    const { sentenceIndex, start, end, raw, norm } = span;
    const evidence = { sentenceIndex, start, end };
    const blockedByInjection = walk.injectedBlockedSentences.has(sentenceIndex);
    const inUntrustedFrame = walk.untrustedSentences.has(sentenceIndex);
    const role: PaymentSentenceRole = blockedByInjection
      ? "injected_command"
      : inUntrustedFrame
        ? "unsupported"
        : paymentSentenceRole(raw);

    if (
      role === "cancelled_demand" ||
      role === "withdrawn_demand" ||
      role === "paid_in_full" ||
      role === "written_off" ||
      role === "settled_or_negated" ||
      role === "waived"
    ) {
      retirementSpans.push(evidence);
    }

    const amounts = nonFeeAmountValues(norm);
    const dated = /\b(?:\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+\d{4}|\d{4}-\d{2}-\d{2})\b/.test(norm);
    if (amounts.length > 0 || role !== "unsupported") {
      const targets = amounts.length > 0 ? amounts : [null];
      for (const amount of targets) {
        if (
          amount === null &&
          role === "current_balance" &&
          isPaymentInstruction(norm) &&
          walk.current.length === 1
        ) {
          continue;
        }
        const survived =
          !blockedByInjection && amount !== null && walk.current.some((item) => sameAmount(item, amount));
        const accepted =
          !blockedByInjection &&
          amount !== null &&
          (walk.acceptedAt.get(amount) ?? []).some((index) => index === sentenceIndex);
        const reinstatedAt = amount === null ? undefined : walk.reinstatedAt.get(amount);
        const afterReinstatement =
          survived &&
          reinstatedAt !== undefined &&
          sentenceIndex >= reinstatedAt &&
          (role === "current_balance" || role === "reinstated_demand");
        const positiveOccurrence =
          survived &&
          (accepted || afterReinstatement) &&
          (role === "current_balance" || role === "reinstated_demand" || namesDistinctNewCharge(norm));
        let reason: EligibilityDecision["reason"] = "insufficient_evidence";
        let status: EligibilityDecision["status"] = "INELIGIBLE";
        if (role === "injected_command" || blockedByInjection) {
          reason = "model_directed";
        } else if (role === "conditional_obligation") {
          reason = "conditional_or_hypothetical";
        } else if (role === "conditional_fee") {
          reason = "conditional_fee";
        } else if (role === "waived") {
          reason = "waived_fee";
        } else if (role === "refunded_payment") {
          reason = "refunded_fee";
        } else if (positiveOccurrence && walk.current.length > 1) {
          reason = "conflicting_balances";
          status = "NEEDS_REVIEW";
        } else if (positiveOccurrence && role === "reinstated_demand") {
          reason = "explicit_reinstatement";
          status = "ELIGIBLE";
        } else if (positiveOccurrence && namesDistinctNewCharge(norm)) {
          reason = "distinct_new_charge";
          status = "ELIGIBLE";
        } else if (positiveOccurrence) {
          reason = "current_balance";
          status = "ELIGIBLE";
        } else if (role === "current_balance" || role === "reinstated_demand") {
          reason = "repeated_retired_amount";
        } else if (
          role === "paid_in_full" ||
          role === "written_off" ||
          role === "settled_or_negated"
        ) {
          reason = "account_settled";
        } else if (role === "cancelled_demand" || role === "withdrawn_demand" || role === "historical_payment") {
          reason = "historical_or_retired";
        } else if (
          /\b(?:issued\s+by\s+mistake|not\s+to\s+charge|absorbed\s+this\s+amount|disregard\s+this\s+amount)\b/i.test(
            norm
          )
        ) {
          reason = "later_settlement";
        }
        const includedFee =
          /\b(?:includes?|including)\b/i.test(norm) &&
          /\b(?:fee|surcharge|penalty)\b/i.test(norm) &&
          isAdjacentFeeAmount(norm, norm.indexOf("£"), "£");
        if (includedFee && !positiveOccurrence && amount !== null && status !== "ELIGIBLE") {
          reason = "included_fee";
        }
        decisions.push({
          id: occurrenceId(docSig, start, end, amount === null ? "plain" : "amount", amount, role),
          status,
          reason,
          amount,
          role,
          evidence,
          supporting: status === "ELIGIBLE" || status === "NEEDS_REVIEW" ? [evidence] : [],
          contradicting:
            status === "INELIGIBLE" && (reason === "repeated_retired_amount" || reason === "account_settled")
              ? retirementSpans.filter((item) => item.sentenceIndex < sentenceIndex)
              : [],
          paymentActionSupported: false,
          deadlineSupported: false,
          deadlineConflict: false,
          actionEvidence: null,
          deadlineIso: null,
          dateIso: null,
        });
      }
    }

    if (dated && !inUntrustedFrame) {
      const issueCandidate = extractIssueDateCandidateInSpan(text, span, blockedByInjection);
      if (issueCandidate) {
        const issueEvidence = {
          sentenceIndex,
          start: issueCandidate.start,
          end: issueCandidate.end,
        };
        const issueDecision: EligibilityDecision = {
          id: occurrenceId(docSig, issueCandidate.start, issueCandidate.end, "issue_date", null, role),
          status: "ELIGIBLE",
          reason: "issue_date",
          amount: null,
          role,
          evidence: issueEvidence,
          supporting: [issueEvidence],
          contradicting: [],
          paymentActionSupported: false,
          deadlineSupported: false,
          deadlineConflict: false,
          actionEvidence: null,
          deadlineIso: null,
          dateIso: issueCandidate.iso,
        };
        decisions.push(issueDecision);
        issueCandidates.push({ decision: issueDecision, iso: issueCandidate.iso });
      } else {
        const corrIsos = blockedByInjection ? [] : extractCorrespondenceDeadlineIsos(raw);
        if (corrIsos.length === 1) {
          const corrDecision: EligibilityDecision = {
            id: occurrenceId(docSig, start, end, "correspondence_deadline", null, role),
            status: "ELIGIBLE",
            reason: "correspondence_deadline",
            amount: null,
            role,
            evidence,
            supporting: [evidence],
            contradicting: [],
            paymentActionSupported: false,
            deadlineSupported: true,
            deadlineConflict: false,
            actionEvidence: null,
            deadlineIso: corrIsos[0]!,
            dateIso: corrIsos[0]!,
          };
          decisions.push(corrDecision);
          correspondenceCandidates.push({ decision: corrDecision, iso: corrIsos[0]! });
        } else if (corrIsos.length > 1) {
          for (const iso of corrIsos) {
            const corrDecision: EligibilityDecision = {
              id: occurrenceId(docSig, start, end, `correspondence_deadline:${iso}`, null, role),
              status: "NEEDS_REVIEW",
              reason: "conflicting_deadlines",
              amount: null,
              role,
              evidence,
              supporting: [evidence],
              contradicting: [evidence],
              paymentActionSupported: false,
              deadlineSupported: false,
              deadlineConflict: true,
              actionEvidence: null,
              deadlineIso: null,
              dateIso: iso,
            };
            decisions.push(corrDecision);
            correspondenceCandidates.push({ decision: corrDecision, iso });
          }
        } else if (amounts.length === 0) {
          decisions.push({
            id: occurrenceId(docSig, start, end, "date", null, role),
            status: "INELIGIBLE",
            reason: "wrong_date_role",
            amount: null,
            role,
            evidence,
            supporting: [],
            contradicting: [],
            paymentActionSupported: false,
            deadlineSupported: false,
            deadlineConflict: false,
            actionEvidence: null,
            deadlineIso: null,
            dateIso: isoDatesIn(norm)[0] ?? null,
          });
        }
      }
    }
  });

  // Resolve conflicting issue-date candidates: multiple distinct issue dates fail closed.
  const distinctIssueIsos = [...new Set(issueCandidates.map((item) => item.iso))];
  const issueDateConflict = distinctIssueIsos.length > 1;
  if (issueDateConflict) {
    for (const candidate of issueCandidates) {
      candidate.decision.status = "NEEDS_REVIEW";
      candidate.decision.reason = "conflicting_issue_dates";
      candidate.decision.supporting = [];
      candidate.decision.contradicting = issueCandidates
        .filter((other) => other.iso !== candidate.iso)
        .map((other) => other.decision.evidence);
    }
  }
  const verifiedIssueIso = distinctIssueIsos.length === 1 ? distinctIssueIsos[0]! : null;

  // Same figure, different named bills: not one verified total. K9 repeated
  // mentions have no distinct bill labels and stay one claim.
  const independentAmounts = new Set<number>();
  const eligibleBalanceDecisions = decisions.filter(
    (item) => item.status === "ELIGIBLE" && item.amount !== null && BALANCE_REASONS.has(item.reason)
  );
  const balancesByAmount = new Map<number, EligibilityDecision[]>();
  for (const decision of eligibleBalanceDecisions) {
    const group = balancesByAmount.get(decision.amount!) ?? [];
    group.push(decision);
    balancesByAmount.set(decision.amount!, group);
  }
  for (const [amount, group] of balancesByAmount) {
    const labels = group.map((decision) => {
      const span = sentenceSpans.find((item) => item.sentenceIndex === decision.evidence.sentenceIndex);
      return span ? independentClaimLabel(span.norm) : null;
    });
    const distinctLabels = new Set(labels.filter((label): label is string => label !== null));
    if (distinctLabels.size < 2) {
      continue;
    }
    independentAmounts.add(amount);
    for (const decision of group) {
      const span = sentenceSpans.find((item) => item.sentenceIndex === decision.evidence.sentenceIndex);
      if (!span || !independentClaimLabel(span.norm)) {
        continue;
      }
      decision.status = "NEEDS_REVIEW";
      decision.reason = "conflicting_balances";
      decision.paymentActionSupported = false;
      decision.deadlineSupported = false;
      decision.deadlineIso = null;
    }
  }

  // Resolve correspondence deadlines (excluding any date equal to the verified issueDate).
  const activeCorr = correspondenceCandidates.filter((item) => item.iso !== verifiedIssueIso);
  const distinctCorrIsos = [...new Set(activeCorr.map((item) => item.iso))].sort();
  const correspondenceDeadlineConflict =
    distinctCorrIsos.length > 1 || activeCorr.some((item) => item.decision.deadlineConflict);
  if (correspondenceDeadlineConflict) {
    for (const candidate of activeCorr) {
      candidate.decision.status = "NEEDS_REVIEW";
      candidate.decision.reason = "conflicting_deadlines";
      candidate.decision.deadlineSupported = false;
      candidate.decision.deadlineConflict = true;
      candidate.decision.deadlineIso = null;
    }
  }

  const eligibleClaims = decisions
    .filter((item) => item.status === "ELIGIBLE" && item.amount !== null && BALANCE_REASONS.has(item.reason))
    .sort((left, right) => left.evidence.start - right.evidence.start);

  function claimAtSentence(sentenceIndex: number): EligibilityDecision | null {
    const owned = eligibleClaims.filter((item) => item.evidence.sentenceIndex === sentenceIndex);
    return owned.length === 1 ? owned[0]! : null;
  }

  // Sentence indices that introduce an unquoted retired, settled, historical, or competing demand,
  // which closes the amount-free focus window of any earlier claim.
  const WINDOW_CLOSING_REASONS = new Set<EligibilityDecision["reason"]>([
    "conflicting_balances",
    "repeated_retired_amount",
    "account_settled",
    "historical_or_retired",
    "later_settlement",
  ]);

  function closesAmountFreeClaimWindow(span: NoticeSentenceSpan): boolean {
    if (walk.untrustedSentences.has(span.sentenceIndex)) {
      return false;
    }
    const outside = outsideQuotes(span.norm).trim();
    if (!outside) {
      return false;
    }
    const role = paymentSentenceRole(outside);
    if (
      DEMAND_RETIREMENT_ROLES.has(role) ||
      TERMINAL_ACCOUNT_ROLES.has(role) ||
      role === "historical_payment"
    ) {
      return true;
    }
    if (introducesHistoricalCopy(outside) || introducesHistoricalCopy(span.precedingHeaderLine ?? "")) {
      return true;
    }
    return decisions.some(
      (item) =>
        item.evidence.sentenceIndex === span.sentenceIndex &&
        item.amount !== null &&
        item.status !== "ELIGIBLE" &&
        WINDOW_CLOSING_REASONS.has(item.reason)
    );
  }

  for (const claim of eligibleClaims) {
    const amount = claim.amount!;
    const claimSentenceIndex = claim.evidence.sentenceIndex;
    const claimStart = claim.evidence.start;
    const nextEligibleClaimStart =
      eligibleClaims.find((item) => item.evidence.start > claimStart)?.evidence.start ?? Number.POSITIVE_INFINITY;
    const ownedActions: { span: { sentenceIndex: number; start: number; end: number }; due: string | null }[] = [];
    const ownedDeadlines: string[] = [];
    let amountFreeWindowClosed = false;

    for (const span of sentenceSpans) {
      const { sentenceIndex, start, end, raw, norm } = span;
      if (sentenceIndex < claimSentenceIndex) {
        continue;
      }
      if (start >= nextEligibleClaimStart) {
        break;
      }
      if (walk.injectedBlockedSentences.has(sentenceIndex) || walk.untrustedSentences.has(sentenceIndex)) {
        continue;
      }
      if (sentenceIndex > claimSentenceIndex && closesAmountFreeClaimWindow(span)) {
        amountFreeWindowClosed = true;
        continue;
      }
      const sentenceOwner = claimAtSentence(sentenceIndex);
      if (sentenceOwner && sentenceOwner.id !== claim.id) {
        continue;
      }
      const role = paymentSentenceRole(raw);
      if (
        role === "conditional_fee" ||
        role === "conditional_obligation" ||
        role === "injected_command" ||
        role === "ambiguous" ||
        role === "historical_payment" ||
        TERMINAL_ACCOUNT_ROLES.has(role) ||
        DEMAND_RETIREMENT_ROLES.has(role)
      ) {
        continue;
      }
      const stated = nonFeeAmountValues(norm);
      if (stated.length > 0 && !stated.every((item) => sameAmount(item, amount))) {
        continue;
      }
      const blocks = decisions.some(
        (item) =>
          item.evidence.sentenceIndex === sentenceIndex &&
          item.amount !== null &&
          item.status !== "ELIGIBLE" &&
          item.reason !== "conditional_fee" &&
          item.reason !== "waived_fee" &&
          item.reason !== "refunded_fee" &&
          item.reason !== "included_fee" &&
          (sameAmount(item.amount, amount) || stated.length === 0)
      );
      if (blocks) {
        continue;
      }
      // Once an intervening retired/cancelled/historical claim appeared, an amount-free
      // instruction has ambiguous ownership and cannot bind by window position alone.
      if (amountFreeWindowClosed && stated.length === 0) {
        continue;
      }

      const previousSpan =
        sentenceSpans.find((item) => item.sentenceIndex === sentenceIndex - 1) ?? null;
      const ownsBalance = instructionOwnsSelectedBalance(
        norm,
        previousSpan?.norm ?? null,
        previousSpan?.sentenceIndex === claimSentenceIndex
      );
      if (!ownsBalance) {
        continue;
      }
      const actionOk = hasPositiveBalancePaymentSyntax(norm);
      const due = extractPaymentDeadlineIso(raw);
      if (actionOk) {
        ownedActions.push({ span: { sentenceIndex, start, end }, due });
      }
      if (due && due !== verifiedIssueIso) {
        ownedDeadlines.push(due);
      }
    }

    ownedActions.sort((left, right) => left.span.start - right.span.start);
    if (ownedActions.length > 0) {
      claim.paymentActionSupported = true;
      claim.actionEvidence = ownedActions[0]!.span;
      for (const action of ownedActions) {
        if (!claim.supporting.some((item) => item.start === action.span.start && item.end === action.span.end)) {
          claim.supporting = [...claim.supporting, action.span];
        }
      }
    }

    const distinctOwnedDeadlines = [...new Set(ownedDeadlines)];
    if (distinctOwnedDeadlines.length > 1) {
      claim.deadlineConflict = true;
      claim.deadlineSupported = false;
      claim.deadlineIso = null;
    } else if (distinctOwnedDeadlines.length === 1) {
      claim.deadlineConflict = false;
      claim.deadlineIso = distinctOwnedDeadlines[0]!;
      claim.deadlineSupported = true;
    }
  }

  // Cross-claim payment-deadline integrity:
  // Any unresolved payment-date conflict on a claim, or disagreement across eligible balance claims,
  // or conflicting unretired notice-level payment deadline invalidates payment deadlines across all claims.
  const claimDeadlines = [
    ...new Set(eligibleClaims.map((item) => item.deadlineIso).filter((iso): iso is string => iso !== null)),
  ];
  let paymentDeadlineConflict =
    eligibleClaims.some((item) => item.deadlineConflict) || claimDeadlines.length > 1;

  if (!paymentDeadlineConflict && eligibleClaims.length > 0) {
    const allNoticePaymentDeadlines = new Set<string>(claimDeadlines);
    for (const span of sentenceSpans) {
      if (walk.injectedBlockedSentences.has(span.sentenceIndex) || walk.untrustedSentences.has(span.sentenceIndex)) {
        continue;
      }
      const role = paymentSentenceRole(span.raw);
      if (
        role === "conditional_fee" ||
        role === "conditional_obligation" ||
        role === "injected_command" ||
        role === "ambiguous" ||
        role === "historical_payment" ||
        TERMINAL_ACCOUNT_ROLES.has(role) ||
        DEMAND_RETIREMENT_ROLES.has(role)
      ) {
        continue;
      }
      const stated = nonFeeAmountValues(span.norm);
      if (
        stated.length > 0 &&
        !stated.every((val) => eligibleClaims.some((c) => c.amount !== null && sameAmount(c.amount, val)))
      ) {
        continue;
      }
      const due = extractPaymentDeadlineIso(span.raw);
      if (due && due !== verifiedIssueIso) {
        allNoticePaymentDeadlines.add(due);
      }
    }
    if (allNoticePaymentDeadlines.size > 1) {
      paymentDeadlineConflict = true;
    }
  }

  if (paymentDeadlineConflict) {
    for (const claim of eligibleClaims) {
      claim.deadlineConflict = true;
      claim.deadlineSupported = false;
      claim.deadlineIso = null;
    }
  }

  const eligibleAmountValues = uniqueAmounts(eligibleClaims.map((item) => item.amount ?? 0));
  const reviewAmounts = uniqueAmounts(
    decisions
      .filter(
        (item) =>
          item.status === "NEEDS_REVIEW" &&
          item.reason === "conflicting_balances" &&
          item.amount !== null &&
          !independentAmounts.has(item.amount)
      )
      .map((item) => item.amount ?? 0)
  );
  const eligibleAmountsGBP = eligibleAmountValues.length > 0 ? eligibleAmountValues : reviewAmounts;

  return freezeEligibility({
    decisions,
    eligibleAmountsGBP,
    paymentActionSupported: decisions.some((item) => item.status === "ELIGIBLE" && item.paymentActionSupported),
    deadlineSupported:
      !paymentDeadlineConflict && decisions.some((item) => item.status === "ELIGIBLE" && item.deadlineSupported),
    paymentDeadlineConflict,
    correspondenceDeadlinesIso: correspondenceDeadlineConflict ? [] : distinctCorrIsos,
    correspondenceDeadlineConflict,
    issueDateConflict,
  });
}

export type SourceAmountAuthority = "verified" | "needs_review" | "not_stated" | "conflicting";

/** The same eligible-balance decision Read Notice and v2 use for a fresh notice. */
export function verifiedBalanceForSource(text: string): {
  amountGBP: number | null;
  quote: string | null;
  authority: SourceAmountAuthority;
} {
  if (noticeExceedsSupportedSize(text)) {
    return { amountGBP: null, quote: null, authority: "needs_review" };
  }
  const eligibility = analyseNoticeEligibility(text);
  const conflicting = eligibility.decisions.some(
    (item) => item.status === "NEEDS_REVIEW" && item.reason === "conflicting_balances" && item.amount !== null
  );
  const eligible = eligibility.decisions.filter(
    (item) =>
      item.status === "ELIGIBLE" &&
      item.amount !== null &&
      item.amount > 0 &&
      BALANCE_REASONS.has(item.reason)
  );
  const distinct = [...new Set(eligible.map((item) => item.amount!))];
  if (!conflicting && distinct.length === 1) {
    const match = eligible.find((item) => item.amount === distinct[0]);
    const quote = match ? text.slice(match.evidence.start, match.evidence.end) : null;
    return { amountGBP: distinct[0]!, quote, authority: "verified" };
  }
  const sawAmount = eligibility.decisions.some(
    (item) =>
      item.amount !== null &&
      item.reason !== "included_fee" &&
      item.reason !== "conditional_fee" &&
      item.reason !== "waived_fee" &&
      item.reason !== "refunded_fee"
  );
  if (conflicting || distinct.length > 1) {
    return { amountGBP: null, quote: null, authority: "conflicting" };
  }
  return { amountGBP: null, quote: null, authority: sawAmount ? "needs_review" : "not_stated" };
}

export function assessPaymentClaims(text: string): PaymentClaimAssessment[] {
  const current = resolvedCurrentBalanceAmounts(text);
  const claims: PaymentClaimAssessment[] = [];
  noticeSentences(text).forEach((sentence, sentenceIndex) => {
    const role = paymentSentenceRole(sentence);
    const amounts = amountValuesIn(sentence);
    const targets = amounts.length > 0 ? amounts : [null];
    const outside = outsideQuotes(sentence);
    for (const amount of targets) {
      const survived = amount !== null && current.some((item) => sameAmount(item, amount));
      const decision: PaymentClaimAssessment["decision"] = survived
        ? "current"
        : role === "ambiguous" || role === "unsupported"
          ? "unverified"
          : "not_current";
      claims.push({
        id: claimKey(sentenceIndex, amount, role),
        sentenceIndex,
        sentence,
        amount,
        role,
        positiveEvidence: role === "current_balance" || role === "reinstated_demand",
        settlement: TERMINAL_ACCOUNT_ROLES.has(role),
        cancellation: role === "cancelled_demand",
        waiver: role === "waived",
        conditional: role === "conditional_fee" || role === "conditional_obligation",
        reinstatement: role === "reinstated_demand"
          ? "positive"
          : /\b(?:will\s+not|won'?t|never|not)\s+reinstate\b/i.test(outside)
            ? "negative"
            : "none",
        contradiction: role === "ambiguous" || (role === "current_balance" && !survived && amount !== null),
        injected: role === "injected_command",
        sourceSpan: sentence,
        evidenceComplete: !/\.{3}|…|\u2026/.test(sentence) && /[.!?]["”']?$/.test(sentence.trim()),
        decision,
      });
    }
  });
  return claims;
}

export function sentenceSupportsResponseDeadline(
  sentence: string,
  resolved: readonly number[]
): boolean {
  const s = normalizeForRole(sentence);
  const role = paymentSentenceRole(s);
  if (
    role === "conditional_fee" ||
    role === "conditional_obligation" ||
    role === "injected_command" ||
    role === "ambiguous" ||
    role === "historical_payment" ||
    TERMINAL_ACCOUNT_ROLES.has(role) ||
    DEMAND_RETIREMENT_ROLES.has(role)
  ) {
    return false;
  }
  if (isReportedOrPriorInstruction(s) || hasDisqualifyingPaymentDirectionOrPayee(s)) {
    return false;
  }
  const paymentDue = extractPaymentDeadlineIso(s);
  const paymentLinked =
    paymentDue !== null ||
    hasPositiveBalancePaymentSyntax(s) ||
    role === "current_balance" ||
    role === "reinstated_demand" ||
    /\b(?:pay|payment|payable)\b/i.test(s);
  if (paymentLinked) {
    if (resolved.length !== 1 || paymentDue === null) {
      return false;
    }
    const amounts = nonFeeAmountValues(s);
    return amounts.length === 0 || amounts.every((amount) => resolved.some((item) => sameAmount(item, amount)));
  }
  return extractCorrespondenceDeadlineIsos(s).length > 0;
}

export function paymentQuoteUndermined(
  quote: string,
  actionSummary: string,
  resolved: readonly number[]
): boolean {
  const s = normalizeForRole(quote);
  if (
    actionSummary === "request_review" &&
    /\bwhile\s+we\s+review\b/i.test(s) &&
    !/\bplease\b/i.test(s)
  ) {
    return true;
  }
  const payment = actionSummary === "pay_stated_balance" || actionSummary === "pay_or_contact";
  if (!payment) {
    return false;
  }
  const role = paymentSentenceRole(s);
  if (
    role === "conditional_fee" ||
    role === "conditional_obligation" ||
    role === "injected_command" ||
    role === "ambiguous" ||
    role === "historical_payment" ||
    TERMINAL_ACCOUNT_ROLES.has(role) ||
    DEMAND_RETIREMENT_ROLES.has(role)
  ) {
    return true;
  }
  if (!hasPositiveBalancePaymentSyntax(s) && role !== "reinstated_demand") {
    return true;
  }
  if (resolved.length !== 1) {
    return true;
  }
  const amounts = nonFeeAmountValues(s);
  return amounts.some((amount) => !resolved.some((item) => sameAmount(item, amount)));
}

function settledPayment(quote: string): boolean {
  const s = normalizeForRole(quote);
  return (
    /\bpaid\s+in\s+full\b/i.test(s) ||
    /\bwritten\s+off\b/i.test(s) ||
    /\bno\s+longer\s+required\b/i.test(s) ||
    new RegExp(`\\b${PASSIVE_AUX}\\s+waived\\b`, "i").test(s) ||
    new RegExp(`\\b${PASSIVE_AUX}\\s+refunded\\b`, "i").test(s) ||
    /\brefunded\s+in\s+full\b/i.test(s) ||
    /\b(?:please\s+)?(?:ignore|disregard)\b[^.]{0,80}\brequest\s+to\s+pay\b/i.test(s)
  );
}

function textHasAffirmativeDemand(text: string): boolean {
  return (
    /\bplease\s+pay\b/i.test(text) ||
    /\boutstanding\s+balance\b/i.test(text) ||
    /\bamount\s+due\b/i.test(text) ||
    /\bbalance\s+now\s+requested\b/i.test(text) ||
    (/\bmust\s+pay\b/i.test(text) && !/\bmust\s+pay\s+nothing\b/i.test(text)) ||
    /\bpayment\s+is\s+due\b/i.test(text)
  );
}

function affirmativePaymentInstruction(quote: string): boolean {
  return textHasAffirmativeDemand(outsideQuotes(quote));
}

/**
 * A located quotation is not a current payment instruction.
 * One blocking role stays unusable. A blocking role beside an affirmative
 * instruction, or two blocking roles, fails closed as ambiguous.
 * "May be withdrawn" and "if you do not pay" are not blocking roles.
 */
function obligationDisposition(quote: string): ClaimSupport | null {
  const outside = outsideQuotes(quote);
  const affirmative = textHasAffirmativeDemand(outside);
  const quotedOnly = textHasAffirmativeDemand(quote) && !affirmative;
  const blocking = [
    explicitlyCancelled(outside),
    explicitlyWithdrawn(outside),
    explicitlyNegated(outside),
    historicalPayment(outside),
    settledPayment(outside),
  ].filter(Boolean);
  if (quotedOnly && blocking.length === 0) {
    return "substring_only";
  }
  if (affirmativePaymentInstruction(quote) && blocking.length > 0) {
    return "ambiguous";
  }
  if (blocking.length > 1) {
    return "ambiguous";
  }
  if (blocking.length === 1) {
    return "substring_only";
  }
  return null;
}

function isoDatesIn(text: string): string[] {
  const found: string[] = [];
  const pattern =
    /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+\d{4}|\d{1,2}[/.-]\d{1,2}[/.-]\d{4})\b/gi;
  for (const match of text.matchAll(pattern)) {
    const token = match[1];
    if (!token) {
      continue;
    }
    const parsed = parseCalendarDate(token);
    if (parsed && !found.includes(parsed.iso)) {
      found.push(parsed.iso);
    }
  }
  return found;
}

export function groundCalendarDate(
  source: string,
  claimed: string | null,
  quote: string | null
): GroundedFact<string> {
  const verification = quote ? verifyQuoteInSource(source, quote) : null;
  const problem = quotationProblem(quote, verification);
  const parsedClaim = claimed ? parseCalendarDate(claimed) ?? isoDatesIn(claimed)[0] ?? null : null;
  const claimIso = typeof parsedClaim === "string" ? parsedClaim : parsedClaim?.iso ?? null;
  if (!claimIso) {
    return grounded<string>(
      null,
      quote,
      problem === "incomplete" ? "incomplete" : "missing",
      verification
    );
  }
  if (problem) {
    return grounded(claimIso, quote, problem, verification);
  }
  const dates = isoDatesIn(quote ?? "");
  if (!dates.includes(claimIso)) {
    return grounded(claimIso, quote, "substring_only", verification);
  }
  if (dates.length > 1) {
    return grounded(claimIso, quote, "ambiguous", verification);
  }
  if (quotedStatementOnly(source, quote ?? "")) {
    return grounded(claimIso, quote, "substring_only", verification);
  }
  const disposition = obligationDisposition(quote ?? "");
  if (disposition) {
    return grounded(claimIso, quote, disposition, verification);
  }
  return grounded(claimIso, quote, "supports_claim", verification);
}

export function groundBillingPeriod(
  source: string,
  claimed: string | null,
  quote: string | null
): GroundedFact<string> {
  const verification = quote ? verifyQuoteInSource(source, quote) : null;
  const problem = quotationProblem(quote, verification);
  if (claimed === null || claimed.trim().length === 0 || /^not stated$/i.test(claimed.trim())) {
    return grounded<string>(
      null,
      quote,
      problem === "incomplete" ? "incomplete" : "missing",
      verification
    );
  }
  if (problem) {
    return grounded(claimed, quote, problem, verification);
  }
  const window = parseBillingWindow(claimed);
  if (!window) {
    return grounded(claimed, quote, "insufficient", verification);
  }
  const tokens = claimed.toLowerCase().match(new RegExp(`\\b(?:${MONTH_WORD}|\\d{4})\\b`, "g")) ?? [];
  const quoteFold = (quote ?? "").toLowerCase();
  if (tokens.length === 0 || tokens.some((token) => !quoteFold.includes(token))) {
    return grounded(claimed, quote, "substring_only", verification);
  }
  return grounded(claimed, quote, "supports_claim", verification);
}

const CONTRADICTION =
  /\b(cancel(?:led|lation)?|waiv(?:e|ed|er)|invalid|void|refunded in full|no longer due)\b/i;

export function actionSummaryFromQuote(quote: string): ActionSummaryId {
  if (obligationDisposition(quote)) {
    return "review_stated_obligation";
  }
  const pay = /\bpay(?:ing|ment)?\b/i.test(quote);
  const contact = /\bcontact\b/i.test(quote);
  if (/\b(meter readings?|relevant records)\b/i.test(quote)) {
    return "provide_records";
  }
  if (pay && contact) {
    return "pay_or_contact";
  }
  if (/\b(review|breakdown|query)\b/i.test(quote)) {
    return "request_review";
  }
  if (contact) {
    return "contact_sender";
  }
  if (pay) {
    return "pay_stated_balance";
  }
  return "review_stated_obligation";
}

export function groundObligation(
  source: string,
  action: string,
  quote: string
): GroundedFact<ActionSummaryId> {
  const verification = verifyQuoteInSource(source, quote);
  const problem = quotationProblem(quote, verification);
  const summary = actionSummaryFromQuote(quote);
  if (problem) {
    return grounded(summary, quote, problem, verification);
  }
  if (quoteTruncatesSentence(source, quote)) {
    return grounded(summary, quote, "incomplete", verification);
  }
  if (CONTRADICTION.test(action) && !CONTRADICTION.test(quote)) {
    return grounded(summary, quote, "substring_only", verification);
  }
  if (quotedStatementOnly(source, quote)) {
    return grounded("review_stated_obligation", quote, "substring_only", verification);
  }
  const role = paymentSentenceRole(quote);
  if (role === "injected_command") {
    return grounded(summary, quote, "unverified", verification);
  }
  if (role === "ambiguous") {
    return grounded(summary, quote, "ambiguous", verification);
  }
  const disposition = obligationDisposition(quote);
  if (disposition === "ambiguous") {
    return grounded(summary, quote, disposition, verification);
  }
  if (role === "conditional_fee" || (role !== "current_balance" && role !== "reinstated_demand" && role !== "unsupported")) {
    return grounded(summary, quote, "substring_only", verification);
  }
  if (disposition) {
    return grounded(summary, quote, disposition, verification);
  }
  const amounts = amountValuesIn(quote);
  if (amounts.length > 1) {
    return grounded(summary, quote, "ambiguous", verification);
  }
  return grounded(summary, quote, "supports_claim", verification);
}

export function findMonetarySupport(source: string, value: number): GroundedFact<number> {
  const lines = source.split(/\n/).map((line) => line.replace(/\r$/, "").trim());
  let fallback: GroundedFact<number> | null = null;
  for (const line of lines) {
    if (!line) {
      continue;
    }
    const amounts = amountValuesIn(line);
    if (!amounts.some((amount) => sameAmount(amount, value))) {
      continue;
    }
    const groundedAmount = groundMonetaryAmount(source, value, line);
    if (groundedAmount.support === "supports_claim") {
      return groundedAmount;
    }
    fallback ??= groundedAmount;
  }
  return (
    fallback ??
    grounded<number>(value, null, "unverified", null)
  );
}

export function lineForAmount(text: string, amount: SourcedAmount): string | null {
  const start = text.lastIndexOf("\n", amount.index - 1) + 1;
  const endBreak = text.indexOf("\n", amount.index);
  const end = endBreak === -1 ? text.length : endBreak;
  const line = text.slice(start, end).replace(/\r$/, "").trim();
  return line.length > 0 ? line : null;
}

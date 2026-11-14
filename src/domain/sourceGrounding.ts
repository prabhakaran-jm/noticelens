import {
  distinctAmountValues,
  findExplicitGbpAmounts,
  type SourcedAmount,
} from "./amounts";
import { parseBillingWindow, parseCalendarDate } from "./dates";
import type { ActionSummaryId, QuoteVerificationResult } from "./types";
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

function figureContextNegated(quote: string): boolean {
  return (
    /\b(?:not|no longer|never)\s+(?:due|owed|payable)\b/i.test(quote) ||
    /£[\d,]+(?:\.\d+)?\s+is\s+not\b/i.test(quote) ||
    /\b(?:balance|amount|fee)\s+is\s+not\b/i.test(quote)
  );
}

function explicitlyCancelled(quote: string): boolean {
  return (
    /\b(?:has|have)\s+been\s+cancelled\b/i.test(quote) ||
    /\b(?:is|was|were|hereby|now)\s+cancelled\b/i.test(quote) ||
    /\bcancelled\s+(?:demand|notice|balance|payment|debt|request|charge|amount)\b/i.test(quote)
  );
}

function explicitlyWithdrawn(quote: string): boolean {
  if (/\b(?:has|have)\s+been\s+withdrawn\b/i.test(quote)) {
    return true;
  }
  if (/\b(?:is|was|were|hereby)\s+withdrawn\b/i.test(quote)) {
    return true;
  }
  return (
    /\bpayment\s+request\b[^.]{0,80}\bwithdrawn\b/i.test(quote) &&
    !/\bmay\s+be\s+withdrawn\b/i.test(quote)
  );
}

function explicitlyNegated(quote: string): boolean {
  return (
    figureContextNegated(quote) ||
    /\bdo\s+not\s+need\s+to\s+pay\b/i.test(quote) ||
    /\bdo\s+not\s+need\s+to\s+contact\b/i.test(quote) ||
    /\bdo\s+not\s+have\s+to\s+pay\b/i.test(quote) ||
    /\bpay\s+nothing\b/i.test(quote)
  );
}

function historicalPayment(quote: string): boolean {
  return (
    /\balready\s+paid\b/i.test(quote) ||
    /\balready\s+received\b/i.test(quote) ||
    /\bthank\s+you\s+for\s+(?:your\s+)?payment\b/i.test(quote) ||
    /\b(?:we|our records)\s+(?:have\s+)?received\s+(?:your\s+)?payment\b/i.test(quote) ||
    /\bpayment\b[^.]{0,48}\b(?:was|were|has been|have been)\s+received\b/i.test(quote)
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
  if (/\bignore\s+(?:all\s+|any\s+|the\s+)?previous\s+instructions\b/i.test(sentence)) {
    return true;
  }
  if (/\bdisregard\s+(?:the\s+)?(?:notice|text|instructions)\s+above\b/i.test(sentence)) {
    return true;
  }
  if (/\brecord\s+a\s+verified\s+balance\b/i.test(sentence)) {
    return true;
  }
  if (/\btreat\s+£[\d,]+\s+as\s+(?:the\s+)?verified\b/i.test(sentence)) {
    return true;
  }
  if (
    /\byou\s+are\s+now\b/i.test(sentence) &&
    /\b(?:admin|model|assistant|instruction|jailbreak)\b/i.test(sentence)
  ) {
    return true;
  }
  return /(?:^|\s)(?:system|assistant)\s*:/i.test(sentence);
}

function isConditionalFeeSentence(sentence: string): boolean {
  return (
    /\b(?:if|unless|may|might|could)\b/i.test(sentence) &&
    /\b(?:fee|surcharge|penalty)\b/i.test(sentence)
  );
}

function isReinstatement(sentence: string): boolean {
  if (/\bnothing\s+remains\s+payable\b/i.test(sentence)) {
    return false;
  }
  return (
    /\breinstat(?:e|ed|ement)\b/i.test(sentence) ||
    /\bdisregard\s+the\s+cancellation\b/i.test(sentence) ||
    /\bremains\s+payable\b/i.test(sentence)
  );
}

function isStructuralSettlement(sentence: string): boolean {
  const paymentNoun = /\b(?:balance|amount|charge|payment|debt|sum|account|demand|request)\b/i;
  const completed =
    (/\b(?:cleared|discharged|extinguished|settled|paid\s+off|completed)\b/i.test(sentence) &&
      paymentNoun.test(sentence)) ||
    /\bsettlement\s+of\b/i.test(sentence);
  const dutyNegated =
    /\b(?:need\s+not\s+pay|do\s+not\s+(?:have\s+to|need\s+to)\s+pay|must\s+pay\s+nothing|nothing\s+remains\s+payable|no\s+payment\s+to\s+make|no\s+longer\s+required|pay\s+nothing)\b/i.test(
      sentence
    );
  const disregard =
    /\b(?:disregard|ignore)\b/i.test(sentence) && /\b(?:balance|demand|request|pay)\b/i.test(sentence);
  const closed =
    /\bas\s+closed\b/i.test(sentence) ||
    (/\bis\s+closed\b/i.test(sentence) && paymentNoun.test(sentence)) ||
    (/\bnow\s+clear\b/i.test(sentence) && paymentNoun.test(sentence)) ||
    /\bno\s+balance\s+of\b/i.test(sentence);
  return completed || dutyNegated || disregard || closed;
}

function isPositiveCurrentBalance(sentence: string): boolean {
  if (/\b(?:no|not|never)\s+balance\b/i.test(sentence) || /\bno\s+longer\b/i.test(sentence)) {
    return false;
  }
  return (
    /\boutstanding\s+balance\b/i.test(sentence) ||
    /\bamount\s+due\b/i.test(sentence) ||
    /\bbalance\s+now\s+requested\b/i.test(sentence) ||
    /\bplease\s+pay\s+the\s+(?:outstanding\s+)?balance\b/i.test(sentence) ||
    (/\bmust\s+pay\b/i.test(sentence) && !/\bmust\s+pay\s+nothing\b/i.test(sentence)) ||
    /\bpayment\s+is\s+due\b/i.test(sentence)
  );
}

function detectBlockingRole(sentence: string): PaymentSentenceRole | null {
  if (historicalPayment(sentence)) {
    return "historical_payment";
  }
  if (/\bpaid\s+in\s+full\b/i.test(sentence)) {
    return "paid_in_full";
  }
  if (/\bwritten\s+off\b/i.test(sentence)) {
    return "written_off";
  }
  if (/\bwaiv(?:e|ed|er)\b/i.test(sentence)) {
    return "waived";
  }
  if (/\brefunded\b/i.test(sentence)) {
    return "refunded_payment";
  }
  if (explicitlyCancelled(sentence) || /\bcancel(?:s|led)?\s+the\s+demand\b/i.test(sentence)) {
    return "cancelled_demand";
  }
  if (explicitlyWithdrawn(sentence) || /\bdemand\s+is\s+withdrawn\b/i.test(sentence)) {
    return "withdrawn_demand";
  }
  if (isStructuralSettlement(sentence) || explicitlyNegated(sentence) || settledPayment(sentence)) {
    return "settled_or_negated";
  }
  return null;
}

export function paymentSentenceRole(sentence: string): PaymentSentenceRole {
  const text = sentence.trim();
  if (!text) {
    return "unsupported";
  }
  if (isInjectedCommand(text)) {
    return "injected_command";
  }
  if (isConditionalFeeSentence(text)) {
    return "conditional_fee";
  }
  const blocking = detectBlockingRole(text);
  const positive = isPositiveCurrentBalance(text);
  if (positive && blocking) {
    return "ambiguous";
  }
  if (blocking) {
    return blocking;
  }
  if (isReinstatement(text)) {
    return "reinstated_demand";
  }
  if (positive) {
    return "current_balance";
  }
  return "unsupported";
}

function quoteTruncatesSentence(source: string, quote: string): boolean {
  const trimmed = quote.trim();
  if (!trimmed || /\.{3}|…|\u2026/.test(trimmed) || /[.!?]["”']?$/.test(trimmed)) {
    return false;
  }
  const index = source.indexOf(trimmed);
  if (index < 0) {
    return false;
  }
  const after = source.slice(index + trimmed.length);
  if (!after.trim() || /^\s*[.!?]/.test(after) || /^\s*\n/.test(after)) {
    return false;
  }
  return true;
}

function noticeSentences(text: string): string[] {
  const sentences: string[] = [];
  for (const line of text.split(/\n/)) {
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed) {
      continue;
    }
    for (const part of trimmed.split(/(?<=[.!?])\s+(?=[A-Z"“])/)) {
      const sentence = part.trim();
      if (sentence) {
        sentences.push(sentence);
      }
    }
  }
  return sentences;
}

function sameAmount(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.001;
}

/**
 * Figures that survive as the current outstanding balance.
 * A terminal account settlement is not undone by repeating an amount the
 * notice had already introduced. A later positive balance after a named
 * cancellation, or a different later amount, can remain.
 */
export function resolvedCurrentBalanceAmounts(text: string): number[] {
  const sentences = noticeSentences(text);
  let lastUnscopedTerminal = -1;
  const introducedAtTerminal = new Set<number>();
  const lastScopedTerminal = new Map<number, number>();
  let lastUnscopedRetirement = -1;
  const lastScopedRetirement = new Map<number, number>();
  let lastUnscopedHistorical = -1;
  const lastScopedHistorical = new Map<number, number>();
  const lastPositive = new Map<number, number>();
  const lastReinstatement = new Map<number, number>();
  const seen = new Set<number>();

  sentences.forEach((sentence, index) => {
    const amounts = amountValuesIn(sentence);
    for (const amount of amounts) {
      seen.add(amount);
    }
    const role = paymentSentenceRole(sentence);
    if (
      role === "injected_command" ||
      role === "conditional_fee" ||
      role === "ambiguous" ||
      role === "unsupported"
    ) {
      return;
    }
    if (role === "reinstated_demand") {
      const targets = amounts.length > 0 ? amounts : [...seen];
      for (const amount of targets) {
        lastReinstatement.set(amount, index);
        lastPositive.set(amount, index);
      }
      return;
    }
    if (role === "historical_payment") {
      if (amounts.length === 0) {
        lastUnscopedHistorical = index;
      } else {
        for (const amount of amounts) {
          lastScopedHistorical.set(amount, index);
        }
      }
      return;
    }
    if (TERMINAL_ACCOUNT_ROLES.has(role)) {
      if (amounts.length === 0) {
        lastUnscopedTerminal = index;
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
      for (const amount of amounts) {
        lastPositive.set(amount, index);
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
  return current;
}

export function sentenceSupportsResponseDeadline(
  sentence: string,
  resolved: readonly number[]
): boolean {
  const role = paymentSentenceRole(sentence);
  if (
    role === "conditional_fee" ||
    role === "injected_command" ||
    role === "ambiguous" ||
    role === "historical_payment" ||
    TERMINAL_ACCOUNT_ROLES.has(role) ||
    DEMAND_RETIREMENT_ROLES.has(role)
  ) {
    return false;
  }
  if (role === "current_balance" || role === "reinstated_demand") {
    if (resolved.length !== 1) {
      return false;
    }
    const amounts = amountValuesIn(sentence);
    return amounts.length === 0 || amounts.every((amount) => resolved.some((item) => sameAmount(item, amount)));
  }
  return /\b(?:by|deadline|due|no later than|respond)\b/i.test(sentence);
}

export function paymentQuoteUndermined(
  quote: string,
  actionSummary: string,
  resolved: readonly number[]
): boolean {
  const payment = actionSummary === "pay_stated_balance" || actionSummary === "pay_or_contact";
  if (!payment) {
    return false;
  }
  const role = paymentSentenceRole(quote);
  if (
    role === "conditional_fee" ||
    role === "injected_command" ||
    role === "ambiguous" ||
    role === "historical_payment" ||
    TERMINAL_ACCOUNT_ROLES.has(role) ||
    DEMAND_RETIREMENT_ROLES.has(role)
  ) {
    return true;
  }
  if (role !== "current_balance" && role !== "reinstated_demand") {
    return false;
  }
  if (resolved.length > 1) {
    return true;
  }
  const amounts = amountValuesIn(quote);
  if (resolved.length !== 1) {
    return amounts.length > 0 || role === "current_balance" || role === "reinstated_demand";
  }
  return amounts.some((amount) => !resolved.some((item) => sameAmount(item, amount)));
}

function settledPayment(quote: string): boolean {
  return (
    /\bpaid\s+in\s+full\b/i.test(quote) ||
    /\bwritten\s+off\b/i.test(quote) ||
    /\bno\s+longer\s+required\b/i.test(quote) ||
    /\b(?:was|were|is|are|has been|have been|hereby|now)\s+waived\b/i.test(quote) ||
    /\b(?:was|were|is|are|has been|have been|hereby|now)\s+refunded\b/i.test(quote) ||
    /\brefunded\s+in\s+full\b/i.test(quote) ||
    /\b(?:please\s+)?(?:ignore|disregard)\b[^.]{0,80}\brequest\s+to\s+pay\b/i.test(quote)
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
  if (role === "conditional_fee" || (role !== "current_balance" && role !== "reinstated_demand" && role !== "unsupported")) {
    return grounded(summary, quote, "substring_only", verification);
  }
  const disposition = obligationDisposition(quote);
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

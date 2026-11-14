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
  const disposition = obligationDisposition(quote ?? "");
  if (disposition) {
    return grounded(amount, quote, disposition, verification);
  }
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
  if (CONTRADICTION.test(action) && !CONTRADICTION.test(quote)) {
    return grounded(summary, quote, "substring_only", verification);
  }
  if (quotedStatementOnly(source, quote)) {
    return grounded("review_stated_obligation", quote, "substring_only", verification);
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
    if (!amounts.some((amount) => Math.abs(amount - value) < 0.001)) {
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

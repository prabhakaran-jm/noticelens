import {
  assessIssueDate,
  classifyDeadline,
  diffCalendarDays,
  parseCalendarDate,
  type ClassifiedDeadline,
  type IssueDateAssessment,
} from "./dates";
import type { QuoteVerificationResult } from "./types";
import { verifyQuoteInSource } from "./verifyQuotes";

export type ComparisonStatus =
  | "changed"
  | "unchanged"
  | "omitted_in_revised"
  | "added_in_revised"
  | "not_stated"
  | "conflicting";

export interface ComparableNoticeFacts {
  rawText: string;
  issueDate: string | null;
  issueDateQuote: string | null;
  amountGBP: number | null;
  amountQuote: string | null;
  amountConflict: boolean;
  responseDeadline: string | null;
  responseDeadlines: string[];
  deadlineQuote: string | null;
  deadlineConflict: boolean;
  billingPeriod: string | null;
  billingPeriodQuote: string | null;
  statedAction: string | null;
  actionQuote: string | null;
}

interface VerifiedSide<T> {
  value: T | null;
  quote: string | null;
  verification: QuoteVerificationResult | null;
}

export interface NoticeComparison {
  amount: VerifiedSide<number> & {
    revised: number | null;
    revisedQuote: string | null;
    revisedVerification: QuoteVerificationResult | null;
    differenceGBP: number | null;
    status: ComparisonStatus;
  };
  responseDeadline: VerifiedSide<string> & {
    revised: string | null;
    revisedQuote: string | null;
    revisedVerification: QuoteVerificationResult | null;
    originalDates: string[];
    revisedDates: string[];
    laterByCalendarDays: number | null;
    status: ComparisonStatus;
    originalClassification: ClassifiedDeadline | null;
    revisedClassification: ClassifiedDeadline | null;
  };
  billingPeriod: VerifiedSide<string> & {
    revised: string | null;
    revisedQuote: string | null;
    revisedVerification: QuoteVerificationResult | null;
    omittedInRevised: boolean;
    status: ComparisonStatus;
    omissionNote: string | null;
    omissionPrompt: string | null;
  };
  statedAction: VerifiedSide<string> & {
    revised: string | null;
    revisedQuote: string | null;
    revisedVerification: QuoteVerificationResult | null;
    status: ComparisonStatus;
  };
  issueDate: {
    original: string | null;
    revised: string | null;
    originalQuote: string | null;
    revisedQuote: string | null;
    originalVerification: QuoteVerificationResult | null;
    revisedVerification: QuoteVerificationResult | null;
    originalAssessment: IssueDateAssessment | null;
    revisedAssessment: IssueDateAssessment | null;
    status: ComparisonStatus;
  };
}

const MONTH =
  "January|February|March|April|May|June|July|August|September|October|November|December";

function lineContaining(text: string, needle: string): string | null {
  const index = text.indexOf(needle);
  if (index < 0) {
    return null;
  }
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const endBreak = text.indexOf("\n", index);
  const end = endBreak === -1 ? text.length : endBreak;
  return text.slice(start, end).replace(/\r$/, "");
}

function parseGbp(raw: string): number | null {
  const normalized = raw.replace(/,/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return null;
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function uniqueAmounts(
  text: string,
  pattern: RegExp
): Array<{ value: number; index: number; raw: string }> {
  const found: Array<{ value: number; index: number; raw: string }> = [];
  for (const match of text.matchAll(pattern)) {
    const raw = match[1];
    if (!raw || match.index === undefined) {
      continue;
    }
    const value = parseGbp(raw);
    if (value === null) {
      continue;
    }
    found.push({ value, index: match.index, raw: match[0] });
  }
  return found;
}

function extractAmount(text: string): {
  amountGBP: number | null;
  amountQuote: string | null;
  amountConflict: boolean;
} {
  const preferred = [
    /balance now requested is £\s*([0-9][0-9,]*(?:\.\d{1,2})?)/gi,
    /outstanding balance of £\s*([0-9][0-9,]*(?:\.\d{1,2})?)/gi,
    /totalling £\s*([0-9][0-9,]*(?:\.\d{1,2})?)/gi,
    /balance of £\s*([0-9][0-9,]*(?:\.\d{1,2})?)/gi,
    /(?:please pay|pay) £\s*([0-9][0-9,]*(?:\.\d{1,2})?)/gi,
  ];
  for (const pattern of preferred) {
    const matches = uniqueAmounts(text, pattern);
    if (matches.length === 0) {
      continue;
    }
    const distinct = [...new Set(matches.map((item) => item.value))];
    if (distinct.length !== 1) {
      return { amountGBP: null, amountQuote: null, amountConflict: true };
    }
    const first = matches[0]!;
    return {
      amountGBP: first.value,
      amountQuote: lineContaining(text, first.raw),
      amountConflict: false,
    };
  }

  const any = uniqueAmounts(text, /£\s*([0-9][0-9,]*(?:\.\d{1,2})?)/gi);
  const distinct = [...new Set(any.map((item) => item.value))];
  if (distinct.length === 1 && any[0]) {
    return {
      amountGBP: any[0].value,
      amountQuote: lineContaining(text, any[0].raw),
      amountConflict: false,
    };
  }
  if (distinct.length > 1) {
    return { amountGBP: null, amountQuote: null, amountConflict: true };
  }
  return { amountGBP: null, amountQuote: null, amountConflict: false };
}

function extractDeadlines(text: string): {
  responseDeadline: string | null;
  responseDeadlines: string[];
  deadlineQuote: string | null;
  deadlineConflict: boolean;
} {
  const written: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(new RegExp(`\\bby\\s+(\\d{1,2}\\s+(?:${MONTH})\\s+\\d{4})\\b`, "gi"))) {
    const token = match[1];
    if (!token) {
      continue;
    }
    const parsed = parseCalendarDate(token);
    const key = parsed?.iso ?? token.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    written.push(token);
  }
  if (written.length === 0) {
    return {
      responseDeadline: null,
      responseDeadlines: [],
      deadlineQuote: null,
      deadlineConflict: false,
    };
  }
  if (written.length > 1) {
    return {
      responseDeadline: null,
      responseDeadlines: written,
      deadlineQuote: null,
      deadlineConflict: true,
    };
  }
  const only = written[0]!;
  return {
    responseDeadline: only,
    responseDeadlines: written,
    deadlineQuote: lineContaining(text, `by ${only}`),
    deadlineConflict: false,
  };
}

function extractBillingPeriod(text: string): {
  billingPeriod: string | null;
  billingPeriodQuote: string | null;
} {
  const patterns = [
    new RegExp(`between\\s+((?:${MONTH})\\s+and\\s+(?:${MONTH})\\s+\\d{4})`, "i"),
    new RegExp(
      `between\\s+(\\d{1,2}\\s+(?:${MONTH})\\s+\\d{4}\\s+and\\s+\\d{1,2}\\s+(?:${MONTH})\\s+\\d{4})`,
      "i"
    ),
    new RegExp(
      `covering\\s+(\\d{1,2}\\s+(?:${MONTH})\\s+\\d{4}\\s+to\\s+\\d{1,2}\\s+(?:${MONTH})\\s+\\d{4})`,
      "i"
    ),
    new RegExp(`billing period\\s+((?:${MONTH})\\s+to\\s+(?:${MONTH})\\s+\\d{4})`, "i"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const period = match?.[1]?.trim();
    if (!period) {
      continue;
    }
    return { billingPeriod: period, billingPeriodQuote: lineContaining(text, period) };
  }
  return { billingPeriod: null, billingPeriodQuote: null };
}

function statedActionLabel(sentence: string): string {
  const pay = /\bpay\b/i.test(sentence);
  const contact = /\bcontact\b/i.test(sentence);
  const questions = /\bquestions\b/i.test(sentence);
  if (pay && contact) {
    return "Pay balance or contact billing team";
  }
  if (contact && questions) {
    return "Contact billing team if you have questions";
  }
  if (contact) {
    return "Contact the sender";
  }
  if (pay) {
    return "Pay the stated balance";
  }
  return sentence.trim();
}

function extractIssueDate(text: string): { issueDate: string | null; issueDateQuote: string | null } {
  const preamble = text.split(/\bDear\b/i)[0] ?? text;
  const match = new RegExp(`\\b(\\d{1,2}\\s+(?:${MONTH})\\s+\\d{4})\\b`, "i").exec(preamble);
  const token = match?.[1];
  if (!token || !parseCalendarDate(token)) {
    return { issueDate: null, issueDateQuote: null };
  }
  return { issueDate: token, issueDateQuote: token };
}

export function extractComparableFacts(rawText: string): ComparableNoticeFacts {
  const amount = extractAmount(rawText);
  const deadlines = extractDeadlines(rawText);
  const period = extractBillingPeriod(rawText);
  const issue = extractIssueDate(rawText);
  const lines = rawText
    .split(/\n/)
    .map((line) => line.replace(/\r$/, "").trim())
    .filter((line) => line.length > 0);
  const actionLine =
    lines.find((line) => /^please\b/i.test(line)) ??
    lines.find((line) => new RegExp(`\\bby\\s+\\d{1,2}\\s+(?:${MONTH})\\s+\\d{4}\\b`, "i").test(line));
  return {
    rawText,
    ...issue,
    ...amount,
    ...deadlines,
    ...period,
    statedAction: actionLine ? statedActionLabel(actionLine) : null,
    actionQuote: actionLine ?? null,
  };
}

function verify(source: string, quote: string | null): QuoteVerificationResult | null {
  if (!quote) {
    return null;
  }
  return verifyQuoteInSource(source, quote);
}

function periodStated(value: string | null): boolean {
  return Boolean(value && !/^not stated$/i.test(value.trim()));
}

function textStatus(original: string | null, revised: string | null): ComparisonStatus {
  const left = periodStated(original) ? original!.trim() : null;
  const right = periodStated(revised) ? revised!.trim() : null;
  if (!left && !right) {
    return "not_stated";
  }
  if (left && !right) {
    return "omitted_in_revised";
  }
  if (!left && right) {
    return "added_in_revised";
  }
  return left!.toLowerCase() === right!.toLowerCase() ? "unchanged" : "changed";
}

function formatGbp(amount: number): string {
  const cents = Math.round(amount * 100);
  const whole = cents % 100 === 0;
  const body = whole
    ? Math.trunc(cents / 100).toLocaleString("en-GB")
    : (cents / 100).toLocaleString("en-GB", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
  return `£${body}`;
}

function differenceGBP(original: number | null, revised: number | null): number | null {
  if (original === null || revised === null) {
    return null;
  }
  return (Math.round(revised * 100) - Math.round(original * 100)) / 100;
}

export function compareNotices(
  original: ComparableNoticeFacts,
  revised: ComparableNoticeFacts,
  options?: { today?: string }
): NoticeComparison {
  const today = options?.today;
  const amountStatus: ComparisonStatus = original.amountConflict || revised.amountConflict
    ? "conflicting"
    : original.amountGBP === null && revised.amountGBP === null
      ? "not_stated"
      : original.amountGBP !== null && revised.amountGBP === null
        ? "omitted_in_revised"
        : original.amountGBP === null && revised.amountGBP !== null
          ? "added_in_revised"
          : original.amountGBP === revised.amountGBP
            ? "unchanged"
            : "changed";

  const deadlineStatus: ComparisonStatus =
    original.deadlineConflict || revised.deadlineConflict
      ? "conflicting"
      : textStatus(original.responseDeadline, revised.responseDeadline);

  let laterByCalendarDays: number | null = null;
  if (
    deadlineStatus !== "conflicting" &&
    original.responseDeadline &&
    revised.responseDeadline
  ) {
    const from = parseCalendarDate(original.responseDeadline);
    const to = parseCalendarDate(revised.responseDeadline);
    if (from && to) {
      laterByCalendarDays = diffCalendarDays(to, from);
    }
  }

  const billingStatus = textStatus(original.billingPeriod, revised.billingPeriod);
  const omittedInRevised = billingStatus === "omitted_in_revised";

  return {
    amount: {
      value: original.amountConflict ? null : original.amountGBP,
      quote: original.amountQuote,
      verification: verify(original.rawText, original.amountQuote),
      revised: revised.amountConflict ? null : revised.amountGBP,
      revisedQuote: revised.amountQuote,
      revisedVerification: verify(revised.rawText, revised.amountQuote),
      differenceGBP:
        amountStatus === "conflicting"
          ? null
          : differenceGBP(original.amountGBP, revised.amountGBP),
      status: amountStatus,
    },
    responseDeadline: {
      value: original.responseDeadline,
      quote: original.deadlineQuote,
      verification: verify(original.rawText, original.deadlineQuote),
      revised: revised.responseDeadline,
      revisedQuote: revised.deadlineQuote,
      revisedVerification: verify(revised.rawText, revised.deadlineQuote),
      originalDates: original.responseDeadlines,
      revisedDates: revised.responseDeadlines,
      laterByCalendarDays,
      status: deadlineStatus,
      originalClassification: today
        ? classifyDeadline(
            original.deadlineConflict
              ? original.responseDeadlines.join(" or ")
              : original.responseDeadline,
            today
          )
        : null,
      revisedClassification: today
        ? classifyDeadline(
            revised.deadlineConflict
              ? revised.responseDeadlines.join(" or ")
              : revised.responseDeadline,
            today
          )
        : null,
    },
    billingPeriod: {
      value: periodStated(original.billingPeriod) ? original.billingPeriod : null,
      quote: original.billingPeriodQuote,
      verification: verify(original.rawText, original.billingPeriodQuote),
      revised: periodStated(revised.billingPeriod) ? revised.billingPeriod : null,
      revisedQuote: revised.billingPeriodQuote,
      revisedVerification: verify(revised.rawText, revised.billingPeriodQuote),
      omittedInRevised,
      status: billingStatus,
      omissionNote: omittedInRevised ? "Not stated in revised notice" : null,
      omissionPrompt: omittedInRevised
        ? `The revised statement does not state which supply dates the ${
            revised.amountGBP === null ? "revised amount" : formatGbp(revised.amountGBP)
          } covers — consider asking the supplier to confirm in writing`
        : null,
    },
    statedAction: {
      value: original.statedAction,
      quote: original.actionQuote,
      verification: verify(original.rawText, original.actionQuote),
      revised: revised.statedAction,
      revisedQuote: revised.actionQuote,
      revisedVerification: verify(revised.rawText, revised.actionQuote),
      status: textStatus(original.statedAction, revised.statedAction),
    },
    issueDate: {
      original: original.issueDate,
      revised: revised.issueDate,
      originalQuote: original.issueDateQuote,
      revisedQuote: revised.issueDateQuote,
      originalVerification: verify(original.rawText, original.issueDateQuote),
      revisedVerification: verify(revised.rawText, revised.issueDateQuote),
      originalAssessment: today ? assessIssueDate(original.issueDate, today) : null,
      revisedAssessment: today ? assessIssueDate(revised.issueDate, today) : null,
      status: textStatus(original.issueDate, revised.issueDate),
    },
  };
}

export function compareNoticeTexts(
  originalText: string,
  revisedText: string,
  options?: { today?: string }
): NoticeComparison {
  return compareNotices(
    extractComparableFacts(originalText),
    extractComparableFacts(revisedText),
    options
  );
}

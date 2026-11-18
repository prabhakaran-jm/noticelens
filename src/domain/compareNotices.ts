import {
  assessIssueDate,
  classifyDeadline,
  diffCalendarDays,
  parseCalendarDate,
  type ClassifiedDeadline,
  type IssueDateAssessment,
} from "./dates";
import type { NoticeEligibility } from "./eligibility";
import {
  eligibilityAndBalance,
  extractCorrespondenceDeadlineIsos,
  extractIssueDateCandidateInSpan,
  extractPaymentDeadlineIso,
  groundBillingPeriod,
  groundCalendarDate,
  groundMonetaryAmount,
  groundObligation,
  isReportedOrPriorInstruction,
  noticeSentenceSpans,
  type ClaimSupport,
  type NoticeSentenceSpan,
  type SourceAmountAuthority,
} from "./sourceGrounding";
import { claimIdentityFacets, introducesHistoricalCopy } from "./supportedNoticePolicy";
import { introducesParagraphFrame, introducesUntrustedFrame } from "./supportedStructures";
import type { QuoteVerificationResult } from "./types";
import { verifyQuoteInSource } from "./verifyQuotes";

export type ComparisonRelationship =
  | "COMPARABLE"
  | "NOT_COMPARABLE"
  | "RELATIONSHIP_UNVERIFIED"
  | "BALANCE_UNVERIFIED";

export type DeadlineRole = "payment" | "contact";

/** Local identity facets. These are not copied into v2, logs, or a cloud payload. */
export interface NoticeIdentityFacets {
  accounts: string[];
  invoices: string[];
  fuels: string[];
  periods: string[];
}

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
  amountsGBP: number[];
  amountQuote: string | null;
  amountConflict: boolean;
  amountRejected: boolean;
  amountAuthority: SourceAmountAuthority;
  responseDeadline: string | null;
  responseDeadlines: string[];
  deadlineQuote: string | null;
  deadlineConflict: boolean;
  billingPeriod: string | null;
  billingPeriodQuote: string | null;
  statedAction: string | null;
  actionQuote: string | null;
  groundedIssueDate: string | null;
  groundedIssueDateQuote: string | null;
  groundedIssueDateIso: string | null;
  groundedIssueDateAuthority: SourceAmountAuthority;
  groundedDeadline: string | null;
  groundedDeadlineQuote: string | null;
  groundedDeadlineIso: string | null;
  groundedDeadlineRole: DeadlineRole | null;
  groundedDeadlineAuthority: SourceAmountAuthority;
  identity: NoticeIdentityFacets;
}

interface VerifiedSide<T> {
  value: T | null;
  quote: string | null;
  verification: QuoteVerificationResult | null;
  /** Substring existence and claim support are separate. */
  substringExists: boolean;
  support: ClaimSupport;
  verifiedForDisplay: T | null;
}

export interface NoticeComparison {
  relationship: ComparisonRelationship;
  relationshipReason: string;
  /** Present for local tests and the Compare screen. Not a cloud field. */
  localIdentity: {
    original: NoticeIdentityFacets;
    revised: NoticeIdentityFacets;
  };
  amount: VerifiedSide<number> & {
    revised: number | null;
    revisedQuote: string | null;
    revisedVerification: QuoteVerificationResult | null;
    differenceGBP: number | null;
    status: ComparisonStatus;
    originalAuthority: SourceAmountAuthority;
    revisedAuthority: SourceAmountAuthority;
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
    originalRole: DeadlineRole | null;
    revisedRole: DeadlineRole | null;
    originalAuthority: SourceAmountAuthority;
    revisedAuthority: SourceAmountAuthority;
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
    substringExists: boolean;
    support: ClaimSupport;
    verifiedForDisplay: string | null;
    originalAssessment: IssueDateAssessment | null;
    revisedAssessment: IssueDateAssessment | null;
    originalAuthority: SourceAmountAuthority;
    revisedAuthority: SourceAmountAuthority;
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

function extractAmount(verified: {
  amountGBP: number | null;
  quote: string | null;
  authority: SourceAmountAuthority;
}): {
  amountGBP: number | null;
  amountsGBP: number[];
  amountQuote: string | null;
  amountConflict: boolean;
  amountRejected: boolean;
  amountAuthority: SourceAmountAuthority;
} {
  return {
    amountGBP: verified.amountGBP,
    amountsGBP: verified.amountGBP === null ? [] : [verified.amountGBP],
    amountQuote: verified.quote,
    amountConflict: verified.authority === "conflicting",
    amountRejected: verified.authority === "needs_review",
    amountAuthority: verified.authority,
  };
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
  const assessed = eligibilityAndBalance(rawText);
  const amount = extractAmount(assessed.balance);
  const deadlines = extractDeadlines(rawText);
  const period = extractBillingPeriod(rawText);
  const issue = extractIssueDate(rawText);
  const grounded = groundedDates(rawText, assessed.eligibility);
  const lines = rawText
    .split(/\n/)
    .map((line) => line.replace(/\r$/, "").trim())
    .filter((line) => line.length > 0);
  const pieces = rawText
    .split(/(?<=[.!?])\s+/)
    .map((piece) => piece.replace(/\s+/g, " ").trim())
    .filter((piece) => piece.length > 0);
  const actionLine =
    lines.find((line) => /^please\b/i.test(line)) ??
    pieces.find((piece) => /^please\b/i.test(piece)) ??
    lines.find((line) => new RegExp(`\\bby\\s+\\d{1,2}\\s+(?:${MONTH})\\s+\\d{4}\\b`, "i").test(line));
  return {
    rawText,
    ...issue,
    ...amount,
    ...deadlines,
    ...period,
    statedAction: actionLine ? statedActionLabel(actionLine) : null,
    actionQuote: actionLine ?? null,
    ...grounded,
    identity: localIdentityForNotice(rawText),
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

function supportFields<T>(
  source: string,
  value: T | null,
  quote: string | null,
  support: ClaimSupport
): Pick<VerifiedSide<T>, "substringExists" | "support" | "verifiedForDisplay"> {
  const verification = quote ? verifyQuoteInSource(source, quote) : null;
  return {
    substringExists: verification?.verified === true,
    support,
    verifiedForDisplay: support === "supports_claim" ? value : null,
  };
}

function amountSupport(
  source: string,
  amount: number | null,
  quote: string | null,
  conflict: boolean,
  rejected: boolean
): Pick<VerifiedSide<number>, "substringExists" | "support" | "verifiedForDisplay"> {
  if (conflict || rejected) {
    return supportFields(source, null, quote, conflict ? "ambiguous" : "insufficient");
  }
  const grounded = groundMonetaryAmount(source, amount, quote);
  return supportFields(source, grounded.verifiedForDisplay, quote, grounded.support);
}

function dateSupport(
  source: string,
  claimed: string | null,
  quote: string | null,
  conflict: boolean
): Pick<VerifiedSide<string>, "substringExists" | "support" | "verifiedForDisplay"> {
  if (conflict) {
    return supportFields(source, null, quote, "ambiguous");
  }
  const grounded = groundCalendarDate(source, claimed, quote);
  return supportFields(
    source,
    grounded.support === "supports_claim" ? claimed : null,
    quote,
    grounded.support
  );
}

function periodSupport(
  source: string,
  claimed: string | null,
  quote: string | null
): Pick<VerifiedSide<string>, "substringExists" | "support" | "verifiedForDisplay"> {
  const grounded = groundBillingPeriod(source, claimed, quote);
  return supportFields(source, grounded.verifiedForDisplay, quote, grounded.support);
}

function actionSupport(
  source: string,
  action: string | null,
  quote: string | null
): Pick<VerifiedSide<string>, "substringExists" | "support" | "verifiedForDisplay"> {
  if (!action || !quote) {
    return supportFields(source, null, quote, "missing");
  }
  const grounded = groundObligation(source, action, quote);
  return supportFields(
    source,
    grounded.support === "supports_claim" ? action : null,
    quote,
    grounded.support
  );
}

function differenceGBP(original: number | null, revised: number | null): number | null {
  if (original === null || revised === null) {
    return null;
  }
  return (Math.round(revised * 100) - Math.round(original * 100)) / 100;
}

const PERIOD_PATTERNS = [
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

function periodInSentence(sentence: string): string | null {
  for (const pattern of PERIOD_PATTERNS) {
    const match = pattern.exec(sentence);
    const period = match?.[1]?.trim().replace(/\s+/g, " ").toLowerCase();
    if (period) {
      return period;
    }
  }
  return null;
}

function acceptingSpans(text: string): NoticeSentenceSpan[] {
  const spans = noticeSentenceSpans(text);
  const accepted: NoticeSentenceSpan[] = [];
  let framed = false;
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index]!;
    if (index > 0) {
      const gap = text.slice(spans[index - 1]!.end, span.start);
      if (/\n\s*\n/.test(gap)) {
        framed = false;
      }
    }
    const header = span.precedingHeaderLine ?? "";
    if (
      introducesParagraphFrame(span.norm) ||
      introducesHistoricalCopy(span.norm) ||
      (header.length > 0 && (introducesParagraphFrame(header) || introducesHistoricalCopy(header)))
    ) {
      framed = true;
    }
    if (
      framed ||
      introducesUntrustedFrame(span.norm) ||
      (header.length > 0 && introducesUntrustedFrame(header)) ||
      isReportedOrPriorInstruction(span.raw)
    ) {
      continue;
    }
    accepted.push(span);
  }
  return accepted;
}

export function localIdentityForNotice(text: string): NoticeIdentityFacets {
  const accounts = new Set<string>();
  const invoices = new Set<string>();
  const fuels = new Set<string>();
  const periods = new Set<string>();
  for (const span of acceptingSpans(text)) {
    const facets = claimIdentityFacets(span.raw);
    if (facets.account) {
      accounts.add(facets.account);
    }
    if (facets.invoice) {
      invoices.add(facets.invoice);
    }
    if (facets.fuel) {
      fuels.add(facets.fuel);
    }
    const period = periodInSentence(span.raw);
    if (period) {
      periods.add(period);
    }
  }
  return {
    accounts: [...accounts].sort(),
    invoices: [...invoices].sort(),
    fuels: [...fuels].sort(),
    periods: [...periods].sort(),
  };
}

function singleFacet(values: readonly string[]): string | null {
  return values.length === 1 ? values[0]! : null;
}

function facetsDiffer(left: readonly string[], right: readonly string[]): boolean {
  const first = singleFacet(left);
  const second = singleFacet(right);
  return first !== null && second !== null && first !== second;
}

function facetsMatch(left: readonly string[], right: readonly string[]): boolean {
  const first = singleFacet(left);
  const second = singleFacet(right);
  return first !== null && first === second;
}

function quoteIsInstalment(quote: string | null): boolean {
  return Boolean(quote && /\b(?:instalments?|per\s+month|a\s+month|monthly)\b/i.test(quote));
}

export function decideComparisonRelationship(
  original: NoticeIdentityFacets,
  revised: NoticeIdentityFacets,
  originalAuthority: SourceAmountAuthority,
  revisedAuthority: SourceAmountAuthority,
  originalQuote: string | null,
  revisedQuote: string | null
): { relationship: ComparisonRelationship; reason: string } {
  if (originalAuthority !== "verified" || revisedAuthority !== "verified") {
    return { relationship: "BALANCE_UNVERIFIED", reason: "balance_unverified" };
  }
  if (quoteIsInstalment(originalQuote) !== quoteIsInstalment(revisedQuote)) {
    return { relationship: "NOT_COMPARABLE", reason: "instalment_versus_total" };
  }
  if (facetsDiffer(original.accounts, revised.accounts)) {
    return { relationship: "NOT_COMPARABLE", reason: "different_account" };
  }
  if (facetsDiffer(original.fuels, revised.fuels)) {
    return { relationship: "NOT_COMPARABLE", reason: "different_fuel" };
  }
  if (facetsDiffer(original.periods, revised.periods)) {
    return { relationship: "NOT_COMPARABLE", reason: "different_period" };
  }
  if (facetsDiffer(original.invoices, revised.invoices)) {
    return { relationship: "RELATIONSHIP_UNVERIFIED", reason: "different_invoice_unresolved" };
  }
  if (facetsMatch(original.invoices, revised.invoices)) {
    return { relationship: "COMPARABLE", reason: "same_invoice" };
  }
  if (
    facetsMatch(original.accounts, revised.accounts) &&
    facetsMatch(original.fuels, revised.fuels) &&
    facetsMatch(original.periods, revised.periods)
  ) {
    return { relationship: "COMPARABLE", reason: "same_account_fuel_period" };
  }
  if (facetsMatch(original.accounts, revised.accounts)) {
    return { relationship: "RELATIONSHIP_UNVERIFIED", reason: "shared_account_only" };
  }
  if (facetsMatch(original.fuels, revised.fuels)) {
    return { relationship: "RELATIONSHIP_UNVERIFIED", reason: "shared_fuel_only" };
  }
  return { relationship: "RELATIONSHIP_UNVERIFIED", reason: "missing_identity" };
}

function writtenDeadline(
  text: string,
  iso: string,
  role: DeadlineRole
): { stated: string; quote: string } | null {
  const tokenPattern = /\b(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+\d{4}|\d{4}-\d{2}-\d{2})\b/g;
  for (const span of acceptingSpans(text)) {
    const matchesRole =
      role === "payment"
        ? extractPaymentDeadlineIso(span.raw) === iso
        : extractCorrespondenceDeadlineIsos(span.raw).includes(iso);
    if (!matchesRole) {
      continue;
    }
    for (const match of span.raw.matchAll(tokenPattern)) {
      const token = match[1]?.replace(/(\d{1,2})(?:st|nd|rd|th)\b/i, "$1");
      if (token && parseCalendarDate(token)?.iso === iso) {
        return { stated: token, quote: span.raw };
      }
    }
  }
  return null;
}

const BALANCE_DEADLINE_REASONS = new Set(["current_balance", "explicit_reinstatement", "distinct_new_charge"]);

function groundedDates(text: string, eligibility: NoticeEligibility): Pick<
  ComparableNoticeFacts,
  | "groundedIssueDate"
  | "groundedIssueDateQuote"
  | "groundedIssueDateIso"
  | "groundedIssueDateAuthority"
  | "groundedDeadline"
  | "groundedDeadlineQuote"
  | "groundedDeadlineIso"
  | "groundedDeadlineRole"
  | "groundedDeadlineAuthority"
> {
  const spans = noticeSentenceSpans(text);
  const candidates = spans
    .map((span) => {
      const blocked = eligibility.decisions.some(
        (item) => item.evidence.sentenceIndex === span.sentenceIndex && item.reason === "model_directed"
      );
      return extractIssueDateCandidateInSpan(text, span, blocked);
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
  const distinctIssue = [...new Set(candidates.map((item) => item.iso))];
  let groundedIssueDate: string | null = null;
  let groundedIssueDateQuote: string | null = null;
  let groundedIssueDateIso: string | null = null;
  let groundedIssueDateAuthority: SourceAmountAuthority = "not_stated";
  if (eligibility.issueDateConflict || distinctIssue.length > 1) {
    groundedIssueDateAuthority = "conflicting";
  } else if (distinctIssue.length === 1) {
    const iso = distinctIssue[0]!;
    const eligible = eligibility.decisions.some(
      (item) => item.status === "ELIGIBLE" && item.reason === "issue_date" && item.dateIso === iso
    );
    const candidate = candidates.find((item) => item.iso === iso);
    if (eligible && candidate) {
      groundedIssueDate = candidate.stated;
      groundedIssueDateQuote = candidate.quote;
      groundedIssueDateIso = iso;
      groundedIssueDateAuthority = "verified";
    } else {
      groundedIssueDateAuthority = "needs_review";
    }
  } else if (
    eligibility.decisions.some(
      (item) =>
        item.reason === "issue_date" ||
        item.reason === "conflicting_issue_dates" ||
        item.reason === "wrong_date_role"
    )
  ) {
    groundedIssueDateAuthority = "needs_review";
  }

  const issueIso = groundedIssueDateAuthority === "verified" ? groundedIssueDateIso : null;
  const paymentIsos = [
    ...new Set(
      eligibility.decisions
        .filter(
          (item) =>
            item.status === "ELIGIBLE" &&
            item.amount !== null &&
            BALANCE_DEADLINE_REASONS.has(item.reason) &&
            item.deadlineSupported &&
            item.deadlineIso !== null &&
            item.deadlineIso !== issueIso
        )
        .map((item) => item.deadlineIso!)
    ),
  ];
  const contactIsos = eligibility.correspondenceDeadlinesIso.filter((iso) => iso !== issueIso);
  let groundedDeadline: string | null = null;
  let groundedDeadlineQuote: string | null = null;
  let groundedDeadlineIso: string | null = null;
  let groundedDeadlineRole: DeadlineRole | null = null;
  let groundedDeadlineAuthority: SourceAmountAuthority = "not_stated";
  const crossRoleConflict =
    paymentIsos.length === 1 && contactIsos.length === 1 && paymentIsos[0] !== contactIsos[0];
  if (eligibility.paymentDeadlineConflict || paymentIsos.length > 1 || crossRoleConflict) {
    groundedDeadlineAuthority = "conflicting";
  } else if (paymentIsos.length === 1) {
    const written = writtenDeadline(text, paymentIsos[0]!, "payment");
    if (written) {
      groundedDeadline = written.stated;
      groundedDeadlineQuote = written.quote;
      groundedDeadlineIso = paymentIsos[0]!;
      groundedDeadlineRole = "payment";
      groundedDeadlineAuthority = "verified";
    } else {
      groundedDeadlineAuthority = "needs_review";
    }
  } else if (eligibility.correspondenceDeadlineConflict || contactIsos.length > 1) {
    groundedDeadlineAuthority = "conflicting";
  } else if (contactIsos.length === 1) {
    const written = writtenDeadline(text, contactIsos[0]!, "contact");
    if (written) {
      groundedDeadline = written.stated;
      groundedDeadlineQuote = written.quote;
      groundedDeadlineIso = contactIsos[0]!;
      groundedDeadlineRole = "contact";
      groundedDeadlineAuthority = "verified";
    } else {
      groundedDeadlineAuthority = "needs_review";
    }
  } else if (
    eligibility.decisions.some(
      (item) =>
        item.reason === "payment_deadline" ||
        item.reason === "correspondence_deadline" ||
        item.reason === "conflicting_deadlines" ||
        item.deadlineIso !== null
    )
  ) {
    groundedDeadlineAuthority = "needs_review";
  }

  return {
    groundedIssueDate,
    groundedIssueDateQuote,
    groundedIssueDateIso,
    groundedIssueDateAuthority,
    groundedDeadline,
    groundedDeadlineQuote,
    groundedDeadlineIso,
    groundedDeadlineRole,
    groundedDeadlineAuthority,
  };
}

function verifiedStated(authority: SourceAmountAuthority, stated: string | null): string | null {
  return authority === "verified" ? stated : null;
}

export function compareNotices(
  original: ComparableNoticeFacts,
  revised: ComparableNoticeFacts,
  options?: { today?: string }
): NoticeComparison {
  const today = options?.today;
  const decision = decideComparisonRelationship(
    original.identity,
    revised.identity,
    original.amountAuthority,
    revised.amountAuthority,
    original.amountQuote,
    revised.amountQuote
  );
  let amountStatus: ComparisonStatus = original.amountConflict || revised.amountConflict
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
  if (
    original.amountAuthority === "verified" &&
    revised.amountAuthority === "verified" &&
    decision.relationship !== "COMPARABLE"
  ) {
    amountStatus = "conflicting";
  }

  const originalDeadline = verifiedStated(original.groundedDeadlineAuthority, original.groundedDeadline);
  const revisedDeadline = verifiedStated(revised.groundedDeadlineAuthority, revised.groundedDeadline);
  const deadlineStatus: ComparisonStatus =
    original.groundedDeadlineAuthority === "conflicting" || revised.groundedDeadlineAuthority === "conflicting"
      ? "conflicting"
      : textStatus(originalDeadline, revisedDeadline);
  const sameDeadlineRole =
    original.groundedDeadlineRole !== null &&
    original.groundedDeadlineRole === revised.groundedDeadlineRole;
  let laterByCalendarDays: number | null = null;
  if (
    decision.relationship === "COMPARABLE" &&
    sameDeadlineRole &&
    deadlineStatus !== "conflicting" &&
    originalDeadline &&
    revisedDeadline
  ) {
    const from = parseCalendarDate(originalDeadline);
    const to = parseCalendarDate(revisedDeadline);
    if (from && to) {
      laterByCalendarDays = diffCalendarDays(to, from);
    }
  }
  const originalIssue = verifiedStated(original.groundedIssueDateAuthority, original.groundedIssueDate);
  const revisedIssue = verifiedStated(revised.groundedIssueDateAuthority, revised.groundedIssueDate);

  const billingStatus = textStatus(original.billingPeriod, revised.billingPeriod);
  const omittedInRevised = billingStatus === "omitted_in_revised";

  return {
    relationship: decision.relationship,
    relationshipReason: decision.reason,
    localIdentity: { original: original.identity, revised: revised.identity },
    amount: {
      value: original.amountConflict ? null : original.amountGBP,
      quote: original.amountQuote,
      verification: verify(original.rawText, original.amountQuote),
      ...amountSupport(
        original.rawText,
        original.amountConflict ? null : original.amountGBP,
        original.amountQuote,
        original.amountConflict,
        original.amountRejected
      ),
      revised: revised.amountConflict ? null : revised.amountGBP,
      revisedQuote: revised.amountQuote,
      revisedVerification: verify(revised.rawText, revised.amountQuote),
      differenceGBP:
        decision.relationship === "COMPARABLE"
          ? differenceGBP(original.amountGBP, revised.amountGBP)
          : null,
      status: amountStatus,
      originalAuthority: original.amountAuthority,
      revisedAuthority: revised.amountAuthority,
    },
    responseDeadline: {
      value: originalDeadline,
      quote: originalDeadline ? original.groundedDeadlineQuote : null,
      verification: verify(original.rawText, originalDeadline ? original.groundedDeadlineQuote : null),
      ...dateSupport(
        original.rawText,
        originalDeadline,
        originalDeadline ? original.groundedDeadlineQuote : null,
        original.groundedDeadlineAuthority === "conflicting"
      ),
      revised: revisedDeadline,
      revisedQuote: revisedDeadline ? revised.groundedDeadlineQuote : null,
      revisedVerification: verify(revised.rawText, revisedDeadline ? revised.groundedDeadlineQuote : null),
      originalDates: originalDeadline ? [originalDeadline] : [],
      revisedDates: revisedDeadline ? [revisedDeadline] : [],
      laterByCalendarDays,
      status: deadlineStatus,
      originalClassification: today ? classifyDeadline(originalDeadline, today) : null,
      revisedClassification: today ? classifyDeadline(revisedDeadline, today) : null,
      originalRole: originalDeadline ? original.groundedDeadlineRole : null,
      revisedRole: revisedDeadline ? revised.groundedDeadlineRole : null,
      originalAuthority: original.groundedDeadlineAuthority,
      revisedAuthority: revised.groundedDeadlineAuthority,
    },
    billingPeriod: {
      value: periodStated(original.billingPeriod) ? original.billingPeriod : null,
      quote: original.billingPeriodQuote,
      verification: verify(original.rawText, original.billingPeriodQuote),
      ...periodSupport(
        original.rawText,
        periodStated(original.billingPeriod) ? original.billingPeriod : null,
        original.billingPeriodQuote
      ),
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
      ...actionSupport(original.rawText, original.statedAction, original.actionQuote),
      revised: revised.statedAction,
      revisedQuote: revised.actionQuote,
      revisedVerification: verify(revised.rawText, revised.actionQuote),
      status: textStatus(original.statedAction, revised.statedAction),
    },
    issueDate: {
      original: originalIssue,
      revised: revisedIssue,
      originalQuote: originalIssue ? original.groundedIssueDateQuote : null,
      revisedQuote: revisedIssue ? revised.groundedIssueDateQuote : null,
      originalVerification: verify(original.rawText, originalIssue ? original.groundedIssueDateQuote : null),
      revisedVerification: verify(revised.rawText, revisedIssue ? revised.groundedIssueDateQuote : null),
      ...dateSupport(
        original.rawText,
        originalIssue,
        originalIssue ? original.groundedIssueDateQuote : null,
        original.groundedIssueDateAuthority === "conflicting"
      ),
      originalAssessment: today ? assessIssueDate(originalIssue, today) : null,
      revisedAssessment: today ? assessIssueDate(revisedIssue, today) : null,
      originalAuthority: original.groundedIssueDateAuthority,
      revisedAuthority: revised.groundedIssueDateAuthority,
      status:
        original.groundedIssueDateAuthority === "conflicting" ||
        revised.groundedIssueDateAuthority === "conflicting"
          ? "conflicting"
          : textStatus(originalIssue, revisedIssue),
    },
  };
}

export function maskUnsettledComparison(
  settled: NoticeComparison,
  changed: { original: boolean; revised: boolean }
): NoticeComparison {
  if (!changed.original && !changed.revised) {
    return settled;
  }
  return {
    ...settled,
    relationship: "BALANCE_UNVERIFIED",
    relationshipReason: "comparison_unsettled",
    amount: {
      ...settled.amount,
      value: changed.original ? null : settled.amount.value,
      quote: changed.original ? null : settled.amount.quote,
      verifiedForDisplay: changed.original ? null : settled.amount.verifiedForDisplay,
      originalAuthority: changed.original ? "needs_review" : settled.amount.originalAuthority,
      revised: changed.revised ? null : settled.amount.revised,
      revisedQuote: changed.revised ? null : settled.amount.revisedQuote,
      revisedAuthority: changed.revised ? "needs_review" : settled.amount.revisedAuthority,
      differenceGBP: null,
    },
    issueDate: {
      ...settled.issueDate,
      original: changed.original ? null : settled.issueDate.original,
      revised: changed.revised ? null : settled.issueDate.revised,
      originalAuthority: changed.original ? "needs_review" : settled.issueDate.originalAuthority,
      revisedAuthority: changed.revised ? "needs_review" : settled.issueDate.revisedAuthority,
      originalAssessment: changed.original ? null : settled.issueDate.originalAssessment,
      revisedAssessment: changed.revised ? null : settled.issueDate.revisedAssessment,
    },
    responseDeadline: {
      ...settled.responseDeadline,
      value: changed.original ? null : settled.responseDeadline.value,
      revised: changed.revised ? null : settled.responseDeadline.revised,
      originalDates: changed.original ? [] : settled.responseDeadline.originalDates,
      revisedDates: changed.revised ? [] : settled.responseDeadline.revisedDates,
      originalRole: changed.original ? null : settled.responseDeadline.originalRole,
      revisedRole: changed.revised ? null : settled.responseDeadline.revisedRole,
      originalAuthority: changed.original ? "needs_review" : settled.responseDeadline.originalAuthority,
      revisedAuthority: changed.revised ? "needs_review" : settled.responseDeadline.revisedAuthority,
      laterByCalendarDays: null,
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

import { readAmount } from "./amounts";
import {
  compactIdentifier,
  containsWholeWord,
  hasLongNumericIdentifier,
  isCalendarToken,
  meaningfulNameComponents,
  normalizeDashes,
} from "./textNormalize";
import {
  CloudPayloadValidationError,
  validateCloudBoundPayload,
} from "./cloudPayloadGuard";
import { parseBillingWindow, parseCalendarDate } from "./dates";
import {
  formatCanonicalPlaceholder,
  type CanonicalPlaceholderBase,
} from "./placeholders";
import {
  findMonetarySupport,
  groundBillingPeriod,
  groundCalendarDate,
  groundObligation,
} from "./sourceGrounding";
import type {
  CircumstanceFlag,
  CloudBillingWindow,
  CloudBoundStructuralPayload,
  GuidanceId,
  LocalIdentifierEntry,
  LocalIdentifierKind,
  LocalIdentifierMap,
  NoticeCategory,
  ResponseGoal,
} from "./types";

export const REGEX_REDACTION_LIMITATIONS = [
  "Regex redaction does not guarantee that every personal identifier was removed.",
  "Names, addresses, and account numbers outside the detected patterns can remain.",
  "A person must review the structural brief before any cloud request.",
] as const;

const PLACEHOLDER_BASE: Record<LocalIdentifierKind, CanonicalPlaceholderBase> = {
  recipient_name: "RECIPIENT_NAME",
  account_ref: "ACCOUNT_REF",
  supply_address: "SUPPLY_ADDRESS",
  email: "EMAIL",
  phone: "PHONE",
  other: "LOCAL_ID",
};

const KIND_RANK: Record<LocalIdentifierKind, number> = {
  supply_address: 0,
  email: 1,
  phone: 2,
  account_ref: 3,
  recipient_name: 4,
  other: 5,
};

interface Span {
  start: number;
  end: number;
  kind: LocalIdentifierKind;
  rawValue: string;
  placeholder: string;
}

interface Replacement {
  rawValue: string;
  placeholder: string;
  wholeWord?: boolean;
}

export interface BriefSourceObligation {
  action: string;
  dueDate: string | null;
  sourceQuote: string;
}

export interface BriefSource {
  noticeCategory: NoticeCategory;
  issueDate: string | null;
  billingPeriod: string | null;
  amountGBP: number | null;
  /** Additional explicit amounts. Missing stays empty rather than becoming 0. */
  amountsGBP?: readonly number[];
  responseDeadline: string | null;
  responseDeadlines?: readonly (string | null)[];
  obligations: BriefSourceObligation[];
}

export interface RedactAndBriefInput {
  rawNoticeText: string;
  extraction: BriefSource;
  responseGoal: ResponseGoal;
  guidanceIds: readonly GuidanceId[];
  circumstanceFlags?: readonly CircumstanceFlag[];
  extraKnownIdentifiers?: readonly string[];
}

export interface RedactAndBriefSuccess {
  ok: true;
  declaredComplete: false;
  limitations: readonly string[];
  localIdentifierMap: LocalIdentifierMap;
  redactedNoticePreview: string;
  structuralBrief: CloudBoundStructuralPayload;
  excludedUnverifiedQuotes: string[];
}

export interface RedactAndBriefFailure {
  ok: false;
  declaredComplete: false;
  limitations: readonly string[];
  reasons: string[];
  localIdentifierMap: LocalIdentifierMap;
  excludedUnverifiedQuotes: string[];
}

export type RedactAndBriefResult = RedactAndBriefSuccess | RedactAndBriefFailure;

function emptyMap(): LocalIdentifierMap {
  return { locality: "browser-only", entries: [] };
}

function failure(
  reasons: readonly string[],
  map: LocalIdentifierMap,
  excludedUnverifiedQuotes: string[]
): RedactAndBriefFailure {
  return {
    ok: false,
    declaredComplete: false,
    limitations: REGEX_REDACTION_LIMITATIONS,
    reasons: [...reasons],
    localIdentifierMap: map,
    excludedUnverifiedQuotes,
  };
}

function fold(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, "")
    .toLowerCase();
}

function compact(value: string): string {
  return compactIdentifier(fold(value));
}

function replaceWholeWord(input: string, needle: string, replacement: string): string {
  if (!needle) {
    return input;
  }
  const pattern = new RegExp(`(^|[^A-Za-z])(${escapeRegExp(needle)})([^A-Za-z]|$)`, "gi");
  return input.replace(pattern, (_match, before: string, _word: string, after: string) => {
    return `${before}${replacement}${after}`;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceAllInsensitive(
  input: string,
  needle: string,
  replacement: string
): string {
  if (!needle) {
    return input;
  }
  return input.replace(new RegExp(escapeRegExp(needle), "gi"), () => replacement);
}

function findAll(haystack: string, needle: string): number[] {
  const indexes: number[] = [];
  const foldedHaystack = haystack.toLowerCase();
  const foldedNeedle = needle.toLowerCase();
  if (!foldedNeedle) {
    return indexes;
  }
  let from = 0;
  while (from < haystack.length) {
    const index = foldedHaystack.indexOf(foldedNeedle, from);
    if (index < 0) {
      break;
    }
    indexes.push(index);
    from = index + foldedNeedle.length;
  }
  return indexes;
}

function pushMatch(
  spans: Span[],
  kind: LocalIdentifierKind,
  start: number,
  rawValue: string
): void {
  if (!rawValue || start < 0) {
    return;
  }
  spans.push({
    start,
    end: start + rawValue.length,
    kind,
    rawValue,
    placeholder: "",
  });
}

function digitCount(value: string): number {
  return value.replace(/\D/g, "").length;
}

function detectSpans(rawNoticeText: string): Span[] {
  const spans: Span[] = [];
  const normalized = normalizeDashes(rawNoticeText);

  const address =
    /\b\d{1,4}[A-Z]?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\s+(?:Road|Street|Lane|Avenue|Close|Drive|Way|Court|Place|Gardens|Crescent|Terrace),\s*[A-Z][a-z]+,\s*[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/g;
  const street =
    /\b\d{1,4}[A-Z]?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\s+(?:Road|Street|Lane|Avenue|Close|Drive|Way|Court|Place|Gardens|Crescent|Terrace)\b/g;
  const postcode = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi;
  const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
  const phone =
    /(?:\+44\s?\d{3,4}|\(?0\d{3,4}\)?)\s?\d{3}\s?\d{3,4}\b(?![\s-]*\d)/gi;
  const account =
    /\b(?:Account|Tenancy|Customer|Council\s*Tax)\s*(?:reference|ref|number|no\.?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9/-]{2,20})/gi;
  const longNumber = /\d(?:[\s\u00A0-]*\d){7,}/g;
  const salutation = /\bDear\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g;
  const nino = /\b[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi;

  for (const match of normalized.matchAll(address)) {
    const start = match.index ?? -1;
    pushMatch(spans, "supply_address", start, rawNoticeText.slice(start, start + match[0].length));
  }
  for (const match of normalized.matchAll(street)) {
    const start = match.index ?? -1;
    pushMatch(spans, "supply_address", start, rawNoticeText.slice(start, start + match[0].length));
  }
  for (const match of normalized.matchAll(postcode)) {
    const start = match.index ?? -1;
    pushMatch(spans, "supply_address", start, rawNoticeText.slice(start, start + match[0].length));
  }
  for (const match of normalized.matchAll(email)) {
    const start = match.index ?? -1;
    pushMatch(spans, "email", start, rawNoticeText.slice(start, start + match[0].length));
  }
  for (const match of normalized.matchAll(phone)) {
    const start = match.index ?? -1;
    pushMatch(spans, "phone", start, rawNoticeText.slice(start, start + match[0].length));
  }
  for (const match of normalized.matchAll(longNumber)) {
    const start = match.index ?? -1;
    const rawValue = rawNoticeText.slice(start, start + match[0].length);
    if (digitCount(rawValue) < 8 || isCalendarToken(normalizeDashes(rawValue))) {
      continue;
    }
    const kind: LocalIdentifierKind = /^(?:\+|0)/.test(rawValue.trim()) ? "phone" : "other";
    pushMatch(spans, kind, start, rawValue);
  }
  for (const match of normalized.matchAll(account)) {
    const token = match[1];
    if (!token || match.index === undefined) {
      continue;
    }
    const start = match.index + match[0].lastIndexOf(token);
    pushMatch(spans, "account_ref", start, rawNoticeText.slice(start, start + token.length));
  }
  for (const match of normalized.matchAll(salutation)) {
    const name = match[1];
    if (!name || match.index === undefined) {
      continue;
    }
    const start = match.index + match[0].indexOf(name);
    pushMatch(spans, "recipient_name", start, rawNoticeText.slice(start, start + name.length));
  }
  for (const match of normalized.matchAll(nino)) {
    const start = match.index ?? -1;
    pushMatch(spans, "other", start, rawNoticeText.slice(start, start + match[0].length));
  }

  return spans;
}

function mergeSpans(spans: Span[]): { kept: Span[]; contained: Span[] } | string {
  const sorted = [...spans].sort(
    (a, b) => a.start - b.start || b.end - a.end || KIND_RANK[a.kind] - KIND_RANK[b.kind]
  );
  const kept: Span[] = [];
  const contained: Span[] = [];
  for (const span of sorted) {
    const previous = kept[kept.length - 1];
    if (!previous) {
      kept.push(span);
      continue;
    }
    if (span.start >= previous.start && span.end <= previous.end) {
      contained.push(span);
      continue;
    }
    if (span.start < previous.end) {
      return "Overlapping identifier spans could not be redacted safely";
    }
    kept.push(span);
  }
  return { kept, contained };
}

function createPlaceholderAllocator(): (span: Span) => string {
  const counts = new Map<string, number>();
  const byRaw = new Map<string, string>();
  return (span) => {
    const existing = byRaw.get(span.rawValue.toLowerCase());
    if (existing) {
      span.placeholder = existing;
      return existing;
    }
    const family =
      span.kind === "other" && /^[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}/i.test(span.rawValue)
        ? "nino"
        : span.kind;
    const count = counts.get(family) ?? 0;
    counts.set(family, count + 1);
    const base: CanonicalPlaceholderBase =
      family === "nino" ? "NINO" : PLACEHOLDER_BASE[span.kind];
    const placeholder = formatCanonicalPlaceholder(base, count);
    span.placeholder = placeholder;
    byRaw.set(span.rawValue.toLowerCase(), placeholder);
    return placeholder;
  };
}

function leaksKnownIdentifier(text: string, rawValues: readonly string[]): boolean {
  const folded = fold(text);
  const compacted = compact(text);
  return rawValues.some((raw) => {
    const clean = raw.trim();
    if (clean.length < 3) {
      return false;
    }
    if (folded.includes(fold(clean)) || containsWholeWord(folded, fold(clean))) {
      return true;
    }
    for (const part of meaningfulNameComponents(clean)) {
      if (containsWholeWord(folded, fold(part))) {
        return true;
      }
    }
    const compactId = compact(clean);
    return compactId.length >= 6 && compacted.includes(compactId);
  });
}

function residualPattern(text: string): string | null {
  const visible = normalizeDashes(text);
  if (/\[(?:ACCOUNT_REF|PHONE|LOCAL_ID|NINO)(?:_[1-9]\d*)?\](?!\s+[A-Za-z])\s*-?\s*\d/.test(visible)) {
    return "A partial identifier remained beside a placeholder";
  }
  if (hasLongNumericIdentifier(visible)) {
    return "A long numeric identifier remained in the structural brief";
  }
  if (/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i.test(visible)) {
    return "A postcode pattern remained in the structural brief";
  }
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(visible)) {
    return "An email pattern remained in the structural brief";
  }
  if (/(?:\+44\s?\d{3,4}|\(?0\d{3,4}\)?)\s?\d{3}\s?\d{3,4}\b(?![\s-]*\d)/.test(visible)) {
    return "A telephone pattern remained in the structural brief";
  }
  if (/\b(?:Dear|Mr|Mrs|Ms|Miss|Dr)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/.test(visible)) {
    return "A personal name pattern remained in the structural brief";
  }
  if (
    /\b\d{1,4}[A-Z]?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\s+(?:Road|Street|Lane|Avenue|Close|Drive|Way|Court|Place|Gardens|Crescent|Terrace)\b/.test(
      visible
    )
  ) {
    return "A street address pattern remained in the structural brief";
  }
  if (/\b[A-Z]{2,12}-\d{3,12}\b/.test(visible)) {
    return "An account reference pattern remained in the structural brief";
  }
  return null;
}

function isoFromText(value: string | null | undefined): string | null {
  if (!value || value.trim().length === 0 || /^not stated$/i.test(value.trim())) {
    return null;
  }
  const direct = parseCalendarDate(value.trim());
  if (direct) {
    return direct.iso;
  }
  const token = value.match(
    /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]+\s+\d{4})\b/
  )?.[1];
  return token ? parseCalendarDate(token)?.iso ?? null : null;
}

function groundedIso(
  source: string,
  value: string | null | undefined
): string | null {
  const iso = isoFromText(value);
  if (!iso || !value) {
    return null;
  }
  const grounded = groundCalendarDate(source, iso, value);
  return grounded.support === "supports_claim" ? iso : null;
}

export function redactAndBuildBrief(input: RedactAndBriefInput): RedactAndBriefResult {
  const excludedUnverifiedQuotes: string[] = [];
  if (!input.rawNoticeText || input.rawNoticeText.trim().length === 0) {
    return failure(["Notice text is empty"], emptyMap(), excludedUnverifiedQuotes);
  }
  if (input.rawNoticeText.length > 200_000) {
    return failure(
      ["Notice text exceeds the local redaction limit"],
      emptyMap(),
      excludedUnverifiedQuotes
    );
  }

  const detected = detectSpans(input.rawNoticeText);
  for (const extra of input.extraKnownIdentifiers ?? []) {
    const clean = extra.trim();
    if (clean.length < 3) {
      continue;
    }
    const indexes = findAll(input.rawNoticeText, clean);
    if (indexes.length === 0) {
      detected.push({
        start: 0,
        end: 0,
        kind: "other",
        rawValue: clean,
        placeholder: "",
      });
      continue;
    }
    for (const index of indexes) {
      detected.push({
        start: index,
        end: index + clean.length,
        kind: "other",
        rawValue: input.rawNoticeText.slice(index, index + clean.length),
        placeholder: "",
      });
    }
  }

  const located = detected.filter((span) => span.end > span.start);
  const unlocated = detected.filter((span) => span.end <= span.start);
  const merged = mergeSpans(located);
  if (typeof merged === "string") {
    return failure([merged], emptyMap(), excludedUnverifiedQuotes);
  }

  const allocate = createPlaceholderAllocator();
  const replacements: Replacement[] = [];
  const seenRaw = new Set<string>();
  const remember = (rawValue: string, placeholder: string, wholeWord = false) => {
    const key = rawValue.toLowerCase();
    const existing = replacements.find((item) => item.rawValue.toLowerCase() === key);
    if (existing) {
      if (wholeWord) {
        existing.wholeWord = true;
      }
      return;
    }
    if (seenRaw.has(key)) {
      return;
    }
    seenRaw.add(key);
    replacements.push({ rawValue, placeholder, wholeWord });
  };
  for (const span of merged.kept) {
    remember(span.rawValue, allocate(span));
  }
  for (const dropped of merged.contained) {
    const parent = merged.kept.find(
      (span) => dropped.start >= span.start && dropped.end <= span.end
    );
    if (!parent) {
      return failure(
        ["A detected identifier was nested ambiguously and was not redacted"],
        emptyMap(),
        excludedUnverifiedQuotes
      );
    }
    remember(dropped.rawValue, parent.placeholder);
  }
  for (const extra of unlocated) {
    remember(extra.rawValue, allocate(extra));
  }
  for (const item of [...replacements]) {
    for (const part of meaningfulNameComponents(item.rawValue)) {
      remember(part, item.placeholder, true);
    }
  }

  const entries: LocalIdentifierEntry[] = merged.kept.map((span) => ({
    kind: span.kind,
    placeholder: span.placeholder,
    rawValue: span.rawValue,
    startOffset: span.start,
    endOffset: span.end,
  }));
  const map: LocalIdentifierMap = { locality: "browser-only", entries };
  const rawValues = replacements.map((item) => item.rawValue);

  const redact = (value: string) => {
    const ordered = [...replacements].sort((a, b) => b.rawValue.length - a.rawValue.length);
    return ordered.reduce((text, item) => {
      if (item.wholeWord) {
        return replaceWholeWord(text, item.rawValue, item.placeholder);
      }
      return replaceAllInsensitive(text, item.rawValue, item.placeholder);
    }, value);
  };

  const redactedNoticePreview = redact(input.rawNoticeText);
  if (leaksKnownIdentifier(redactedNoticePreview, rawValues)) {
    return failure(
      ["A known local identifier remained after redaction"],
      map,
      excludedUnverifiedQuotes
    );
  }

  const requestedAmounts =
    input.extraction.amountsGBP ??
    (input.extraction.amountGBP === null ? [] : [input.extraction.amountGBP]);
  const amountsGBP: number[] = [];
  for (const candidate of requestedAmounts) {
    const read = readAmount(candidate);
    if (read.status === "rejected") {
      return failure(
        ["An amount was negative, ambiguous, or not a supported representation"],
        map,
        excludedUnverifiedQuotes
      );
    }
    if (read.status !== "value") {
      continue;
    }
    if (amountsGBP.some((existing) => Math.abs(existing - read.value) < 0.001)) {
      continue;
    }
    const support = findMonetarySupport(input.rawNoticeText, read.value);
    if (support.support === "supports_claim") {
      amountsGBP.push(read.value);
    }
  }

  const issueDate = groundedIso(input.rawNoticeText, input.extraction.issueDate);
  const responseDeadlines: string[] = [];
  for (const candidate of [
    input.extraction.responseDeadline,
    ...(input.extraction.responseDeadlines ?? []),
  ]) {
    const iso = groundedIso(input.rawNoticeText, candidate);
    if (iso && !responseDeadlines.includes(iso)) {
      responseDeadlines.push(iso);
    }
  }

  let billingPeriod: CloudBillingWindow | null = parseBillingWindow(
    input.extraction.billingPeriod
  );
  if (billingPeriod && input.extraction.billingPeriod) {
    const periodGrounding = groundBillingPeriod(
      input.rawNoticeText,
      input.extraction.billingPeriod,
      input.extraction.billingPeriod
    );
    if (periodGrounding.support !== "supports_claim") {
      billingPeriod = null;
    }
  }

  const clauses: CloudBoundStructuralPayload["redactedObligations"] = [];
  for (const obligation of input.extraction.obligations) {
    const grounding = groundObligation(
      input.rawNoticeText,
      obligation.action,
      obligation.sourceQuote
    );
    if (grounding.support !== "supports_claim" || !grounding.verifiedForDisplay) {
      excludedUnverifiedQuotes.push(obligation.sourceQuote);
      continue;
    }
    const redactedClause = redact(obligation.sourceQuote).trim();
    if (redactedClause.length < 4 || redactedClause.length > 220) {
      return failure(
        ["A redacted clause is outside the cloud brief length limits"],
        map,
        excludedUnverifiedQuotes
      );
    }
    clauses.push({
      actionSummary: grounding.verifiedForDisplay,
      dueDate: groundedIso(input.rawNoticeText, obligation.dueDate),
      redactedClause,
    });
  }

  if (clauses.length === 0) {
    return failure(
      ["No verified source quotations remain; refusing to send unverified text"],
      map,
      excludedUnverifiedQuotes
    );
  }
  if (clauses.length > 6) {
    return failure(
      ["More than 6 verified obligations would have to be dropped, so none were sent"],
      map,
      excludedUnverifiedQuotes
    );
  }

  const candidate: CloudBoundStructuralPayload = {
    schemaVersion: "noticelens.cloud-brief.v1",
    noticeCategory: input.extraction.noticeCategory,
    issueDate,
    billingPeriod,
    amountsGBP,
    responseDeadlines,
    redactedObligations: clauses,
    responseGoal: input.responseGoal,
    guidanceIds: [...input.guidanceIds],
  };
  if (input.circumstanceFlags) {
    candidate.circumstanceFlags = [...input.circumstanceFlags];
  }

  const briefText = JSON.stringify(candidate);
  if (leaksKnownIdentifier(briefText, rawValues)) {
    return failure(
      ["A known local identifier remained in the structural brief"],
      map,
      excludedUnverifiedQuotes
    );
  }
  const residual = residualPattern(briefText);
  if (residual) {
    return failure([residual], map, excludedUnverifiedQuotes);
  }

  try {
    const structuralBrief = validateCloudBoundPayload(candidate, {
      rawNoticeText: input.rawNoticeText,
      forbiddenIdentifiers: rawValues,
    });
    return {
      ok: true,
      declaredComplete: false,
      limitations: REGEX_REDACTION_LIMITATIONS,
      localIdentifierMap: map,
      redactedNoticePreview,
      structuralBrief,
      excludedUnverifiedQuotes,
    };
  } catch (error) {
    if (error instanceof CloudPayloadValidationError) {
      return failure(error.violations, map, excludedUnverifiedQuotes);
    }
    throw error;
  }
}

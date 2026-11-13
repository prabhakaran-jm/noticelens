import {
  CloudPayloadValidationError,
  validateCloudBoundPayload,
} from "./cloudPayloadGuard";
import type {
  CircumstanceFlag,
  CloudBoundStructuralPayload,
  GuidanceId,
  LocalIdentifierEntry,
  LocalIdentifierKind,
  LocalIdentifierMap,
  NoticeCategory,
  ResponseGoal,
} from "./types";
import { verifyQuoteInSource } from "./verifyQuotes";

export const REGEX_REDACTION_LIMITATIONS = [
  "Regex redaction does not guarantee that every personal identifier was removed.",
  "Names, addresses, and account numbers outside the detected patterns can remain.",
  "A person must review the structural brief before any cloud request.",
] as const;

const PLACEHOLDER_BASE: Record<LocalIdentifierKind, string> = {
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
  responseDeadline: string | null;
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
  reasons: string[],
  map: LocalIdentifierMap,
  excludedUnverifiedQuotes: string[]
): RedactAndBriefFailure {
  return {
    ok: false,
    declaredComplete: false,
    limitations: REGEX_REDACTION_LIMITATIONS,
    reasons,
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
  return fold(value).replace(/[\s-]/g, "");
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

function detectSpans(rawNoticeText: string): Span[] {
  const spans: Span[] = [];

  const address =
    /\b\d{1,4}[A-Z]?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\s+(?:Road|Street|Lane|Avenue|Close|Drive|Way|Court|Place|Gardens|Crescent|Terrace),\s*[A-Z][a-z]+,\s*[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/g;
  const street =
    /\b\d{1,4}[A-Z]?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\s+(?:Road|Street|Lane|Avenue|Close|Drive|Way|Court|Place|Gardens|Crescent|Terrace)\b/g;
  const postcode = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi;
  const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
  const phone = /(?:\+44\s?\d{3,4}|\(?0\d{3,4}\)?)\s?\d{3}\s?\d{3,4}\b/gi;
  const account =
    /\b(?:Account|Tenancy|Customer|Council\s*Tax)\s*(?:reference|ref|number|no\.?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9/-]{2,20})/gi;
  const salutation = /\bDear\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g;
  const nino = /\b[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi;

  for (const match of rawNoticeText.matchAll(address)) {
    pushMatch(spans, "supply_address", match.index ?? -1, match[0]);
  }
  for (const match of rawNoticeText.matchAll(street)) {
    pushMatch(spans, "supply_address", match.index ?? -1, match[0]);
  }
  for (const match of rawNoticeText.matchAll(postcode)) {
    pushMatch(spans, "supply_address", match.index ?? -1, match[0]);
  }
  for (const match of rawNoticeText.matchAll(email)) {
    pushMatch(spans, "email", match.index ?? -1, match[0]);
  }
  for (const match of rawNoticeText.matchAll(phone)) {
    pushMatch(spans, "phone", match.index ?? -1, match[0]);
  }
  for (const match of rawNoticeText.matchAll(account)) {
    const token = match[1];
    if (!token || match.index === undefined) {
      continue;
    }
    const start = match.index + match[0].lastIndexOf(token);
    pushMatch(spans, "account_ref", start, token);
  }
  for (const match of rawNoticeText.matchAll(salutation)) {
    const name = match[1];
    if (!name || match.index === undefined) {
      continue;
    }
    const start = match.index + match[0].indexOf(name);
    pushMatch(spans, "recipient_name", start, name);
  }
  for (const match of rawNoticeText.matchAll(nino)) {
    pushMatch(spans, "other", match.index ?? -1, match[0]);
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
    const base = family === "nino" ? "NINO" : PLACEHOLDER_BASE[span.kind];
    const placeholder = count === 0 ? `[${base}]` : `[${base}_${count + 1}]`;
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
    if (folded.includes(fold(clean))) {
      return true;
    }
    const compactId = compact(clean);
    return compactId.length >= 6 && compacted.includes(compactId);
  });
}

function residualPattern(text: string): string | null {
  if (/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i.test(text)) {
    return "A postcode pattern remained in the structural brief";
  }
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)) {
    return "An email pattern remained in the structural brief";
  }
  if (/(?:\+44\s?\d{3,4}|\(?0\d{3,4}\)?)\s?\d{3}\s?\d{3,4}\b/.test(text)) {
    return "A telephone pattern remained in the structural brief";
  }
  if (/\b(?:Dear|Mr|Mrs|Ms|Miss|Dr)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/.test(text)) {
    return "A personal name pattern remained in the structural brief";
  }
  if (
    /\b\d{1,4}[A-Z]?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\s+(?:Road|Street|Lane|Avenue|Close|Drive|Way|Court|Place|Gardens|Crescent|Terrace)\b/.test(
      text
    )
  ) {
    return "A street address pattern remained in the structural brief";
  }
  if (/\b[A-Z]{2,12}-\d{3,12}\b/.test(text)) {
    return "An account reference pattern remained in the structural brief";
  }
  return null;
}

function statedOrNot(value: string | null | undefined): string {
  if (!value || value.trim().length === 0 || /^not stated$/i.test(value.trim())) {
    return "not stated";
  }
  return value.trim();
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
  const remember = (rawValue: string, placeholder: string) => {
    const key = rawValue.toLowerCase();
    if (seenRaw.has(key)) {
      return;
    }
    seenRaw.add(key);
    replacements.push({ rawValue, placeholder });
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
    return ordered.reduce(
      (text, item) => replaceAllInsensitive(text, item.rawValue, item.placeholder),
      value
    );
  };

  const redactedNoticePreview = redact(input.rawNoticeText);
  if (leaksKnownIdentifier(redactedNoticePreview, rawValues)) {
    return failure(
      ["A known local identifier remained after redaction"],
      map,
      excludedUnverifiedQuotes
    );
  }

  if (
    input.extraction.amountGBP === null ||
    !Number.isFinite(input.extraction.amountGBP) ||
    input.extraction.amountGBP < 0
  ) {
    return failure(
      ["Amount is not stated; refusing to substitute 0"],
      map,
      excludedUnverifiedQuotes
    );
  }

  const issueDate = input.extraction.issueDate?.trim() ?? "";
  if (!issueDate) {
    return failure(
      ["Issue date is missing; refusing to invent one"],
      map,
      excludedUnverifiedQuotes
    );
  }

  const clauses: CloudBoundStructuralPayload["redactedObligations"] = [];
  for (const obligation of input.extraction.obligations) {
    const verification = verifyQuoteInSource(input.rawNoticeText, obligation.sourceQuote);
    if (!verification.verified) {
      excludedUnverifiedQuotes.push(obligation.sourceQuote);
      continue;
    }
    const redactedClause = redact(obligation.sourceQuote).trim();
    const redactedAction = redact(obligation.action).trim();
    const actionSummary = redactedAction || "Review the stated obligation";
    if (actionSummary.length > 160 || redactedClause.length < 4 || redactedClause.length > 220) {
      return failure(
        ["A redacted clause is outside the cloud brief length limits"],
        map,
        excludedUnverifiedQuotes
      );
    }
    const dueDate = obligation.dueDate ? redact(obligation.dueDate).trim() : null;
    clauses.push({
      actionSummary,
      dueDate: dueDate && dueDate.length > 0 ? dueDate : null,
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
    issueDate: redact(issueDate),
    billingPeriod: redact(statedOrNot(input.extraction.billingPeriod)),
    amountGBP: input.extraction.amountGBP,
    responseDeadline: redact(statedOrNot(input.extraction.responseDeadline)),
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

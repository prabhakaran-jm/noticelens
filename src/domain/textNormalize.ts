/**
 * Shared text folding for identifier detection, redaction, and cloud checks.
 * A real dash becomes one ASCII hyphen, so match offsets stay aligned.
 * U+00AD is a format character, not a hyphen, and is removed with other
 * format characters. The surrounding letters keep their original offsets.
 */

const UNICODE_DASH =
  /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D\u2043]/g;

const NAME_PARTICLES = new Set([
  "of",
  "the",
  "and",
  "de",
  "van",
  "da",
  "di",
  "la",
  "le",
  "von",
  "bin",
  "al",
  "mr",
  "mrs",
  "ms",
  "miss",
  "dr",
]);

export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function normalizeDashes(value: string): string {
  return value.replace(UNICODE_DASH, "-");
}

export interface IdentifierFold {
  folded: string;
  /** Original inclusive index for each UTF-16 unit of `folded`. */
  startAt: number[];
  /** Original exclusive index for each UTF-16 unit of `folded`. */
  endAt: number[];
}

/**
 * One fold for detection, redaction, and the final payload guard.
 * Real dashes stay one code unit. Format characters, including the soft hyphen,
 * are removed. NFKC and lower case run on each grapheme so fullwidth and NFD
 * forms meet, and every folded unit still points at the original span.
 */
export function foldIdentifierText(value: string): IdentifierFold {
  const startAt: number[] = [];
  const endAt: number[] = [];
  let folded = "";
  let cluster = "";
  let clusterStart = 0;
  let clusterEnd = 0;

  const flush = (): void => {
    if (!cluster) {
      return;
    }
    const out = cluster.normalize("NFKC").toLowerCase();
    for (let index = 0; index < out.length; index += 1) {
      folded += out[index];
      startAt.push(clusterStart);
      endAt.push(clusterEnd);
    }
    cluster = "";
  };

  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const raw = String.fromCodePoint(codePoint);
    const next = index + raw.length;
    if (/\p{Cf}/u.test(raw) && !UNICODE_DASH.test(raw)) {
      UNICODE_DASH.lastIndex = 0;
      index = next;
      continue;
    }
    UNICODE_DASH.lastIndex = 0;
    const piece = UNICODE_DASH.test(raw) ? "-" : raw;
    UNICODE_DASH.lastIndex = 0;
    if (/\p{M}/u.test(piece) && cluster) {
      cluster += piece;
      clusterEnd = next;
      index = next;
      continue;
    }
    flush();
    cluster = piece;
    clusterStart = index;
    clusterEnd = next;
    index = next;
  }
  flush();
  return { folded, startAt, endAt };
}

export function compactIdentifier(value: string): string {
  return foldIdentifierText(value).folded.replace(/[\s-]/g, "");
}

/**
 * Letter-only parts of a known multi-word personal name.
 * Account references and single tokens are not split into names.
 */
const NAME_WORD = /^[\p{L}][\p{L}\p{M}'’\-]*$/u;

export function meaningfulNameComponents(fullName: string): string[] {
  const trimmed = fullName.trim();
  if (trimmed.length === 0 || /\d/.test(trimmed)) {
    return [];
  }
  const parts = trimmed.split(/[\s,]+/).filter((part) => part.length > 0);
  if (parts.length < 2) {
    return [];
  }
  return parts.filter((part) => {
    if (part.length < 3 || NAME_PARTICLES.has(part.toLowerCase())) {
      return false;
    }
    return NAME_WORD.test(part);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function prepareForMatch(value: string): string {
  return foldIdentifierText(value).folded;
}

interface OriginalSpan {
  start: number;
  end: number;
}

function hasNameCapital(token: string): boolean {
  return /\p{Lu}/u.test(token.normalize("NFKC"));
}

function isPersonalName(value: string): boolean {
  const parts = value.trim().split(/[\s,]+/).filter((part) => part.length > 0);
  return parts.length > 0 && parts.every((part) => NAME_WORD.test(part));
}

/**
 * True only when this exact occurrence is ordinary notice language.
 * A domain phrase elsewhere in the sentence does not exempt a separate name.
 * Unclassified occurrences stay protected.
 */
function isDomainUseAt(
  text: string,
  folded: IdentifierFold,
  foldedStart: number,
  foldedEnd: number,
  start: number,
  end: number,
  component: string
): boolean {
  const token = text.slice(start, end);
  // A capitalised token is a name even when billing words sit beside it.
  // Lowercase "bill" and "energy" keep the ordinary-phrase exemptions.
  if (hasNameCapital(token)) {
    return false;
  }
  const word = prepareForMatch(component);
  const before = folded.folded.slice(0, foldedStart);
  const after = folded.folded.slice(foldedEnd);
  if (word === "energy") {
    return (
      /^[\s-]+(?:billing|bills?|supplier|supply|account|charges?|usage|costs?)(?![\p{L}\p{N}_])/iu.test(
        after
      ) ||
      /(?:^|[\s,.;:])(?:electricity|gas|water|dual)[\s-]+$/iu.test(before)
    );
  }
  if (word === "bill") {
    return (
      /(?:^|[\s,.;:])(?:energy|council|tax|water|gas|phone|final|this|the|your|a|an)[\s-]+$/iu.test(
        before
      ) ||
      /^[\s-]+(?:payment|pay|due|amount|total)(?![\p{L}\p{N}_])/iu.test(after)
    );
  }
  return false;
}

function personalNameParts(value: string): string[] {
  const parts = value.trim().split(/[\s,]+/).filter((part) => part.length > 0);
  if (parts.length < 2 || parts.some((part) => !NAME_WORD.test(part))) {
    return [];
  }
  return parts;
}

function mapFoldedMatch(folded: IdentifierFold, foldedStart: number, foldedEnd: number): OriginalSpan | null {
  if (foldedEnd <= foldedStart) {
    return null;
  }
  const start = folded.startAt[foldedStart];
  const end = folded.endAt[foldedEnd - 1];
  if (start === undefined || end === undefined || end <= start) {
    return null;
  }
  return { start, end };
}

function componentSpans(text: string, component: string): OriginalSpan[] {
  const needle = prepareForMatch(component);
  if (!needle) {
    return [];
  }
  const folded = foldIdentifierText(text);
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}_])${escapeRegExp(needle)}(?![\\p{L}\\p{M}\\p{N}_])`,
    "gu"
  );
  const spans: OriginalSpan[] = [];
  for (const match of folded.folded.matchAll(pattern)) {
    const foldedStart = match.index ?? 0;
    const span = mapFoldedMatch(folded, foldedStart, foldedStart + match[0].length);
    if (!span) {
      continue;
    }
    if (
      isDomainUseAt(text, folded, foldedStart, foldedStart + match[0].length, span.start, span.end, component)
    ) {
      continue;
    }
    spans.push(span);
  }
  return spans;
}

function personalNameSpans(text: string, fullName: string): OriginalSpan[] {
  const parts = personalNameParts(fullName);
  const compactId = compactIdentifier(fullName);
  if (parts.length < 2 || compactId.length < 6) {
    return [];
  }
  const folded = foldIdentifierText(text);
  const body = [...compactId]
    .map((char) => escapeRegExp(char))
    .join("[\\t\\u00A0 -]{0,3}");
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}_])${body}(?![\\p{L}\\p{M}\\p{N}_])`,
    "gu"
  );
  const spans: OriginalSpan[] = [];
  for (const match of folded.folded.matchAll(pattern)) {
    const foldedStart = match.index ?? 0;
    const span = mapFoldedMatch(folded, foldedStart, foldedStart + match[0].length);
    if (!span) {
      continue;
    }
    if (compactIdentifier(text.slice(span.start, span.end)) !== compactId) {
      continue;
    }
    spans.push(span);
  }
  return spans;
}

function replaceSpans(input: string, spans: readonly OriginalSpan[], replacement: string): string {
  const ordered = [...spans].sort((left, right) => right.start - left.start);
  return ordered.reduce(
    (text, span) => text.slice(0, span.start) + replacement + text.slice(span.end),
    input
  );
}

export function findFoldedOccurrences(haystack: string, needle: string): OriginalSpan[] {
  const foldedNeedle = prepareForMatch(needle);
  if (!foldedNeedle) {
    return [];
  }
  const folded = foldIdentifierText(haystack);
  const spans: OriginalSpan[] = [];
  let from = 0;
  while (from <= folded.folded.length - foldedNeedle.length) {
    const index = folded.folded.indexOf(foldedNeedle, from);
    if (index < 0) {
      break;
    }
    const span = mapFoldedMatch(folded, index, index + foldedNeedle.length);
    if (span) {
      spans.push(span);
    }
    from = index + foldedNeedle.length;
  }
  return spans;
}

export function isCalendarToken(value: string): boolean {
  return /^\d{4}-\d{2}(?:-\d{2})?$/.test(value.trim());
}

/** Digit runs of 8 or more. ISO dates are not account or meter numbers. */
export function hasLongNumericIdentifier(text: string): boolean {
  for (const match of text.matchAll(/\d(?:[\s\u00A0-]*\d){7,}/g)) {
    if (!isCalendarToken(match[0])) {
      return true;
    }
  }
  return false;
}

export function containsWholeWord(haystack: string, word: string): boolean {
  const needle = prepareForMatch(word);
  if (!needle) {
    return false;
  }
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}_])${escapeRegExp(needle)}(?![\\p{L}\\p{M}\\p{N}_])`,
    "u"
  );
  return pattern.test(prepareForMatch(haystack));
}

/** A name component matches a whole word, never a fragment such as Bill inside billing. */
export function nameComponentMatches(text: string, component: string): boolean {
  return componentSpans(text, component).length > 0;
}

export function replaceNameComponent(
  input: string,
  component: string,
  replacement: string
): string {
  if (!component) {
    return input;
  }
  return replaceSpans(input, componentSpans(input, component), replacement);
}

/**
 * Replaces a known multi-word name even when letters are spaced or carry
 * format characters. A single domain word such as "energy billing" does not match.
 */
export function replacePersonalName(
  input: string,
  fullName: string,
  replacement: string
): string {
  return replaceSpans(input, personalNameSpans(input, fullName), replacement);
}

/**
 * Shared leak rule for redaction and cloud validation.
 * Personal-name components use whole words. Multi-word names also use compact
 * matching, so letter spacing and format characters cannot skip the check.
 * Account references keep compact matching. A single domain word is not compacted
 * onto ordinary notice language; an unclassified occurrence still counts as the name.
 */
export function identifierLeaks(text: string, rawId: string): boolean {
  const clean = rawId.trim();
  if (clean.length < 3) {
    return false;
  }
  if (isPersonalName(clean)) {
    const parts = clean.split(/[\s,]+/).filter((part) => part.length > 0);
    if (personalNameSpans(text, clean).length > 0) {
      return true;
    }
    const components = meaningfulNameComponents(clean);
    const words = components.length > 0 ? components : parts;
    return words.some((part) => part.length >= 3 && nameComponentMatches(text, part));
  }
  const prepared = prepareForMatch(text);
  const preparedId = prepareForMatch(clean);
  if (prepared.includes(preparedId)) {
    return true;
  }
  const compactId = compactIdentifier(clean);
  return compactId.length >= 6 && compactIdentifier(text).includes(compactId);
}

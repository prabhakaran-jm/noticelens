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

export interface PatternProjection {
  text: string;
  /** Original inclusive index for each UTF-16 unit of `text`. */
  startAt: number[];
  /** Original exclusive index for each UTF-16 unit of `text`. */
  endAt: number[];
}

function projectedPiece(raw: string): string {
  if (isRealDash(raw)) {
    return "-";
  }
  const separator = projectedSeparator(raw);
  if (separator) {
    return separator;
  }
  const compatible = raw.normalize("NFKC");
  if (compatible !== raw && /^[\p{L}\p{N}]+$/u.test(compatible)) {
    return compatible;
  }
  return raw;
}

function isRealDash(raw: string): boolean {
  UNICODE_DASH.lastIndex = 0;
  const matched = UNICODE_DASH.test(raw);
  UNICODE_DASH.lastIndex = 0;
  return matched;
}

/**
 * Pattern view for account and other token recognition.
 * Real dashes become one ASCII hyphen. Format characters, including U+00AD,
 * are removed. Each remaining unit still points at the original span, so a
 * match that crosses a removed character covers that character too.
 * Case and other letters stay as they are. Name matching uses `foldIdentifierText`.
 */
export function projectIdentifierPattern(value: string): PatternProjection {
  const startAt: number[] = [];
  const endAt: number[] = [];
  let text = "";
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const raw = String.fromCodePoint(codePoint);
    const next = index + raw.length;
    if (/\p{Cf}/u.test(raw)) {
      index = next;
      continue;
    }
    if (/\p{M}/u.test(raw) && endAt.length > 0) {
      endAt[endAt.length - 1] = next;
      index = next;
      continue;
    }
    const piece = projectedPiece(raw);
    for (let unit = 0; unit < piece.length; unit += 1) {
      text += piece[unit];
      startAt.push(index);
      endAt.push(next);
    }
    index = next;
  }
  return { text, startAt, endAt };
}

export function mapProjectedSpan(
  projection: PatternProjection,
  start: number,
  end: number
): { start: number; end: number } | null {
  if (end <= start) {
    return null;
  }
  const originStart = projection.startAt[start];
  const originEnd = projection.endAt[end - 1];
  if (originStart === undefined || originEnd === undefined || originEnd <= originStart) {
    return null;
  }
  return { start: originStart, end: originEnd };
}

const MONTH_NAMES = new Set([
  "jan",
  "january",
  "feb",
  "february",
  "mar",
  "march",
  "apr",
  "april",
  "may",
  "jun",
  "june",
  "jul",
  "july",
  "aug",
  "august",
  "sep",
  "sept",
  "september",
  "oct",
  "october",
  "nov",
  "november",
  "dec",
  "december",
]);

function isMonthName(value: string): boolean {
  return MONTH_NAMES.has(value.toLowerCase());
}

function projectedSeparator(raw: string): string | null {
  switch (raw) {
    case "\uFF0E":
    case "\u00B7":
    case "\u2024":
    case "\u2027":
      return ".";
    case "\uFF1A":
      return ":";
    case "\uFF03":
      return "#";
    case "\uFF3F":
      return "_";
    case "\u2044":
    case "\u2215":
    case "\uFF0F":
      return "/";
    case "\uFF0B":
      return "+";
    case "\uFF5E":
    case "\u223C":
      return "~";
    case "\uFF0A":
      return "*";
    case "\uFF0C":
      return ",";
    default:
      return null;
  }
}

/** Punctuation that also joins ordinary prose. A dictionary word beside it is not an account. */
const PROSE_JOINERS = new Set([",", "+", "~", "*"]);

const ORDINARY_YEAR_WORDS = new Set([
  "account",
  "amount",
  "annual",
  "balance",
  "balances",
  "bill",
  "billing",
  "council",
  "date",
  "due",
  "energy",
  "fee",
  "fees",
  "form",
  "iso",
  "notice",
  "page",
  "payment",
  "payments",
  "period",
  "record",
  "records",
  "section",
  "supply",
  "tax",
  "total",
  "year",
]);

function isOrdinaryProseYear(letters: string, digits: string): boolean {
  if (!/^(?:19|20)\d{2}$/.test(digits)) {
    return false;
  }
  const word = letters.toLowerCase();
  return isMonthName(word) || ORDINARY_YEAR_WORDS.has(word);
}

export interface AccountTokenSpan {
  start: number;
  end: number;
  raw: string;
}

const IDENTIFIER_SEPARATOR = "[-/_.#:,+~*]";
const TOKEN_EDGE_BEFORE = "(?<![\\p{L}\\p{M}\\p{N}_])";
const TOKEN_EDGE_AFTER = "(?![\\p{L}\\p{M}\\p{N}_])";

function isOrdinaryLabelWord(letters: string): boolean {
  return isMonthName(letters) || ORDINARY_YEAR_WORDS.has(letters.toLowerCase());
}

/**
 * A one- or two-digit tail is an identifier only when the letters are not
 * ordinary notice vocabulary. Lowercase prose such as "pay12" stays.
 */
function skipShortUnlabelledTail(letters: string, digits: string, letterRaw: string): boolean {
  if (digits.length >= 3) {
    return false;
  }
  if (isOrdinaryLabelWord(letters)) {
    return true;
  }
  return !/\p{Lu}/u.test(letterRaw.normalize("NFKC"));
}

/** Letter-digit references, including joined forms and the supported separators. */
export function suspiciousAccountSpans(value: string): AccountTokenSpan[] {
  const projected = projectIdentifierPattern(value);
  const found: AccountTokenSpan[] = [];
  const seen = new Set<string>();
  const push = (start: number, end: number): void => {
    const origin = mapProjectedSpan(projected, start, end);
    if (!origin) {
      return;
    }
    const key = `${origin.start}:${origin.end}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    found.push({
      start: origin.start,
      end: origin.end,
      raw: value.slice(origin.start, origin.end),
    });
  };
  const letterRaw = (start: number, length: number): string => {
    const origin = mapProjectedSpan(projected, start, start + length);
    return origin ? value.slice(origin.start, origin.end) : "";
  };
  const separated = new RegExp(
    `${TOKEN_EDGE_BEFORE}(\\p{L}{2,12})(${IDENTIFIER_SEPARATOR})(\\d{1,12})${TOKEN_EDGE_AFTER}`,
    "gu"
  );
  for (const match of projected.text.matchAll(separated)) {
    if (!match[1] || !match[2] || match[3] === undefined || match.index === undefined) {
      continue;
    }
    if (match[2] === "-" && isMonthName(match[1])) {
      continue;
    }
    if (isOrdinaryProseYear(match[1], match[3])) {
      continue;
    }
    if (
      PROSE_JOINERS.has(match[2]) &&
      isOrdinaryLabelWord(match[1])
    ) {
      continue;
    }
    if (skipShortUnlabelledTail(match[1], match[3], letterRaw(match.index, match[1].length))) {
      continue;
    }
    push(match.index, match.index + match[0].length);
  }
  const joined = new RegExp(
    `${TOKEN_EDGE_BEFORE}(\\p{L}{2,12})(\\d{1,12})${TOKEN_EDGE_AFTER}`,
    "gu"
  );
  for (const match of projected.text.matchAll(joined)) {
    if (!match[1] || match[2] === undefined || match.index === undefined) {
      continue;
    }
    if (isOrdinaryProseYear(match[1], match[2])) {
      continue;
    }
    if (skipShortUnlabelledTail(match[1], match[2], letterRaw(match.index, match[1].length))) {
      continue;
    }
    push(match.index, match.index + match[0].length);
  }
  const spaced = new RegExp(
    `${TOKEN_EDGE_BEFORE}(\\p{Lu}{2,8})[ \\t]+(\\d{2,8})${TOKEN_EDGE_AFTER}`,
    "gu"
  );
  for (const match of projected.text.matchAll(spaced)) {
    if (!match[1] || match[2] === undefined || match.index === undefined) {
      continue;
    }
    if (isOrdinaryLabelWord(match[1]) || isOrdinaryProseYear(match[1], match[2])) {
      continue;
    }
    if (skipShortUnlabelledTail(match[1], match[2], letterRaw(match.index, match[1].length))) {
      continue;
    }
    push(match.index, match.index + match[0].length);
  }
  return found;
}

const LABELLED_IDENTIFIER = new RegExp(
  `${TOKEN_EDGE_BEFORE}(?:(?:account|tenancy|customer|meter)\\s*(?:reference|ref\\.?|number|no\\.?|id)|(?:invoice|payment)\\s*(?:reference|ref\\.?|number|no\\.?|id)|council\\s*tax\\s*(?:reference|ref\\.?|number|no\\.?|id)?|ref(?:erence)?)\\s*[:#.\\-]?\\s*`,
  "giu"
);

const LABELLED_TOKEN =
  /^(?:[\p{L}\p{N}]+(?:[ \t]*[-/_.#:,+~*][ \t]*[\p{L}\p{N}]+)+|\p{L}{1,12}\p{N}{1,12}|\p{N}{2,12}|\p{L}{1,12}[ \t]+\p{N}{1,12})/u;

function readLabelledToken(text: string, start: number): { start: number; end: number } | null {
  const match = LABELLED_TOKEN.exec(text.slice(start));
  if (!match) {
    return null;
  }
  const token = match[0];
  if (!/\d/.test(token)) {
    return null;
  }
  if (/^(?:19|20)\d{2}$/.test(token)) {
    return null;
  }
  const end = start + token.length;
  if (/^\d{1,4}$/.test(token)) {
    const month = /^\s+(\p{L}+)/u.exec(text.slice(end));
    if (month?.[1] && isMonthName(month[1])) {
      return null;
    }
  }
  const monthYear = /^(\p{L}+)[-/]((?:19|20)\d{2})$/u.exec(token);
  if (monthYear?.[1] && monthYear[2] && isOrdinaryLabelWord(monthYear[1])) {
    return null;
  }
  return { start, end };
}

/** A reference that follows an account, customer, meter, invoice, payment, or reference label. */
export function labelledIdentifierSpans(value: string): AccountTokenSpan[] {
  const projected = projectIdentifierPattern(value);
  const found: AccountTokenSpan[] = [];
  const seen = new Set<string>();
  for (const match of projected.text.matchAll(LABELLED_IDENTIFIER)) {
    if (match.index === undefined) {
      continue;
    }
    const token = readLabelledToken(projected.text, match.index + match[0].length);
    if (!token) {
      continue;
    }
    const origin = mapProjectedSpan(projected, token.start, token.end);
    if (!origin) {
      continue;
    }
    const key = `${origin.start}:${origin.end}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    found.push({
      start: origin.start,
      end: origin.end,
      raw: value.slice(origin.start, origin.end),
    });
  }
  return found;
}

/** A letter-digit token whose original span hid a format character inside it. */
export function containsFormatJoinedAccountToken(value: string): boolean {
  const projected = projectIdentifierPattern(value);
  const pattern = new RegExp(`${TOKEN_EDGE_BEFORE}\\p{L}{2,12}\\d{3,12}${TOKEN_EDGE_AFTER}`, "giu");
  for (const match of projected.text.matchAll(pattern)) {
    const index = match.index ?? 0;
    const origin = mapProjectedSpan(projected, index, index + match[0].length);
    if (!origin) {
      continue;
    }
    if (/\p{Cf}/u.test(value.slice(origin.start, origin.end))) {
      return true;
    }
  }
  return false;
}

/**
 * Hyphenated letter-digit tokens are account references in any case.
 * A month name such as Nov-2026 is not. Format characters that join the
 * letters to the digits count as the same token.
 */
export function containsAlphanumericAccountReference(value: string): boolean {
  return (
    containsFormatJoinedAccountToken(value) ||
    suspiciousAccountSpans(value).length > 0 ||
    labelledIdentifierSpans(value).length > 0
  );
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

function normalizedPersonalWords(value: string): string[] {
  const folded = foldIdentifierText(value.trim()).folded;
  if (!folded || /\d/.test(folded)) {
    return [];
  }
  return folded.split(/[\s,]+/).filter((part) => part.length > 0 && part !== "-");
}

export function meaningfulNameComponents(fullName: string): string[] {
  const parts = normalizedPersonalWords(fullName);
  if (parts.length < 2) {
    return [];
  }
  return parts.filter((part) => {
    if (part.length < 3 || NAME_PARTICLES.has(part)) {
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
  const parts = normalizedPersonalWords(value);
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
  const parts = normalizedPersonalWords(value);
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

const SALUTATION_GAP = "[\\t\\n\\r \\u00a0\\u202f\\u2000-\\u200a\\u3000]+";
const ORDINARY_SALUTATION_WORDS = new Set([
  "account",
  "bill",
  "billing",
  "bills",
  "council",
  "customer",
  "department",
  "electricity",
  "energy",
  "gas",
  "notice",
  "service",
  "supplier",
  "support",
  "tax",
  "team",
  "water",
]);

function bareSalutationWord(part: string): string {
  return part.replace(/['’\-]/g, "");
}

/**
 * A Dear/Mr/Mrs/Ms/Miss/Dr greeting with at least two name parts.
 * A greeting made only of ordinary notice words, such as "Dear Energy Billing",
 * is not a person. Names that are not in a greeting stay undetected.
 */
export function salutationNameSpans(value: string): AccountTokenSpan[] {
  // A zero-width mark between the greeting and the name is a gap.
  // The same mark inside a name still joins, so the fold below is unchanged.
  const aligned = value.replace(
    /((?:^|[^\p{L}\p{M}])(?:Dear|Mr|Mrs|Ms|Miss|Dr))[\u200B\u200C\uFEFF]+/giu,
    (match, title: string) => `${title}${" ".repeat(match.length - title.length)}`
  );
  const folded = foldIdentifierText(aligned);
  const pattern = new RegExp(
    `${TOKEN_EDGE_BEFORE}(?:dear|mr|mrs|ms|miss|dr)${SALUTATION_GAP}((?:\\p{L}[\\p{L}\\p{M}'’\\-]*)(?:${SALUTATION_GAP}\\p{L}[\\p{L}\\p{M}'’\\-]*){1,2})${TOKEN_EDGE_AFTER}`,
    "gu"
  );
  const found: AccountTokenSpan[] = [];
  for (const match of folded.folded.matchAll(pattern)) {
    const name = match[1];
    if (!name || match.index === undefined) {
      continue;
    }
    const parts = name.trim().split(new RegExp(SALUTATION_GAP, "u")).filter((part) => part.length > 0);
    let kept = parts.length;
    while (kept > 2 && ORDINARY_SALUTATION_WORDS.has(bareSalutationWord(parts[kept - 1] ?? ""))) {
      kept -= 1;
    }
    const keptParts = parts.slice(0, kept);
    const significant = keptParts.filter((part) => {
      const bare = bareSalutationWord(part);
      return bare.length >= 3 && !NAME_PARTICLES.has(bare);
    });
    if (significant.length === 0) {
      continue;
    }
    if (significant.every((part) => ORDINARY_SALUTATION_WORDS.has(bareSalutationWord(part)))) {
      continue;
    }
    let cursor = 0;
    for (const part of keptParts) {
      const at = name.indexOf(part, cursor);
      if (at < 0) {
        cursor = -1;
        break;
      }
      cursor = at + part.length;
    }
    if (cursor <= 0) {
      continue;
    }
    const nameStart = match.index + match[0].lastIndexOf(name);
    const origin = mapFoldedMatch(folded, nameStart, nameStart + cursor);
    if (!origin) {
      continue;
    }
    found.push({
      start: origin.start,
      end: origin.end,
      raw: value.slice(origin.start, origin.end),
    });
  }
  return found;
}

export function containsPersonalSalutation(value: string): boolean {
  return salutationNameSpans(value).length > 0;
}

function spanInsideDetectedAccount(
  span: OriginalSpan,
  accountOccurrences: readonly OriginalSpan[]
): boolean {
  return accountOccurrences.some(
    (account) =>
      span.start >= account.start &&
      span.end <= account.end &&
      account.end - account.start > span.end - span.start
  );
}

function componentSpans(
  text: string,
  component: string,
  detectedAccountValues: readonly string[] = []
): OriginalSpan[] {
  const needle = prepareForMatch(component);
  if (!needle) {
    return [];
  }
  const folded = foldIdentifierText(text);
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}_])${escapeRegExp(needle)}(?![\\p{L}\\p{M}\\p{N}_])`,
    "gu"
  );
  const accountOccurrences = detectedAccountValues.flatMap((account) =>
    findFoldedOccurrences(text, account)
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
    if (spanInsideDetectedAccount(span, accountOccurrences)) {
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
  replacement: string,
  detectedAccountValues: readonly string[] = []
): string {
  if (!component) {
    return input;
  }
  return replaceSpans(
    input,
    componentSpans(input, component, detectedAccountValues),
    replacement
  );
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
  if (clean.length < 2) {
    return false;
  }
  if (clean.length < 3) {
    if (!/\d/.test(clean)) {
      return false;
    }
    const needle = prepareForMatch(clean);
    if (needle.length < 2) {
      return false;
    }
    const pattern = new RegExp(
      `${TOKEN_EDGE_BEFORE}${escapeRegExp(needle)}${TOKEN_EDGE_AFTER}`,
      "u"
    );
    return pattern.test(prepareForMatch(text));
  }
  if (isPersonalName(clean)) {
    if (personalNameSpans(text, clean).length > 0) {
      return true;
    }
    const components = meaningfulNameComponents(clean);
    const words = components.length > 0 ? components : normalizedPersonalWords(clean);
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

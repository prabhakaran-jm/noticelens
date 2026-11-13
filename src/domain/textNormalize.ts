/**
 * Shared text folding for identifier detection, redaction, and cloud checks.
 * Dash replacement is one code unit to one ASCII hyphen, so match offsets stay aligned.
 */

const UNICODE_DASH =
  /[\u00AD\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D\u2043]/g;

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

export function compactIdentifier(value: string): string {
  return normalizeDashes(value)
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .toLowerCase()
    .replace(/[\s-]/g, "");
}

/**
 * Letter-only parts of a known multi-word personal name.
 * Account references and single tokens are not split into names.
 */
const NAME_WORD = /^[\p{L}][\p{L}'’\-]*$/u;

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
  return normalizeDashes(value)
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .toLowerCase();
}

/** Format characters may sit between letters. Ordinary spaces stay word breaks. */
function componentBody(component: string): string {
  return [...prepareForMatch(component)].map((char) => escapeRegExp(char)).join("\\p{Cf}*");
}

function componentPattern(component: string): RegExp {
  return new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}_])${componentBody(component)}(?![\\p{L}\\p{M}\\p{N}_])`,
    "giu"
  );
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
function isDomainUseAt(text: string, start: number, end: number, component: string): boolean {
  const word = prepareForMatch(component);
  const before = text.slice(0, start);
  const after = text.slice(end);
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

function letterSpacedNamePattern(fullName: string): RegExp | null {
  const parts = personalNameParts(fullName);
  const compactId = compactIdentifier(fullName);
  if (parts.length < 2 || compactId.length < 6) {
    return null;
  }
  const body = [...compactId]
    .map((char) => escapeRegExp(char))
    .join("\\p{Cf}*[ \\t\\u00A0-]{0,3}\\p{Cf}*");
  return new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}_])${body}(?![\\p{L}\\p{M}\\p{N}_])`,
    "giu"
  );
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
  if (!word) {
    return false;
  }
  return componentPattern(word).test(haystack);
}

/** A name component matches a whole word, never a fragment such as Bill inside billing. */
export function nameComponentMatches(text: string, component: string): boolean {
  if (!prepareForMatch(component)) {
    return false;
  }
  for (const match of text.matchAll(componentPattern(component))) {
    const start = match.index ?? 0;
    const token = match[0] ?? "";
    if (isDomainUseAt(text, start, start + token.length, component)) {
      continue;
    }
    return true;
  }
  return false;
}

export function replaceNameComponent(
  input: string,
  component: string,
  replacement: string
): string {
  if (!component) {
    return input;
  }
  return input.replace(componentPattern(component), (match, offset) => {
    if (isDomainUseAt(input, offset, offset + match.length, component)) {
      return match;
    }
    return replacement;
  });
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
  const pattern = letterSpacedNamePattern(fullName);
  const compactId = compactIdentifier(fullName);
  if (!pattern || compactId.length < 6) {
    return input;
  }
  return input.replace(pattern, (match) =>
    compactIdentifier(match) === compactId ? replacement : match
  );
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
    if (parts.length >= 2) {
      const phrase = parts.map((part) => escapeRegExp(prepareForMatch(part))).join("[\\s,]+");
      const phrasePattern = new RegExp(
        `(?<![\\p{L}\\p{M}\\p{N}_])${phrase}(?![\\p{L}\\p{M}\\p{N}_])`,
        "iu"
      );
      if (phrasePattern.test(prepareForMatch(text))) {
        return true;
      }
      const compactId = compactIdentifier(clean);
      if (compactId.length >= 6 && compactIdentifier(text).includes(compactId)) {
        return true;
      }
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

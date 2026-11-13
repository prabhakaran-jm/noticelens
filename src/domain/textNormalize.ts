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
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
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
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .toLowerCase();
}

function isPersonalName(value: string): boolean {
  const parts = value.trim().split(/[\s,]+/).filter((part) => part.length > 0);
  return parts.length > 0 && parts.every((part) => NAME_WORD.test(part));
}

function wholeWordPattern(word: string): RegExp {
  return new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}_])${escapeRegExp(word)}(?![\\p{L}\\p{M}\\p{N}_])`,
    "giu"
  );
}

/**
 * A surname or given name that is also ordinary notice language.
 * It is protected when it stands alone, and left in place inside a domain phrase.
 */
function isAmbiguousDomainUse(window: string, component: string): boolean {
  const word = component.toLowerCase();
  const sample = window.toLowerCase();
  if (word === "energy") {
    return (
      /(?<![\p{L}\p{N}_])energy[\s-]+(?:billing|bills?|supplier|supply|account|charges?|usage|costs?)(?![\p{L}\p{N}_])/iu.test(
        sample
      ) ||
      /(?<![\p{L}\p{N}_])(?:electricity|gas|water|dual)[\s-]+energy(?![\p{L}\p{N}_])/iu.test(
        sample
      )
    );
  }
  if (word === "bill") {
    return (
      /(?<![\p{L}\p{N}_])(?:energy|council|tax|water|gas|phone|final|this|the|your|a|an)[\s-]+bill(?![\p{L}\p{N}_])/iu.test(
        sample
      ) ||
      /(?<![\p{L}\p{N}_])bill[\s-]+(?:payment|pay|due|amount|total)(?![\p{L}\p{N}_])/iu.test(
        sample
      )
    );
  }
  return false;
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
  return wholeWordPattern(word).test(prepareForMatch(haystack));
}

/** A name component matches a whole word, never a fragment such as Bill inside billing. */
export function nameComponentMatches(text: string, component: string): boolean {
  const prepared = prepareForMatch(text);
  const needle = prepareForMatch(component);
  if (!needle) {
    return false;
  }
  for (const match of prepared.matchAll(wholeWordPattern(needle))) {
    const start = match.index ?? 0;
    const window = prepared.slice(Math.max(0, start - 32), start + needle.length + 32);
    if (isAmbiguousDomainUse(window, needle)) {
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
  const needle = prepareForMatch(component);
  return input.replace(wholeWordPattern(component), (match, offset) => {
    const window = input.slice(Math.max(0, offset - 32), offset + match.length + 32);
    if (isAmbiguousDomainUse(window, needle)) {
      return match;
    }
    return replacement;
  });
}

/**
 * Shared leak rule for redaction and cloud validation.
 * Personal-name components use whole words. Account references still use compact matching.
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

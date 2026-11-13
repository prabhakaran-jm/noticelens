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
    return /^[A-Za-z][A-Za-z''’-]*$/.test(part);
  });
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
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z])${escaped}([^A-Za-z]|$)`, "i").test(haystack);
}

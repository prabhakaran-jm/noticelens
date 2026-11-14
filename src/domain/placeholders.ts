/** Canonical placeholder tokens shared by redaction, cloud prompts, and local restore. */
export const CANONICAL_PLACEHOLDER_BASES = [
  "RECIPIENT_NAME",
  "ACCOUNT_REF",
  "SUPPLY_ADDRESS",
  "EMAIL",
  "PHONE",
  "NINO",
  "LOCAL_ID",
] as const;

export type CanonicalPlaceholderBase = (typeof CANONICAL_PLACEHOLDER_BASES)[number];

const BASE_PATTERN = CANONICAL_PLACEHOLDER_BASES.join("|");
const CANONICAL_PLACEHOLDER_SOURCE = `\\[(?:${BASE_PATTERN})(?:_[1-9]\\d*)?\\]`;
const CANONICAL_PLACEHOLDER_EXACT = new RegExp(`^${CANONICAL_PLACEHOLDER_SOURCE}$`);

export function formatCanonicalPlaceholder(
  base: CanonicalPlaceholderBase,
  index: number
): string {
  if (index <= 0) {
    return `[${base}]`;
  }
  return `[${base}_${index + 1}]`;
}

export function isCanonicalPlaceholder(token: string): boolean {
  return CANONICAL_PLACEHOLDER_EXACT.test(token);
}

/** Digits still attached to a canonical placeholder are an incomplete identifier. */
export function hasPartialPlaceholderIdentifier(text: string): boolean {
  const pattern = new RegExp(
    `\\[(?:${BASE_PATTERN})(?:_[1-9]\\d*)?\\](?!\\s+[A-Za-z])\\s*[-/]?\\s*\\d`,
    "i"
  );
  return pattern.test(text);
}

function isOpener(ch: string): boolean {
  return ch === "[" || ch === "{" || ch === "［";
}

function isCloser(ch: string): boolean {
  return ch === "]" || ch === "}" || ch === "］";
}

function openerCount(token: string): number {
  return token.match(/[\[{［]/g)?.length ?? 0;
}

function isPlaceholderShaped(token: string): boolean {
  if (token === "[]" || token === "［］" || token === "{}") {
    return true;
  }
  if (!/[A-Za-z]/.test(token)) {
    return false;
  }
  if (openerCount(token) >= 2 || /^\{\{/.test(token) || /^\[\[/.test(token)) {
    return true;
  }
  if (token.startsWith("{") || token.startsWith("［")) {
    return /[A-Za-z]/.test(token);
  }
  return true;
}

/**
 * Canonical, unknown, and malformed placeholder tokens, in order.
 * Nested braces, doubled brackets, unclosed, lowercase, spaced, and fullwidth forms are included.
 * A canonical token such as [RECIPIENT_NAME] is unchanged.
 */
export function listPlaceholderTokens(text: string): string[] {
  const found: string[] = [];
  let index = 0;
  while (index < text.length) {
    if (!isOpener(text[index]!)) {
      index += 1;
      continue;
    }
    let depth = 0;
    let end = -1;
    for (let cursor = index; cursor < text.length && cursor - index <= 80; cursor += 1) {
      const next = text[cursor]!;
      if (next === "\n" || next === "\r") {
        break;
      }
      if (isOpener(next)) {
        depth += 1;
        continue;
      }
      if (isCloser(next)) {
        depth -= 1;
        if (depth === 0) {
          end = cursor;
          break;
        }
      }
    }
    if (end < 0) {
      let cursor = index + 1;
      while (
        cursor < text.length &&
        cursor - index <= 40 &&
        !/\s/.test(text[cursor]!) &&
        !isCloser(text[cursor]!)
      ) {
        cursor += 1;
      }
      const token = text.slice(index, cursor);
      if (isPlaceholderShaped(token)) {
        found.push(token);
      }
      index = Math.max(cursor, index + 1);
      continue;
    }
    const token = text.slice(index, end + 1);
    if (isPlaceholderShaped(token)) {
      found.push(token);
    }
    index = end + 1;
  }
  return found;
}

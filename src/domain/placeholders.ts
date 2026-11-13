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

function isPlaceholderShaped(token: string): boolean {
  if (token.startsWith("{")) {
    return /^\{[A-Za-z][A-Za-z0-9_]*\}$/.test(token);
  }
  if (token === "[]" || token === "［］") {
    return true;
  }
  return /[A-Za-z]/.test(token);
}

/**
 * Canonical, unknown, and malformed placeholder tokens, in order.
 * Unclosed, doubled, lowercase, spaced, and fullwidth forms are included.
 */
export function listPlaceholderTokens(text: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const opener = text[index]!;
    if (opener !== "[" && opener !== "［" && opener !== "{") {
      continue;
    }
    let end = -1;
    for (let cursor = index + 1; cursor < text.length && cursor - index <= 80; cursor += 1) {
      const next = text[cursor]!;
      if (next === "\n" || next === "\r") {
        break;
      }
      if (next === "]" || next === "］" || next === "}") {
        end = cursor;
        break;
      }
    }
    if (end < 0) {
      let cursor = index + 1;
      while (cursor < text.length && cursor - index <= 40 && !/\s/.test(text[cursor]!)) {
        cursor += 1;
      }
      const token = text.slice(index, cursor);
      if (/^[\[［{][A-Za-z]/.test(token)) {
        found.push(token);
      }
      index = Math.max(cursor - 1, index);
      continue;
    }
    const token = text.slice(index, end + 1);
    if (isPlaceholderShaped(token)) {
      found.push(token);
    }
    index = end;
  }
  return found;
}

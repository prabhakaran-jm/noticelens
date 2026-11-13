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
const PLACEHOLDER_SHAPED = /\[[A-Z][A-Z0-9_]*\]/g;

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

/** Placeholder-shaped tokens in `text`, in order, including unknown ones. */
export function listPlaceholderTokens(text: string): string[] {
  return text.match(PLACEHOLDER_SHAPED) ?? [];
}

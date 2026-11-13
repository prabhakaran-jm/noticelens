export type AmountRead =
  | { status: "missing" }
  | { status: "value"; value: number }
  | { status: "rejected"; reason: "negative" | "ambiguous" | "unsupported" };

export interface SourcedAmount {
  value: number;
  raw: string;
  index: number;
}

const CURRENCY_TOKEN =
  /[+-]?\s*£\s*[+-]?(?:\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,]\d+)?/gi;

export function hasAtMostTwoDecimalPlaces(value: number): boolean {
  if (!Number.isFinite(value) || Object.is(value, -0)) {
    return false;
  }
  const cents = Math.round(value * 100);
  return Math.abs(value * 100 - cents) < 1e-6;
}

/**
 * Reads a monetary amount.
 * Empty and missing inputs are missing, never £0.
 * Supported text forms are explicit: 1280, 645.50, £1,280, £1,280.00, £0.
 * Grouping such as £1.280 is rejected as locale-ambiguous.
 */
export function readAmount(input: unknown): AmountRead {
  if (input === null || input === undefined) {
    return { status: "missing" };
  }
  if (typeof input === "number") {
    if (Object.is(input, -0) || !Number.isFinite(input)) {
      return { status: "rejected", reason: "unsupported" };
    }
    if (input < 0) {
      return { status: "rejected", reason: "negative" };
    }
    if (!hasAtMostTwoDecimalPlaces(input)) {
      return { status: "rejected", reason: "unsupported" };
    }
    return { status: "value", value: input };
  }
  if (typeof input !== "string") {
    return { status: "rejected", reason: "unsupported" };
  }
  const trimmed = input.trim();
  if (trimmed.length === 0 || /^not stated$/i.test(trimmed)) {
    return { status: "missing" };
  }
  return parseAmountText(trimmed);
}

function parseAmountText(raw: string): AmountRead {
  const token = raw.replace(/\s+/g, "");
  if (/^-/.test(token) || /^£-/.test(token) || /^-£/.test(token)) {
    return { status: "rejected", reason: "negative" };
  }
  const body = token.replace(/^£/i, "");
  if (body.length === 0) {
    return { status: "missing" };
  }
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(body) || /^\d+\.\d{3}$/.test(body)) {
    return { status: "rejected", reason: "ambiguous" };
  }
  if (/^\d+,\d{1,2}$/.test(body)) {
    return { status: "rejected", reason: "ambiguous" };
  }
  let normalized: string;
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(body) || /^\d+(\.\d{1,2})?$/.test(body)) {
    normalized = body.replace(/,/g, "");
  } else {
    return { status: "rejected", reason: "unsupported" };
  }
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0 || !hasAtMostTwoDecimalPlaces(value)) {
    return { status: "rejected", reason: "unsupported" };
  }
  return { status: "value", value };
}

export function findExplicitGbpAmounts(text: string): {
  amounts: SourcedAmount[];
  rejected: number;
} {
  const amounts: SourcedAmount[] = [];
  let rejected = 0;
  for (const match of text.matchAll(CURRENCY_TOKEN)) {
    const raw = match[0] ?? "";
    const read = readAmount(raw);
    if (read.status === "value") {
      amounts.push({ value: read.value, raw, index: match.index ?? 0 });
    } else if (read.status === "rejected") {
      rejected += 1;
    }
  }
  return { amounts, rejected };
}

export function distinctAmountValues(amounts: readonly SourcedAmount[]): number[] {
  const values: number[] = [];
  for (const amount of amounts) {
    if (!values.some((value) => Math.abs(value - amount.value) < 0.001)) {
      values.push(amount.value);
    }
  }
  return values;
}

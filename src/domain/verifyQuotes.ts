import type {
  QuoteVerificationResult,
  RawNoticeExtraction,
  VerifiedNoticeExtraction,
} from "./types";

const MIN_VERIFIABLE_QUOTE_LENGTH = 4;

interface NormalizedTextMap {
  normalized: string;
  normToOrigStart: number[];
  normToOrigEnd: number[];
}

function normalizeChar(ch: string): string {
  if (ch === "\u2018" || ch === "\u2019") {
    return "'";
  }
  if (ch === "\u201C" || ch === "\u201D") {
    return '"';
  }
  if (ch === "\u2013" || ch === "\u2014") {
    return "-";
  }
  return ch;
}

function buildNormalizedMap(input: string): NormalizedTextMap {
  const chars: string[] = [];
  const normToOrigStart: number[] = [];
  const normToOrigEnd: number[] = [];

  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      const wsStart = i;
      while (i < input.length && /\s/.test(input[i]!)) {
        i += 1;
      }
      if (chars.length > 0) {
        chars.push(" ");
        normToOrigStart.push(wsStart);
        normToOrigEnd.push(i);
      }
    } else {
      chars.push(normalizeChar(ch));
      normToOrigStart.push(i);
      normToOrigEnd.push(i + 1);
      i += 1;
    }
  }

  if (chars.length > 0 && chars[chars.length - 1] === " ") {
    chars.pop();
    normToOrigStart.pop();
    normToOrigEnd.pop();
  }

  return {
    normalized: chars.join(""),
    normToOrigStart,
    normToOrigEnd,
  };
}

function stripSurroundingQuotationMarks(rawQuote: string): string {
  const trimmed = rawQuote.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith("\u201C") && trimmed.endsWith("\u201D")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function verifyQuoteInSource(
  sourceText: string,
  quote: string
): QuoteVerificationResult {
  const unverified: QuoteVerificationResult = {
    verified: false,
    matchMode: "unverified",
    startOffset: null,
    endOffset: null,
    matchedSubstring: null,
  };

  if (!sourceText || !quote) {
    return unverified;
  }

  const cleanedQuote = stripSurroundingQuotationMarks(quote);
  if (cleanedQuote.replace(/\s+/g, "").length < MIN_VERIFIABLE_QUOTE_LENGTH) {
    return unverified;
  }

  const exactDirectIndex = sourceText.indexOf(quote);
  if (
    exactDirectIndex !== -1 &&
    quote.replace(/\s+/g, "").length >= MIN_VERIFIABLE_QUOTE_LENGTH
  ) {
    const endOffset = exactDirectIndex + quote.length;
    return {
      verified: true,
      matchMode: "exact",
      startOffset: exactDirectIndex,
      endOffset,
      matchedSubstring: sourceText.slice(exactDirectIndex, endOffset),
    };
  }

  const exactTrimmedIndex = sourceText.indexOf(cleanedQuote);
  if (exactTrimmedIndex !== -1) {
    const endOffset = exactTrimmedIndex + cleanedQuote.length;
    return {
      verified: true,
      matchMode: "exact",
      startOffset: exactTrimmedIndex,
      endOffset,
      matchedSubstring: sourceText.slice(exactTrimmedIndex, endOffset),
    };
  }

  const sourceMap = buildNormalizedMap(sourceText);
  const quoteMap = buildNormalizedMap(cleanedQuote);

  if (quoteMap.normalized.length < MIN_VERIFIABLE_QUOTE_LENGTH) {
    return unverified;
  }

  const normMatchIndex = sourceMap.normalized.indexOf(quoteMap.normalized);
  if (normMatchIndex === -1) {
    return unverified;
  }

  const normEndIndex = normMatchIndex + quoteMap.normalized.length - 1;
  const startOffset = sourceMap.normToOrigStart[normMatchIndex];
  const endOffset = sourceMap.normToOrigEnd[normEndIndex];

  if (startOffset === undefined || endOffset === undefined) {
    return unverified;
  }

  return {
    verified: true,
    matchMode: "normalized",
    startOffset,
    endOffset,
    matchedSubstring: sourceText.slice(startOffset, endOffset),
  };
}

export function attachQuoteVerification(
  sourceText: string,
  extraction: RawNoticeExtraction
): VerifiedNoticeExtraction {
  return {
    ...extraction,
    obligations: extraction.obligations.map((item) => ({
      ...item,
      verification: verifyQuoteInSource(sourceText, item.sourceQuote),
    })),
  };
}

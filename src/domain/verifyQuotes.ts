import type {
  QuoteVerificationResult,
  RawNoticeExtraction,
  UnverifiedQuoteReason,
  VerifiedNoticeExtraction,
} from "./types";

const MIN_VERIFIABLE_QUOTE_LENGTH = 4;

interface NormalizedTextMap {
  normalized: string;
  normToOrigStart: number[];
  normToOrigEnd: number[];
}

function unverified(reason: UnverifiedQuoteReason): QuoteVerificationResult {
  return {
    verified: false,
    matchMode: "unverified",
    startOffset: null,
    endOffset: null,
    matchedSubstring: null,
    unverifiedReason: reason,
  };
}

function isSkippableInvisible(ch: string): boolean {
  return (
    ch === "\u200B" ||
    ch === "\u200C" ||
    ch === "\u200D" ||
    ch === "\u2060" ||
    ch === "\uFEFF" ||
    ch === "\u00AD" ||
    /\p{Cf}/u.test(ch)
  );
}

function normalizeChar(ch: string): string {
  if (ch === "\u2018" || ch === "\u2019" || ch === "\u02BC" || ch === "\uFF07") {
    return "'";
  }
  if (ch === "\u201C" || ch === "\u201D") {
    return '"';
  }
  if (/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/.test(ch)) {
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
    const cp = input.codePointAt(i);
    if (cp === undefined) {
      break;
    }
    const raw = String.fromCodePoint(cp);
    const next = i + raw.length;
    if (isSkippableInvisible(raw)) {
      i = next;
      continue;
    }
    if (/\s/.test(raw)) {
      const wsStart = i;
      i = next;
      while (i < input.length) {
        const nextCp = input.codePointAt(i);
        if (nextCp === undefined) {
          break;
        }
        const nextRaw = String.fromCodePoint(nextCp);
        if (isSkippableInvisible(nextRaw) || /\s/.test(nextRaw)) {
          i += nextRaw.length;
          continue;
        }
        break;
      }
      if (chars.length > 0) {
        chars.push(" ");
        normToOrigStart.push(wsStart);
        normToOrigEnd.push(i);
      }
    } else {
      let cluster = normalizeChar(raw);
      const clusterStart = i;
      let clusterEnd = next;
      let cursor = next;
      while (cursor < input.length) {
        const markCp = input.codePointAt(cursor);
        if (markCp === undefined) {
          break;
        }
        const markRaw = String.fromCodePoint(markCp);
        if (isSkippableInvisible(markRaw)) {
          cursor += markRaw.length;
          clusterEnd = cursor;
          continue;
        }
        if (/\p{M}/u.test(markRaw)) {
          cluster += markRaw;
          cursor += markRaw.length;
          clusterEnd = cursor;
          continue;
        }
        break;
      }
      const nfc = cluster.normalize("NFC");
      for (let u = 0; u < nfc.length; u += 1) {
        chars.push(nfc[u]!);
        normToOrigStart.push(clusterStart);
        normToOrigEnd.push(clusterEnd);
      }
      i = cursor;
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
  if (!quote || quote.trim().length === 0) {
    return unverified("empty");
  }
  if (!sourceText) {
    return unverified("not_in_source");
  }

  const cleanedQuote = stripSurroundingQuotationMarks(quote);
  if (cleanedQuote.replace(/\s+/g, "").length < MIN_VERIFIABLE_QUOTE_LENGTH) {
    return unverified("too_short");
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
      unverifiedReason: null,
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
      unverifiedReason: null,
    };
  }

  const sourceMap = buildNormalizedMap(sourceText);
  const quoteMap = buildNormalizedMap(cleanedQuote);

  if (quoteMap.normalized.length < MIN_VERIFIABLE_QUOTE_LENGTH) {
    return unverified("too_short");
  }

  const normMatchIndex = sourceMap.normalized.indexOf(quoteMap.normalized);
  if (normMatchIndex === -1) {
    return unverified("not_in_source");
  }

  const normEndIndex = normMatchIndex + quoteMap.normalized.length - 1;
  const startOffset = sourceMap.normToOrigStart[normMatchIndex];
  const endOffset = sourceMap.normToOrigEnd[normEndIndex];

  if (startOffset === undefined || endOffset === undefined) {
    return unverified("not_in_source");
  }

  return {
    verified: true,
    matchMode: "normalized",
    startOffset,
    endOffset,
    matchedSubstring: sourceText.slice(startOffset, endOffset),
    unverifiedReason: null,
  };
}

export interface FlaggedQuote {
  quote: string;
  verification: QuoteVerificationResult;
  flagged: boolean;
}

/** Returns one result per quote, including unmatched and fabricated quotes. */
export function verifyQuotesAgainstSource(
  sourceText: string,
  quotes: readonly string[]
): FlaggedQuote[] {
  return quotes.map((quote) => {
    const verification = verifyQuoteInSource(sourceText, quote);
    return {
      quote,
      verification,
      flagged: verification.verified === false,
    };
  });
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

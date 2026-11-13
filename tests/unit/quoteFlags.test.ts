import { describe, expect, it } from "vitest";
import { verifyQuoteInSource, verifyQuotesAgainstSource } from "../../src/domain/verifyQuotes";
import { BENCHMARK_NOTICE_FIXTURES } from "../../src/fixtures/benchmarkNotices";

describe("quote flags — unmatched and fabricated quotations stay visible", () => {
  const source = BENCHMARK_NOTICE_FIXTURES[0]!.rawText;
  const realQuote =
    "Our records show an outstanding balance of £1,280 for electricity supplied between January and June 2025.";

  it("returns exclusive character offsets into the independent notice text", () => {
    const result = verifyQuoteInSource(source, realQuote);
    expect(result.verified).toBe(true);
    expect(result.unverifiedReason).toBeNull();
    expect(source.slice(result.startOffset!, result.endOffset!)).toBe(realQuote);
    expect(result.matchedSubstring).toBe(realQuote);
  });

  it("keeps every quote, including fabricated ones, instead of dropping them", () => {
    const fabricated = "The supplier has cancelled the £1,280 balance.";
    const flagged = verifyQuotesAgainstSource(source, [
      realQuote,
      fabricated,
      "Our records show an outstanding balance of £1,200 for electricity supplied between January and June 2025.",
    ]);

    expect(flagged).toHaveLength(3);
    expect(flagged[0]?.flagged).toBe(false);
    expect(flagged[1]?.flagged).toBe(true);
    expect(flagged[1]?.verification.unverifiedReason).toBe("not_in_source");
    expect(flagged[2]?.verification.verified).toBe(false);
  });

  it("does not accept a quote that only matches after words are removed", () => {
    const shortened =
      "Our records show an outstanding balance of £1,280 for electricity supplied January and June 2025.";
    const result = verifyQuoteInSource(source, shortened);
    expect(result.verified).toBe(false);
    expect(result.unverifiedReason).toBe("not_in_source");
    expect(result.startOffset).toBeNull();
  });

  it("does not accept a homoglyph lookalike as the source sentence", () => {
    const homoglyph = realQuote.replace("show", "sh\u043Ew");
    const result = verifyQuoteInSource(source, homoglyph);
    expect(result.verified).toBe(false);
    expect(result.unverifiedReason).toBe("not_in_source");
  });

  it("still verifies a real quote when a zero-width character was inserted", () => {
    const withInvisible = realQuote.replace("records", "rec\u200Bords");
    const result = verifyQuoteInSource(source, withInvisible);
    expect(result.verified).toBe(true);
    expect(result.matchMode).toBe("normalized");
    expect(source.slice(result.startOffset!, result.endOffset!)).toBe(result.matchedSubstring);
    expect(result.matchedSubstring).not.toContain("\u200B");
  });

  it("flags empty, tiny, and missing-source quotes with a reason", () => {
    expect(verifyQuoteInSource(source, "   ").unverifiedReason).toBe("empty");
    expect(verifyQuoteInSource(source, "by").unverifiedReason).toBe("too_short");
    expect(verifyQuoteInSource("", realQuote).unverifiedReason).toBe("not_in_source");
  });
});

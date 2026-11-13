import { describe, expect, it } from "vitest";
import {
  attachQuoteVerification,
  verifyQuoteInSource,
} from "../../src/domain/verifyQuotes";
import { BENCHMARK_NOTICE_FIXTURES } from "../../src/fixtures/benchmarkNotices";

describe("verifyQuoteInSource — deterministic independent quote verification", () => {
  const originalFixture = BENCHMARK_NOTICE_FIXTURES[0]!;
  const revisedFixture = BENCHMARK_NOTICE_FIXTURES[1]!;

  it("verifies exact verbatim substrings and returns exact character offsets", () => {
    const quote =
      "Our records show an outstanding balance of £1,280 for electricity supplied between January and June 2025.";
    const result = verifyQuoteInSource(originalFixture.rawText, quote);

    expect(result.verified).toBe(true);
    expect(result.matchMode).toBe("exact");
    expect(result.startOffset).not.toBeNull();
    expect(result.endOffset).not.toBeNull();
    expect(
      originalFixture.rawText.slice(result.startOffset!, result.endOffset!)
    ).toBe(quote);
  });

  it("verifies quotes wrapped in quotation marks or with normalized line-break whitespace", () => {
    const multilineNormalizedQuote =
      '"Please pay the balance   or\ncontact our billing team by 25 November 2026 to discuss your account."';
    const result = verifyQuoteInSource(
      originalFixture.rawText,
      multilineNormalizedQuote
    );

    expect(result.verified).toBe(true);
    expect(result.matchMode).toBe("normalized");
    expect(result.matchedSubstring).toBe(
      "Please pay the balance or contact our billing team by 25 November 2026 to discuss your account."
    );
  });

  it("flags paraphrased, hallucinated, or amount-tampered quotes as unverified", () => {
    const hallucinated =
      "Our records show an outstanding balance of £1,200 for electricity supplied between January and June 2025.";
    const result = verifyQuoteInSource(originalFixture.rawText, hallucinated);

    expect(result.verified).toBe(false);
    expect(result.matchMode).toBe("unverified");
    expect(result.startOffset).toBeNull();
    expect(result.endOffset).toBeNull();
  });

  it("rejects empty or trivial <4 character strings so punctuation never verifies", () => {
    expect(verifyQuoteInSource(originalFixture.rawText, "").verified).toBe(
      false
    );
    expect(verifyQuoteInSource(originalFixture.rawText, "   ").verified).toBe(
      false
    );
    expect(verifyQuoteInSource(originalFixture.rawText, "by").verified).toBe(
      false
    );
  });

  it("verifies canonical quotes across all 5 synthetic benchmark fixtures including £520 revised bill", () => {
    expect(revisedFixture.expected.amountGBP).toBe(520);
    for (const fixture of BENCHMARK_NOTICE_FIXTURES) {
      for (const quote of fixture.expected.canonicalQuotes) {
        const check = verifyQuoteInSource(fixture.rawText, quote);
        expect(check.verified).toBe(true);
      }
    }
  });

  it("attaches per-obligation verification metadata without dropping unmatched claims silently", () => {
    const verified = attachQuoteVerification(originalFixture.rawText, {
      noticeCategory: "utility_electricity",
      issueDate: "18 November 2026",
      billingPeriod: "January and June 2025",
      amountGBP: 1280,
      responseDeadline: "25 November 2026",
      obligations: [
        {
          action: "Contact billing team",
          dueDate: "25 November 2026",
          sourceQuote:
            "Please pay the balance or contact our billing team by 25 November 2026 to discuss your account.",
        },
        {
          action: "Hallucinated obligation",
          dueDate: null,
          sourceQuote: "This sentence does not exist in the notice.",
        },
      ],
    });

    expect(verified.obligations).toHaveLength(2);
    expect(verified.obligations[0]?.verification.verified).toBe(true);
    expect(verified.obligations[1]?.verification.verified).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  evaluateExtraction,
  summarizeBenchmarkSuite,
} from "../../src/benchmark/evaluateExtraction";
import { BENCHMARK_NOTICE_FIXTURES } from "../../src/fixtures/benchmarkNotices";

describe("evaluateExtraction & summarizeBenchmarkSuite — 5-fixture evaluator", () => {
  it("contains exactly 5 synthetic UK household notice fixtures covering utility, council, and housing", () => {
    expect(BENCHMARK_NOTICE_FIXTURES).toHaveLength(5);
    const categories = BENCHMARK_NOTICE_FIXTURES.map(
      (f) => f.expected.noticeCategory
    );
    expect(categories).toContain("utility_electricity");
    expect(categories).toContain("utility_gas");
    expect(categories).toContain("council_tax");
    expect(categories).toContain("housing_service_charge");
  });

  it("scores 100% when amount, deadline, period, action, and verbatim quotes match", () => {
    const fixture = BENCHMARK_NOTICE_FIXTURES[0]!;
    const evalResult = evaluateExtraction(
      fixture,
      {
        noticeCategory: "utility_electricity",
        issueDate: "18 November 2026",
        billingPeriod: "January and June 2025",
        amountGBP: 1280,
        responseDeadline: "25 November 2026",
        obligations: fixture.expected.canonicalQuotes.map((q) => ({
          action: "Pay balance or contact billing team with meter records",
          dueDate: "25 November 2026",
          sourceQuote: q,
        })),
      },
      { latencyMs: 1420, inferenceSource: "on_device" }
    );

    expect(evalResult.amountExact).toBe(true);
    expect(evalResult.deadlineMatch).toBe(true);
    expect(evalResult.billingPeriodMatch).toBe(true);
    expect(evalResult.allQuotesVerified).toBe(true);
    expect(evalResult.overallFieldAccuracyPct).toBe(100);
  });

  it("penalizes fabricated quotes and computes median/mean latency across runs", () => {
    const fixture = BENCHMARK_NOTICE_FIXTURES[2]!;
    const badEval = evaluateExtraction(
      fixture,
      {
        noticeCategory: "utility_gas",
        issueDate: "20 November 2026",
        billingPeriod: "1 April 2025 to 30 September 2025",
        amountGBP: 645.5,
        responseDeadline: "4 December 2026",
        obligations: [
          {
            action: "Contact support team to review gas bill",
            dueDate: "4 December 2026",
            sourceQuote: "Fabricated quote not present in notice.",
          },
        ],
      },
      { latencyMs: 2800, inferenceSource: "on_device" }
    );

    expect(badEval.allQuotesVerified).toBe(false);
    expect(badEval.overallFieldAccuracyPct).toBe(80);

    const summary = summarizeBenchmarkSuite([
      badEval,
      { ...badEval, latencyMs: 1200, overallFieldAccuracyPct: 100, quoteVerificationRate: 1 },
      { ...badEval, latencyMs: 2000, overallFieldAccuracyPct: 90, quoteVerificationRate: 1 },
    ]);
    expect(summary.allOnDeviceConfirmed).toBe(true);
    expect(summary.medianLatencyMs).toBe(2000);
    expect(summary.meanLatencyMs).toBe(2000);
  });
});

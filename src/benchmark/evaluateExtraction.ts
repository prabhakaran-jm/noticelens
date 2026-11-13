import type { BenchmarkNoticeFixture } from "../fixtures/benchmarkNotices";
import type {
  RawNoticeExtraction,
  VerifiedNoticeExtraction,
} from "../domain/types";
import { attachQuoteVerification } from "../domain/verifyQuotes";

export interface FixtureBenchmarkEvaluation {
  fixtureId: string;
  fixtureTitle: string;
  latencyMs: number;
  inferenceSource: string | undefined;
  amountExact: boolean;
  deadlineMatch: boolean;
  billingPeriodMatch: boolean;
  obligationActionMatch: boolean;
  verifiedQuotesCount: number;
  totalQuotesCount: number;
  quoteVerificationRate: number;
  allQuotesVerified: boolean;
  overallFieldAccuracyPct: number;
  verifiedExtraction: VerifiedNoticeExtraction;
}

export interface BenchmarkSuiteSummary {
  fixtureCount: number;
  allOnDeviceConfirmed: boolean;
  meanFieldAccuracyPct: number;
  meanQuoteVerificationRatePct: number;
  minLatencyMs: number;
  medianLatencyMs: number;
  meanLatencyMs: number;
  maxLatencyMs: number;
  results: FixtureBenchmarkEvaluation[];
}

function normalizeTokenText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function evaluateExtraction(
  fixture: BenchmarkNoticeFixture,
  rawExtraction: RawNoticeExtraction,
  meta: { latencyMs: number; inferenceSource: string | undefined }
): FixtureBenchmarkEvaluation {
  const verifiedExtraction = attachQuoteVerification(
    fixture.rawText,
    rawExtraction
  );

  const amountExact =
    rawExtraction.amountGBP !== null &&
    Number.isFinite(rawExtraction.amountGBP) &&
    Math.abs(rawExtraction.amountGBP - fixture.expected.amountGBP) < 0.01;

  const normDeadline = normalizeTokenText(rawExtraction.responseDeadline);
  const deadlineMatch = fixture.expected.acceptedDeadlines.some((candidate) =>
    normDeadline.includes(normalizeTokenText(candidate))
  );

  const normPeriod = normalizeTokenText(rawExtraction.billingPeriod);
  const billingPeriodMatch = fixture.expected.billingPeriodOptional
    ? normPeriod.length > 0
    : fixture.expected.requiredBillingPeriodTokens.every((token) =>
        normPeriod.includes(token.toLowerCase())
      );

  const combinedActionsText = normalizeTokenText(
    rawExtraction.obligations.map((o) => o.action).join(" ")
  );
  const obligationActionMatch =
    rawExtraction.obligations.length > 0 &&
    fixture.expected.expectedActionKeywords.some((kw) =>
      combinedActionsText.includes(kw.toLowerCase())
    );

  const totalQuotesCount = verifiedExtraction.obligations.length;
  const verifiedQuotesCount = verifiedExtraction.obligations.filter(
    (o) => o.verification.verified
  ).length;
  const quoteVerificationRate =
    totalQuotesCount > 0 ? verifiedQuotesCount / totalQuotesCount : 0;
  const allQuotesVerified =
    totalQuotesCount > 0 && verifiedQuotesCount === totalQuotesCount;

  const checks = [
    amountExact,
    deadlineMatch,
    billingPeriodMatch,
    obligationActionMatch,
    allQuotesVerified,
  ];
  const passedChecks = checks.filter(Boolean).length;
  const overallFieldAccuracyPct = Math.round(
    (passedChecks / checks.length) * 100
  );

  return {
    fixtureId: fixture.id,
    fixtureTitle: fixture.title,
    latencyMs: Math.round(meta.latencyMs),
    inferenceSource: meta.inferenceSource,
    amountExact,
    deadlineMatch,
    billingPeriodMatch,
    obligationActionMatch,
    verifiedQuotesCount,
    totalQuotesCount,
    quoteVerificationRate,
    allQuotesVerified,
    overallFieldAccuracyPct,
    verifiedExtraction,
  };
}

export function summarizeBenchmarkSuite(
  results: FixtureBenchmarkEvaluation[]
): BenchmarkSuiteSummary {
  if (results.length === 0) {
    return {
      fixtureCount: 0,
      allOnDeviceConfirmed: false,
      meanFieldAccuracyPct: 0,
      meanQuoteVerificationRatePct: 0,
      minLatencyMs: 0,
      medianLatencyMs: 0,
      meanLatencyMs: 0,
      maxLatencyMs: 0,
      results: [],
    };
  }

  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const mid = Math.floor(latencies.length / 2);
  const medianLatencyMs =
    latencies.length % 2 === 0
      ? Math.round(((latencies[mid - 1] ?? 0) + (latencies[mid] ?? 0)) / 2)
      : (latencies[mid] ?? 0);

  const sumLatency = latencies.reduce((acc, n) => acc + n, 0);
  const meanFieldAccuracyPct = Math.round(
    results.reduce((acc, r) => acc + r.overallFieldAccuracyPct, 0) /
      results.length
  );
  const meanQuoteVerificationRatePct = Math.round(
    (results.reduce((acc, r) => acc + r.quoteVerificationRate, 0) /
      results.length) *
      100
  );

  return {
    fixtureCount: results.length,
    allOnDeviceConfirmed: results.every(
      (r) => r.inferenceSource === "on_device"
    ),
    meanFieldAccuracyPct,
    meanQuoteVerificationRatePct,
    minLatencyMs: latencies[0] ?? 0,
    medianLatencyMs,
    meanLatencyMs: Math.round(sumLatency / latencies.length),
    maxLatencyMs: latencies[latencies.length - 1] ?? 0,
    results,
  };
}

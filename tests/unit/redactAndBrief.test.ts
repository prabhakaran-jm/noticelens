import { describe, expect, it } from "vitest";
import { redactAndBuildBrief } from "../../src/domain/redactAndBrief";
import type { GuidanceId, NoticeCategory, ResponseGoal } from "../../src/domain/types";
import { BENCHMARK_NOTICE_FIXTURES } from "../../src/fixtures/benchmarkNotices";

function guidanceFor(category: NoticeCategory): GuidanceId {
  if (category === "council_tax") {
    return "citizens-advice-council-tax-reminder-v1";
  }
  if (category === "housing_service_charge") {
    return "housing-service-charge-summary-v1";
  }
  return "ofgem-backbilling-12m-v1";
}

function goalFor(category: NoticeCategory): ResponseGoal {
  if (category === "utility_electricity" || category === "utility_gas") {
    return "request_billing_review";
  }
  return "request_breakdown_and_hold";
}

describe("redactAndBuildBrief — local identifiers stay out of the structural brief", () => {
  const original = BENCHMARK_NOTICE_FIXTURES[0]!;

  it("maps the energy fixture locally and excludes those raw values from the brief", () => {
    const result = redactAndBuildBrief({
      rawNoticeText: original.rawText,
      responseGoal: "request_billing_review",
      guidanceIds: ["ofgem-backbilling-12m-v1"],
      circumstanceFlags: ["previously_provided_meter_readings"],
      extraction: {
        noticeCategory: "utility_electricity",
        issueDate: "18 November 2026",
        billingPeriod: "January and June 2025",
        amountGBP: 1280,
        responseDeadline: "25 November 2026",
        obligations: [
          {
            action: "Contact Sarah Example about the balance",
            dueDate: "25 November 2026",
            sourceQuote: original.expected.canonicalQuotes[1]!,
          },
          {
            action: "Keep the supply address on this device",
            dueDate: null,
            sourceQuote: "14 Example Road, Reading, RG0 0AA",
          },
        ],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.declaredComplete).toBe(false);
    expect(result.limitations[0]).toMatch(/does not guarantee/i);
    expect(result.localIdentifierMap.locality).toBe("browser-only");
    expect(result.localIdentifierMap.entries.map((entry) => entry.placeholder)).toEqual(
      expect.arrayContaining(["[RECIPIENT_NAME]", "[ACCOUNT_REF]", "[SUPPLY_ADDRESS]"])
    );
    expect(result.localIdentifierMap.entries.map((entry) => entry.rawValue)).toEqual(
      expect.arrayContaining(["Sarah Example", "EXAMPLE-8472", "14 Example Road, Reading, RG0 0AA"])
    );

    const serialized = JSON.stringify(result.structuralBrief);
    for (const token of original.forbiddenPiiTokens) {
      expect(serialized).not.toContain(token);
      expect(result.redactedNoticePreview).not.toContain(token);
    }
    expect(serialized).not.toContain("localIdentifierMap");
    expect(serialized).not.toContain("Sarah Example");
    expect(result.redactedNoticePreview).toContain("[RECIPIENT_NAME]");
    expect(serialized).toContain("[SUPPLY_ADDRESS]");
    expect(result.structuralBrief.amountsGBP).toEqual([1280]);
    expect(result.structuralBrief.redactedObligations[0]?.actionSummary).toBe("pay_or_contact");
    expect(result.structuralBrief.issueDate).toBe("2026-11-18");
    expect(result.structuralBrief.circumstanceFlags).toEqual([
      "previously_provided_meter_readings",
    ]);
  });

  it("redacts known identifiers in every synthetic benchmark fixture", () => {
    for (const fixture of BENCHMARK_NOTICE_FIXTURES) {
      const result = redactAndBuildBrief({
        rawNoticeText: fixture.rawText,
        responseGoal: goalFor(fixture.expected.noticeCategory),
        guidanceIds: [guidanceFor(fixture.expected.noticeCategory)],
        extraction: {
          noticeCategory: fixture.expected.noticeCategory,
          issueDate: "18 November 2026",
          billingPeriod: fixture.expected.billingPeriodOptional
            ? "not stated"
            : "stated in the notice",
          amountGBP: fixture.expected.amountGBP,
          responseDeadline: fixture.expected.acceptedDeadlines[0] ?? "not stated",
          obligations: fixture.expected.canonicalQuotes.map((quote) => ({
            action: "Review the stated obligation",
            dueDate: fixture.expected.acceptedDeadlines[0] ?? null,
            sourceQuote: quote,
          })),
        },
      });
      expect(result.ok, fixture.id).toBe(true);
      if (!result.ok) {
        continue;
      }
      const serialized = JSON.stringify(result.structuralBrief);
      for (const token of fixture.forbiddenPiiTokens) {
        expect(serialized, `${fixture.id} leaked ${token}`).not.toContain(token);
      }
    }
  });

  it("does not copy a free-text action, so an identifier in that action is not sent", () => {
    const result = redactAndBuildBrief({
      rawNoticeText: original.rawText,
      responseGoal: "request_billing_review",
      guidanceIds: ["ofgem-backbilling-12m-v1"],
      extraction: {
        noticeCategory: "utility_electricity",
        issueDate: "18 November 2026",
        billingPeriod: "January and June 2025",
        amountGBP: 1280,
        responseDeadline: "25 November 2026",
        obligations: [
          {
            action: "The compact postcode rg00aa must not be sent",
            dueDate: null,
            sourceQuote: original.expected.canonicalQuotes[0]!,
          },
        ],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const serialized = JSON.stringify(result.structuralBrief);
    expect(serialized).not.toContain("rg00aa");
    expect(serialized).not.toContain("must not be sent");
    expect(result.structuralBrief.redactedObligations[0]?.actionSummary).toBe(
      "review_stated_obligation"
    );
  });

  it("excludes fabricated quotes and refuses to send a brief that has none left", () => {
    const mixed = redactAndBuildBrief({
      rawNoticeText: original.rawText,
      responseGoal: "request_billing_review",
      guidanceIds: ["ofgem-backbilling-12m-v1"],
      extraction: {
        noticeCategory: "utility_electricity",
        issueDate: "18 November 2026",
        billingPeriod: "January and June 2025",
        amountGBP: 1280,
        responseDeadline: "25 November 2026",
        obligations: [
          {
            action: "Invented waiver",
            dueDate: null,
            sourceQuote: "This notice is hereby cancelled and the balance is £0.",
          },
          {
            action: "Contact the billing team",
            dueDate: "25 November 2026",
            sourceQuote: original.expected.canonicalQuotes[1]!,
          },
        ],
      },
    });
    expect(mixed.ok).toBe(true);
    if (mixed.ok) {
      expect(mixed.excludedUnverifiedQuotes).toEqual([
        "This notice is hereby cancelled and the balance is £0.",
      ]);
      expect(mixed.structuralBrief.redactedObligations).toHaveLength(1);
    }

    const onlyFake = redactAndBuildBrief({
      rawNoticeText: original.rawText,
      responseGoal: "request_billing_review",
      guidanceIds: ["ofgem-backbilling-12m-v1"],
      extraction: {
        noticeCategory: "utility_electricity",
        issueDate: "18 November 2026",
        billingPeriod: "January and June 2025",
        amountGBP: 1280,
        responseDeadline: "25 November 2026",
        obligations: [
          {
            action: "Invented waiver",
            dueDate: null,
            sourceQuote: "This notice is hereby cancelled.",
          },
        ],
      },
    });
    expect(onlyFake.ok).toBe(false);
    if (!onlyFake.ok) {
      expect(onlyFake.reasons.join(" ")).toMatch(/not stated|unverified/i);
      expect("structuralBrief" in onlyFake).toBe(false);
    }
  });

  it("does not invent £0 when the amount is missing", () => {
    const result = redactAndBuildBrief({
      rawNoticeText: original.rawText,
      responseGoal: "request_breakdown_and_hold",
      guidanceIds: ["ofgem-backbilling-12m-v1"],
      extraction: {
        noticeCategory: "utility_electricity",
        issueDate: "18 November 2026",
        billingPeriod: "January and June 2025",
        amountGBP: null,
        responseDeadline: "25 November 2026",
        obligations: [
          {
            action: "Ask what amount is being requested",
            dueDate: "25 November 2026",
            sourceQuote: original.expected.canonicalQuotes[1]!,
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.structuralBrief.amountsGBP).toEqual([]);
    expect(JSON.stringify(result.structuralBrief)).not.toMatch(/"amountsGBP":\[0\]/);
  });
});

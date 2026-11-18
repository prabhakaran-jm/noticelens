import { describe, expect, it } from "vitest";
import {
  compareNoticeTexts,
  compareNotices,
  extractComparableFacts,
} from "../../src/domain/compareNotices";
import { BENCHMARK_NOTICE_FIXTURES } from "../../src/fixtures/benchmarkNotices";

describe("compareNotices — £1,280 original against £520 revised", () => {
  const original = BENCHMARK_NOTICE_FIXTURES[0]!;
  const revised = BENCHMARK_NOTICE_FIXTURES[1]!;

  it("links the amount and deadline changes and flags the omitted billing period", () => {
    const comparison = compareNoticeTexts(original.rawText, revised.rawText, {
      today: "2026-11-13",
    });

    expect(comparison.amount.value).toBe(1280);
    expect(comparison.amount.revised).toBe(520);
    expect(comparison.amount.differenceGBP).toBe(-760);
    expect(comparison.amount.status).toBe("changed");
    expect(comparison.amount.verification?.verified).toBe(true);
    expect(comparison.amount.revisedVerification?.verified).toBe(true);
    expect(original.rawText.slice(
      comparison.amount.verification!.startOffset!,
      comparison.amount.verification!.endOffset!
    )).toContain("£1,280");
    expect(revised.rawText.slice(
      comparison.amount.revisedVerification!.startOffset!,
      comparison.amount.revisedVerification!.endOffset!
    )).toContain("£520");

    expect(comparison.responseDeadline.value).toBe("25 November 2026");
    expect(comparison.responseDeadline.revised).toBe("16 December 2026");
    expect(comparison.responseDeadline.laterByCalendarDays).toBe(21);
    expect(comparison.responseDeadline.verification?.verified).toBe(true);
    expect(comparison.responseDeadline.revisedVerification?.verified).toBe(true);
    expect(comparison.responseDeadline.originalClassification?.urgency).toBe("upcoming");

    expect(comparison.billingPeriod.value).toBe("January and June 2025");
    expect(comparison.billingPeriod.revised).toBeNull();
    expect(comparison.billingPeriod.omittedInRevised).toBe(true);
    expect(comparison.billingPeriod.status).toBe("omitted_in_revised");
    expect(comparison.billingPeriod.omissionNote).toBe("Not stated in revised notice");
    expect(comparison.billingPeriod.omissionPrompt).toContain("£520");
    expect(comparison.billingPeriod.verification?.verified).toBe(true);
    expect(comparison.billingPeriod.revisedVerification).toBeNull();

    expect(comparison.statedAction.value).toBe("Pay balance or contact billing team");
    expect(comparison.statedAction.revised).toBe("Contact billing team if you have questions");
    expect(comparison.statedAction.status).toBe("changed");

    expect(comparison.issueDate.original).toBe("18 November 2026");
    expect(comparison.issueDate.revised).toBe("2 December 2026");
    expect(comparison.issueDate.revisedAssessment?.futureDatedFixture).toBe(true);
    expect(comparison.issueDate.revisedAssessment?.label).toContain("2 Dec 2026");
  });

  it("marks the original deadline as past or due today from the injected date", () => {
    const past = compareNoticeTexts(original.rawText, revised.rawText, {
      today: "2026-11-26",
    });
    expect(past.responseDeadline.originalClassification?.urgency).toBe("past");
    expect(past.responseDeadline.originalClassification?.daysFromToday).toBe(-1);

    const due = compareNoticeTexts(original.rawText, revised.rawText, {
      today: "2026-11-25",
    });
    expect(due.responseDeadline.originalClassification?.urgency).toBe("due_today");
  });

  it("does not turn a missing amount into zero or a missing period into an omission", () => {
    const comparison = compareNoticeTexts("No figures are stated.", "Still no figures.", {
      today: "2026-11-13",
    });
    expect(comparison.amount.value).toBeNull();
    expect(comparison.amount.revised).toBeNull();
    expect(comparison.amount.differenceGBP).toBeNull();
    expect(comparison.amount.status).toBe("not_stated");
    expect(comparison.billingPeriod.omittedInRevised).toBe(false);
    expect(comparison.billingPeriod.status).toBe("not_stated");
  });

  it("does not treat a stated zero as a verified current balance", () => {
    const stated = extractComparableFacts("The outstanding balance of £0 is shown here.");
    const missing = extractComparableFacts("No figures are stated.");
    expect(stated.amountGBP).toBeNull();
    expect(stated.amountAuthority).not.toBe("verified");
    expect(stated.amountConflict).toBe(false);
    expect(missing.amountGBP).toBeNull();
    expect(missing.amountAuthority).toBe("not_stated");
  });

  it("does not pick one date when the revised notice states two deadlines", () => {
    const comparison = compareNotices(
      extractComparableFacts(original.rawText),
      extractComparableFacts(
        "Please pay by 16 December 2026.\nPlease also write by 20 December 2026.\n"
      ),
      { today: "2026-11-13" }
    );
    expect(comparison.responseDeadline.status).toBe("conflicting");
    expect(comparison.responseDeadline.revised).toBeNull();
    expect(comparison.responseDeadline.revisedDates).toEqual([
      "16 December 2026",
      "20 December 2026",
    ]);
    expect(comparison.responseDeadline.laterByCalendarDays).toBeNull();
    expect("authoritativeDeadline" in comparison.responseDeadline).toBe(false);
  });

  it("flags an unverified amount quote instead of treating it as source text", () => {
    const extracted = extractComparableFacts(original.rawText);
    const comparison = compareNotices(extracted, {
      ...extractComparableFacts(revised.rawText),
      amountQuote: "The balance now requested is £999.",
    });
    expect(comparison.amount.revisedVerification?.verified).toBe(false);
    expect(comparison.amount.revisedVerification?.unverifiedReason).toBe("not_in_source");
    expect(comparison.amount.revised).toBe(520);
  });
});

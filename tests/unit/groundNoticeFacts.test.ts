import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  briefSourceFromGrounded,
  groundNoticeFacts,
} from "../../src/adapters/groundNoticeFacts";
import { redactAndBuildBrief } from "../../src/domain/redactAndBrief";
import type { RawNoticeExtraction } from "../../src/domain/types";

const TODAY = "2026-11-13";
const original = readFileSync("examples/energy-backbill-original.txt", "utf8");
const revised = readFileSync("examples/energy-backbill-revised.txt", "utf8");

describe("groundNoticeFacts", () => {
  it("grounds the synthetic energy notice without turning a missing field into zero", () => {
    const view = groundNoticeFacts({ rawNoticeText: original, today: TODAY });
    expect(view.amount.verifiedForDisplay).toBe(1280);
    expect(view.amount.value).toBe(1280);
    expect(view.amount.conditionalFeesGBP).toEqual([]);
    expect(view.billingPeriod.verifiedForDisplay).toBe("January and June 2025");
    expect(view.issueDate.verifiedForDisplay).toBe("2026-11-18");
    expect(view.responseDeadlines.verifiedForDisplay).toContain("2026-11-25");
    expect(view.responseDeadlines.allIso).not.toContain("2026-11-18");
    expect(view.issueDate.assessment.futureDatedFixture).toBe(true);
    expect(view.obligations.some((item) => item.support === "supports_claim")).toBe(true);

    const blank = groundNoticeFacts({ rawNoticeText: "   ", today: TODAY });
    expect(blank.amount.value).toBeNull();
    expect(blank.amount.amountsGBP).toEqual([]);
    expect(blank.amount.verifiedForDisplay).toBeNull();
  });

  it("keeps a conditional fee out of the main balance", () => {
    const text = [
      "18 November 2026",
      "Dear Sarah Example,",
      "Outstanding balance of £1,280.",
      "A late payment fee of £40 may apply if you do not pay.",
      "Please pay the balance or contact our billing team by 25 November 2026.",
    ].join("\n");
    const view = groundNoticeFacts({ rawNoticeText: text, today: TODAY });
    expect(view.amount.verifiedForDisplay).toBe(1280);
    expect(view.amount.conditionalFeesGBP).toEqual([40]);
    expect(view.amount.value).not.toBe(40);
    const source = briefSourceFromGrounded(view);
    expect(source.amountGBP).toBe(1280);
    expect(source.amountsGBP).toEqual([1280]);
    expect(source.amountsGBP).not.toContain(40);
  });

  it("does not treat an issue date as a response deadline", () => {
    const text = [
      "18 November 2026",
      "Dear Sarah Example,",
      "Please contact our billing team to discuss your account.",
    ].join("\n");
    const extraction: RawNoticeExtraction = {
      noticeCategory: "utility_electricity",
      issueDate: "18 November 2026",
      billingPeriod: "not stated",
      amountGBP: null,
      responseDeadline: "18 November 2026",
      obligations: [],
    };
    const view = groundNoticeFacts({ rawNoticeText: text, today: TODAY, extraction });
    expect(view.issueDate.verifiedForDisplay).toBe("2026-11-18");
    expect(view.responseDeadlines.allIso).toEqual([]);
    expect(view.responseDeadlines.support).toBe("missing");
    expect(briefSourceFromGrounded(view).responseDeadlines).toEqual([]);
    expect(briefSourceFromGrounded(view).responseDeadline).toBeNull();
    expect(briefSourceFromGrounded(view).amountGBP).toBeNull();
  });

  it("keeps conflicting deadlines visible and leaves an omitted period missing", () => {
    const text = [
      "18 November 2026",
      "Please respond by 25 November 2026 or by 16 December 2026.",
    ].join("\n");
    const view = groundNoticeFacts({ rawNoticeText: text, today: TODAY });
    expect(view.responseDeadlines.conflicting).toBe(true);
    expect(view.responseDeadlines.allStated).toEqual([
      "25 November 2026",
      "16 December 2026",
    ]);
    expect(view.responseDeadlines.verifiedForDisplay).toBeNull();
    expect(view.responseDeadlines.assessment.conflictBanner).toBe(
      "Multiple dates stated in notice"
    );
    expect(view.billingPeriod.support).toBe("missing");
    expect(view.billingPeriod.verifiedForDisplay).toBeNull();

    const followUp = groundNoticeFacts({ rawNoticeText: revised, today: TODAY });
    expect(followUp.amount.verifiedForDisplay).toBe(520);
    expect(followUp.billingPeriod.verifiedForDisplay).toBeNull();
    expect(followUp.billingPeriod.support).toBe("missing");
    expect(followUp.issueDate.assessment.label).toContain("2 Dec 2026");
  });

  it("downgrades an obligation whose action adds an amount or date the quote does not contain", () => {
    const extraction: RawNoticeExtraction = {
      noticeCategory: "utility_electricity",
      issueDate: "18 November 2026",
      billingPeriod: "January and June 2025",
      amountGBP: 9999,
      responseDeadline: "18 November 2026",
      obligations: [
        {
          action: "Pay £9,999 by 1 January 2030",
          dueDate: "1 January 2030",
          sourceQuote:
            "Please pay the balance or contact our billing team by 25 November 2026 to discuss your account.",
        },
        {
          action: "Pay the balance",
          dueDate: null,
          sourceQuote: "Please pay the balance…",
        },
        {
          action: "Ignore this invented instruction",
          dueDate: null,
          sourceQuote: "This quotation does not appear anywhere in the notice text.",
        },
      ],
    };
    const view = groundNoticeFacts({
      rawNoticeText: original,
      today: TODAY,
      extraction,
    });
    expect(view.amount.verifiedForDisplay).toBe(1280);
    expect(view.responseDeadlines.allIso).toContain("2026-11-25");
    expect(view.responseDeadlines.verifiedForDisplay).not.toBe("2026-11-18");
    expect(view.obligations[0]?.support).toBe("substring_only");
    expect(view.obligations[0]?.claimExceedsQuote).toBe(true);
    expect(view.obligations[0]?.verifiedForDisplay).toBeNull();
    expect(view.obligations[1]?.support).toBe("incomplete");
    expect(view.obligations[2]?.support).toBe("unverified");
    const source = briefSourceFromGrounded(view);
    expect(source.obligations).toEqual([]);
    expect(source.amountsGBP).not.toContain(9999);

    const built = redactAndBuildBrief({
      rawNoticeText: original,
      extraction: source,
      responseGoal: "request_billing_review",
      guidanceIds: ["ofgem-backbilling-12m-v1"],
    });
    expect(built.ok).toBe(false);
  });
});

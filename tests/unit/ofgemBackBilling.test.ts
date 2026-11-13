import { describe, expect, it } from "vitest";
import { assessBillingPeriodGap } from "../../src/domain/dates";
import {
  OFGEM_BACK_BILLING_SOURCE,
  OFGEM_BACK_BILLING_VERBATIM,
  buildOfgemCloudPromptExcerpt,
  selectNoticeGuidance,
} from "../../src/guidance/ofgemBackBilling";

describe("Ofgem back-billing guidance — attributed and conditional", () => {
  it("quotes the official conditions, exceptions, and source page", () => {
    expect(OFGEM_BACK_BILLING_SOURCE.publisher).toBe("Ofgem");
    expect(OFGEM_BACK_BILLING_SOURCE.title).toBe("What to do if you get a back bill");
    expect(OFGEM_BACK_BILLING_SOURCE.url).toBe(
      "https://www.ofgem.gov.uk/your-energy-supply/your-energy-bill/what-do-if-you-get-back-bill"
    );
    expect(OFGEM_BACK_BILLING_VERBATIM.conditionsIntro).toBe(
      "Our back billing rules mean you do not have to pay for energy you used more than 12 months ago if:"
    );
    expect(OFGEM_BACK_BILLING_VERBATIM.conditions).toEqual([
      "you\u2019ve not had an accurate bill for it before",
      "you\u2019ve not been told about what you needed to pay through a statement of account before",
      "your Direct Debit amount was previously set too low to cover what you needed to pay",
    ]);
    expect(OFGEM_BACK_BILLING_VERBATIM.exceptions).toEqual([
      "stopping your supplier from billing you accurately, including by blocking access to your meter",
      "ignoring requests for payment from your supplier",
      "stealing electricity or gas",
    ]);
    expect(OFGEM_BACK_BILLING_VERBATIM.payAccurateBills).toMatch(/accurate bill/i);
  });

  it("may describe the 12-month condition for an energy notice without declaring the bill invalid", () => {
    const gap = assessBillingPeriodGap("January and June 2025", "18 November 2026");
    const card = selectNoticeGuidance("utility_electricity", gap.status);
    expect(card.mode).toBe("ofgem_back_billing");
    expect(card.declaresBillInvalid).toBe(false);
    expect(card.legalDetermination).toBeNull();
    if (card.mode !== "ofgem_back_billing") {
      return;
    }
    expect(card.attribution).toMatch(/Ofgem states/);
    expect(card.conditionalSummary).toMatch(/may/i);
    expect(card.conditionalSummary).toMatch(/does not decide/i);
    expect(card.conditionalSummary).not.toMatch(/this bill is invalid/i);
    expect(card.conditionalSummary).not.toMatch(/unenforceable/i);
    expect(card.relevance).toMatch(/may be relevant/i);
    expect(card.source.url).toBe(OFGEM_BACK_BILLING_SOURCE.url);
  });

  it("does not load the energy card for a non-energy notice", () => {
    const card = selectNoticeGuidance("council_tax", "missing");
    expect(card.mode).toBe("general_correspondence");
    expect(card.declaresBillInvalid).toBe(false);
    expect(JSON.stringify(card)).not.toContain("ofgem.gov.uk");
    if (card.mode !== "general_correspondence") {
      return;
    }
    expect(card.disclaimer).toMatch(/no curated statutory guidance/i);
  });

  it("keeps the cloud excerpt conditional and sourced", () => {
    const excerpt = buildOfgemCloudPromptExcerpt();
    expect(excerpt).toContain(OFGEM_BACK_BILLING_SOURCE.url);
    expect(excerpt).toContain("accurate bill for it before");
    expect(excerpt).toContain("statement of account");
    expect(excerpt).toContain("Direct Debit");
    expect(excerpt).toContain("blocking access to your meter");
    expect(excerpt).toContain("ignoring requests for payment");
    expect(excerpt).toContain("stealing electricity or gas");
    expect(excerpt).toMatch(/legally invalid/i);
    expect(excerpt).toContain("[RECIPIENT_NAME]");
    expect(excerpt).toContain("[ACCOUNT_REF]");
    expect(excerpt).toContain("[SUPPLY_ADDRESS]");
  });
});

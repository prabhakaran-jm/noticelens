import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildClosedCloudBrief } from "../../src/adapters/buildClosedCloudBrief";
import { buildClosedCloudInspection } from "../../src/adapters/closedCloudInspection";
import { groundNoticeFacts } from "../../src/adapters/groundNoticeFacts";
import { ActionPlanScreen } from "../../src/ui/screens/ActionPlanScreen";
import type { RawNoticeExtraction } from "../../src/domain/types";

const TODAY = "2026-11-13";
const BAL = "Your outstanding balance is £520. ";
const PAY9 = "Please pay the outstanding balance by 9 December 2026.";
const PAY25 = "Please pay the outstanding balance by 25 November 2026.";

function extraction(obligations: RawNoticeExtraction["obligations"]): RawNoticeExtraction {
  return {
    noticeCategory: "utility_electricity",
    issueDate: "",
    billingPeriod: "",
    amountGBP: null,
    responseDeadline: "",
    obligations,
  };
}

function read(text: string, obligations?: RawNoticeExtraction["obligations"]) {
  const view = groundNoticeFacts({
    rawNoticeText: text,
    today: TODAY,
    extraction: obligations ? extraction(obligations) : undefined,
  });
  const built = buildClosedCloudBrief({ view, responseGoal: "request_billing_review" });
  const inspection = buildClosedCloudInspection({
    rawNoticeText: text,
    view,
    responseGoal: "request_billing_review",
  });
  return { view, built, inspection };
}

describe("Phase 3F claim binding and deadline integrity", () => {
  it("K9 / xH2 keeps contradictory claim deadlines unsettled after A/B/A", () => {
    const text = BAL + PAY9 + "\nPlease pay the outstanding balance by 16 December 2026.\n" + PAY9;
    const { view, built } = read(text);
    const claim = view.eligibility.decisions.find((item) => item.amount === 520 && item.status === "ELIGIBLE");
    expect(claim?.deadlineSupported).toBe(false);
    expect(claim?.deadlineIso).toBeNull();
    expect(view.responseDeadlines.conflicting).toBe(true);
    expect(built.payload.responseDeadlines).toEqual([]);
  });

  it("K9 / xH3 keeps B/A/B deadline conflicts sticky with extraction", () => {
    const text = BAL + PAY25 + "\n" + PAY9 + "\nReminder: " + PAY25;
    const { view, built } = read(text, [
      { action: "Pay", dueDate: "25 November 2026", sourceQuote: PAY25 },
    ]);
    const claim = view.eligibility.decisions.find((item) => item.amount === 520 && item.status === "ELIGIBLE");
    expect(claim?.deadlineSupported).toBe(false);
    expect(built.payload.responseDeadlines).toEqual([]);
    expect(view.responseDeadlines.conflicting).toBe(true);
  });

  it("K9 / xH withholds two different pay-by dates for one balance from v2", () => {
    const text = BAL + PAY9 + "\nPlease pay the outstanding balance by 16 December 2026.";
    const { view, built } = read(text);
    expect(view.responseDeadlines.conflicting).toBe(true);
    expect(built.payload.responseDeadlines).toEqual([]);
  });

  it("K10 / xD does not verify stale pay instruction after the claim", () => {
    const text =
      BAL + "\nOur previous letter, since withdrawn, said: please pay the outstanding balance by 25 November 2026.";
    const { view, built } = read(text);
    const claim = view.eligibility.decisions.find((item) => item.amount === 520 && item.status === "ELIGIBLE");
    expect(claim?.paymentActionSupported).toBe(false);
    expect(claim?.deadlineSupported).toBe(false);
    expect(built.payload.obligations).toEqual([]);
    expect(built.payload.responseDeadlines).toEqual([]);
  });

  it("K10 / xD2 withholds extracted stale action from v2", () => {
    const text =
      BAL + "\nOur previous letter, since withdrawn, said: please pay the outstanding balance by 25 November 2026.";
    const { view, built } = read(text, [
      {
        action: "Pay",
        dueDate: "25 November 2026",
        sourceQuote: "please pay the outstanding balance by 25 November 2026",
      },
    ]);
    expect(view.obligations[0]?.headingSupport).not.toBe("supports_claim");
    expect(built.payload.obligations).toEqual([]);
    expect(built.serialized).not.toContain("2026-11-25");
  });

  it("K10 / xD3 ignores cancelled pay-before-claim instruction", () => {
    const text =
      "Last month we wrote: Please pay by 25 November 2026.\nThat letter has been cancelled.\nYour outstanding balance is now £520.";
    const { view, built } = read(text);
    const claim = view.eligibility.decisions.find((item) => item.amount === 520 && item.status === "ELIGIBLE");
    expect(claim?.deadlineSupported).toBe(false);
    expect(claim?.paymentActionSupported).toBe(false);
    expect(built.payload.responseDeadlines).toEqual([]);
  });

  it("K11 / xD4 verifies genuine action and withholds stale duplicate quote", () => {
    const text =
      BAL +
      PAY9 +
      "\nThe £1,280 demand has been cancelled. It said: please pay the outstanding balance by 25 November 2026.";
    const { view, built } = read(text, [
      { action: "Pay", dueDate: "9 December 2026", sourceQuote: PAY9 },
      {
        action: "Pay",
        dueDate: "25 November 2026",
        sourceQuote: "please pay the outstanding balance by 25 November 2026",
      },
    ]);
    expect(view.obligations[0]?.headingSupport).toBe("supports_claim");
    expect(view.obligations[1]?.headingSupport).not.toBe("supports_claim");
    expect(built.payload.responseDeadlines).toEqual(["2026-12-09"]);
    expect(built.payload.obligations).toEqual([{ actionSummary: "pay_stated_balance", dueDate: "2026-12-09" }]);

    render(
      createElement(ActionPlanScreen, {
        view,
        identifiers: [],
        responseGoal: "request_billing_review",
        onResponseGoal: () => undefined,
        flags: [],
        onFlags: () => undefined,
      })
    );
    const verified = screen.getAllByText("Verified in notice");
    expect(verified.length).toBe(1);
  });

  it("K12 keeps inspection and v2 deadlines aligned without legacy override", () => {
    const text = BAL + PAY9 + "\nPlease pay the outstanding balance by 16 December 2026.\n" + PAY9;
    const { view, built, inspection } = read(text);
    expect(built.payload.responseDeadlines).toEqual([]);
    expect(inspection.violations).toEqual([]);
    expect(view.responseDeadlines.verifiedForDisplay).toBeNull();
  });

  it("preserves q34 cancelled £1,280 versus current £520", () => {
    const text =
      "The £1,280 demand dated 2 October 2026 asked you to pay by 25 November 2026. That demand has been cancelled.\nYour outstanding balance is £520. Please pay the outstanding balance by 9 December 2026.";
    const { view, built } = read(text, [
      { action: "Pay the balance", dueDate: "25 November 2026", sourceQuote: "asked you to pay by 25 November 2026" },
      {
        action: "Pay the balance",
        dueDate: "9 December 2026",
        sourceQuote: "Please pay the outstanding balance by 9 December 2026.",
      },
    ]);
    expect(built.payload.amountsGBP).toEqual([520]);
    expect(built.payload.responseDeadlines).toEqual(["2026-12-09"]);
    expect(view.obligations[0]?.headingSupport).not.toBe("supports_claim");
    expect(view.obligations[1]?.headingSupport).toBe("supports_claim");
  });

  it("preserves q35 duplicate quote ids with one supported v2 action", () => {
    const quote = PAY9;
    const text = `Your outstanding balance is £520. ${quote}\nReminder: ${quote}`;
    const { view, built } = read(text, [
      { action: "Pay the balance", dueDate: "9 December 2026", sourceQuote: quote },
      { action: "Pay the balance", dueDate: "9 December 2026", sourceQuote: quote },
    ]);
    expect(new Set(view.obligations.map((item) => item.id)).size).toBe(2);
    expect(built.payload.amountsGBP).toEqual([520]);
    expect(built.payload.obligations).toEqual([
      { actionSummary: "pay_stated_balance", dueDate: "2026-12-09" },
    ]);
  });
});
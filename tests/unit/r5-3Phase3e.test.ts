import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildClosedCloudBrief } from "../../src/adapters/buildClosedCloudBrief";
import { buildClosedCloudInspection } from "../../src/adapters/closedCloudInspection";
import { CLOUD_SUBMISSION_ENABLED } from "../../src/adapters/cloudApprovalSession";
import { groundNoticeFacts } from "../../src/adapters/groundNoticeFacts";
import { ActionPlanScreen } from "../../src/ui/screens/ActionPlanScreen";
import { ReadNoticeScreen } from "../../src/ui/screens/ReadNoticeScreen";
import type { RawNoticeExtraction } from "../../src/domain/types";

const TODAY = "2026-11-13";
const PAY = "Please pay the outstanding balance by 25 November 2026.";

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
  return { view, built };
}

describe("Phase 3E per-claim authority", () => {
  it("keeps cloud submission disabled", () => {
    expect(CLOUD_SUBMISSION_ENABLED).toBe(false);
  });

  it("K1 withholds a rescinded demand, a soft hyphen, and a denied new charge", () => {
    const notices = [
      "The £1,280 demand has been rescinded.\nPlease pay £1,280 by 25 November 2026.",
      "The £1,280 demand has been can\u00ADcelled.\nPlease pay £1,280 by 25 November 2026.",
      "The £1,280 demand has been cancelled.\nNo new charge has been raised, so please pay £1,280 by 25 November 2026.",
    ];
    for (const text of notices) {
      const { view, built } = read(text);
      expect(built.payload.amountsGBP).toEqual([]);
      expect(built.payload.obligations).toEqual([]);
      expect(built.payload.responseDeadlines).toEqual([]);
      expect(view.eligibility.decisions.some((item) => item.amount === 1280 && item.status === "ELIGIBLE")).toBe(
        false
      );
    }
  });

  it("K2 withholds a later slip after the account was settled or is clear", () => {
    const settled = read(
      "Your account was settled on 1 November 2026.\n---\nPayment slip\nBalance due: £1,280\nPlease pay by 25 November 2026."
    );
    const clear = read("Your account is now clear.\nTotal to pay: £1,280");
    expect(settled.built.payload.amountsGBP).toEqual([]);
    expect(settled.built.payload.obligations).toEqual([]);
    expect(clear.built.payload.amountsGBP).toEqual([]);
    expect(clear.view.eligibility.decisions.some((item) => item.amount === 1280 && item.status === "ELIGIBLE")).toBe(
      false
    );
  });

  it("q26 keeps a historical £520 ineligible and the current £520 eligible", () => {
    const text =
      "Thank you for your payment of £520 on 2 October 2026.\nYour outstanding balance is £520. Please pay the outstanding balance by 9 December 2026.";
    const { view, built } = read(text);
    const historical = view.eligibility.decisions.find((item) => item.amount === 520 && item.role === "historical_payment");
    const current = view.eligibility.decisions.find((item) => item.amount === 520 && item.role === "current_balance");
    expect(historical?.status).toBe("INELIGIBLE");
    expect(current?.status).toBe("ELIGIBLE");
    expect(historical?.id).not.toBe(current?.id);
    expect(built.payload.amountsGBP).toEqual([520]);
    expect(built.payload.responseDeadlines).toEqual(["2026-12-09"]);
  });

  it("q34 keeps the cancelled demand's action and deadline out of v2", () => {
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
    expect(view.amount.verifiedForDisplay).toBe(520);
    expect(view.eligibility.decisions.some((item) => item.amount === 1280 && item.status === "ELIGIBLE")).toBe(false);
    expect(view.eligibility.decisions.some((item) => item.amount === 520 && item.status === "ELIGIBLE")).toBe(true);
    const stale = view.obligations[0];
    const current = view.obligations[1];
    expect(stale?.actionSummary).toBe("pay_stated_balance");
    expect(current?.actionSummary).toBe("pay_stated_balance");
    expect(stale?.id).not.toBe(current?.id);
    expect(stale?.headingSupport).not.toBe("supports_claim");
    expect(current?.headingSupport).toBe("supports_claim");
    expect(built.payload.amountsGBP).toEqual([520]);
    expect(built.payload.responseDeadlines).toEqual(["2026-12-09"]);
    expect(built.payload.obligations).toEqual([
      { actionSummary: "pay_stated_balance", dueDate: "2026-12-09" },
    ]);
    expect(built.serialized).not.toContain("2026-11-25");
    expect(built.serialized).not.toContain("sourceQuote");
    expect(built.serialized).not.toContain("sentenceIndex");
    expect(built.serialized).not.toContain("claim-");

    render(
      createElement(ReadNoticeScreen, {
        text,
        onText: () => undefined,
        onLoadSample: () => undefined,
        grounded: view,
        capability: null,
        onReadOnDevice: () => undefined,
        deviceMessage: null,
        reading: false,
      })
    );
    expect(screen.getByTestId("read-amount")).toHaveTextContent("£520");
    expect(screen.getByTestId("read-amount-support")).toHaveTextContent("Verified in notice");
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
    const chips = screen.getAllByTestId("plan-action-support").map((item) => item.textContent);
    expect(chips.filter((item) => item === "Verified in notice")).toHaveLength(1);
    expect(chips.some((item) => item === "Needs review")).toBe(true);
  });

  it("q35 gives duplicate quotes distinct ids and one v2 action", () => {
    const quote = "Please pay the outstanding balance by 9 December 2026.";
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
    const inspection = buildClosedCloudInspection({
      rawNoticeText: text,
      view,
      responseGoal: "request_billing_review",
    });
    expect(inspection.exactSerialized).not.toBeNull();
    expect(inspection.violations).toEqual([]);
  });

  it("o5 keeps the cancellation ineligible and the reinstatement eligible", () => {
    const text =
      "The £1,280 charge was cancelled on 3 November 2026.\nThe £1,280 charge has been reinstated.\nPlease pay the outstanding balance by 9 December 2026.";
    const { view, built } = read(text);
    const cancelled = view.eligibility.decisions.find((item) => item.role === "cancelled_demand");
    const reinstated = view.eligibility.decisions.find((item) => item.role === "reinstated_demand");
    expect(cancelled?.status).toBe("INELIGIBLE");
    expect(cancelled?.amount).toBe(1280);
    expect(reinstated?.status).toBe("ELIGIBLE");
    expect(reinstated?.amount).toBe(1280);
    expect(cancelled?.id).not.toBe(reinstated?.id);
    expect(built.payload.amountsGBP).toEqual([1280]);
    expect(built.payload.responseDeadlines).toEqual(["2026-12-09"]);
  });

  it("keeps a same-amount new charge eligible and the cancelled demand ineligible", () => {
    const text =
      "The £1,280 demand has been cancelled.\nWe have since raised a separate charge of £1,280 for your new meter installation. Please pay the outstanding balance by 9 December 2026.";
    const { view, built } = read(text);
    expect(view.eligibility.decisions.find((item) => item.role === "cancelled_demand")?.status).toBe("INELIGIBLE");
    expect(view.eligibility.decisions.some((item) => item.amount === 1280 && item.status === "ELIGIBLE")).toBe(true);
    expect(built.payload.amountsGBP).toEqual([1280]);
  });

  it("gives repeated sentences distinct ids and keeps one amount", () => {
    const text = "Your outstanding balance is £1,280.\nYour outstanding balance is £1,280.";
    const { view, built } = read(text);
    const eligible = view.eligibility.decisions.filter((item) => item.status === "ELIGIBLE" && item.amount === 1280);
    expect(eligible).toHaveLength(2);
    expect(new Set(eligible.map((item) => item.id)).size).toBe(2);
    expect(built.payload.amountsGBP).toEqual([1280]);
  });

  it("keeps claim identity when the decision list is reordered", () => {
    const text = "Your outstanding balance is £520. Please pay the outstanding balance by 9 December 2026.";
    const { view } = read(text);
    const reversed = [...view.eligibility.decisions].reverse();
    const amounts = (items: typeof reversed) =>
      [
        ...new Set(
          items
            .filter((item) => item.status === "ELIGIBLE" && item.amount !== null)
            .map((item) => item.amount)
        ),
      ];
    expect(amounts(reversed)).toEqual(amounts(view.eligibility.decisions));
    expect(reversed.map((item) => item.id).sort()).toEqual(view.eligibility.decisions.map((item) => item.id).sort());
  });

  it("uses exact offsets for CRLF and Unicode source text", () => {
    const crlf =
      "  The £1,280 demand has been cancelled.\r\n   Your outstanding balance is now £520.\r\n" + PAY;
    const crlfView = read(crlf).view;
    const current = crlfView.eligibility.decisions.find((item) => item.amount === 520 && item.status === "ELIGIBLE");
    expect(current).toBeTruthy();
    expect(crlf.slice(current!.evidence.start, current!.evidence.end)).toContain("£520");
    const unicode = "Cafe\u0301 account. Your outstanding balance is £1,280. " + PAY;
    const unicodeView = read(unicode).view;
    const balance = unicodeView.eligibility.decisions.find((item) => item.amount === 1280 && item.status === "ELIGIBLE");
    expect(unicode.slice(balance!.evidence.start, balance!.evidence.end)).toBe("Your outstanding balance is £1,280.");
    expect(unicode.slice(0, balance!.evidence.start)).toContain("Cafe\u0301");
  });

  it("freezes eligibility so a later edit cannot change the decision", () => {
    const { view, built } = read("Your outstanding balance is £520. " + PAY);
    expect(Object.isFrozen(view.eligibility)).toBe(true);
    expect(Object.isFrozen(view.eligibility.decisions)).toBe(true);
    expect(Object.isFrozen(view.eligibility.decisions[0])).toBe(true);
    expect(() => {
      (view.eligibility as { paymentActionSupported: boolean }).paymentActionSupported = false;
    }).toThrow(TypeError);
    expect(built.payload.amountsGBP).toEqual([520]);
  });
});

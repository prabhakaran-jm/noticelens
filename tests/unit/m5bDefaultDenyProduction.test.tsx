import { readFileSync } from "node:fs";
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_SUBMISSION_ENABLED, requestCloudSubmission } from "../../src/adapters/cloudApprovalSession";
import { requestClosedBriefSend, resetUserApprovalStateForTests } from "../../src/adapters/privacyApproval";
import type { InferenceCallRecord, RawNoticeExtraction } from "../../src/domain/types";
import { normalizeNewlines } from "../../src/domain/textNormalize";
import { App } from "../../src/App";
import { stubCoreFirebaseEnv } from "./stubCoreFirebaseEnv";

const harness = vi.hoisted(() => {
  const pending: Array<{
    text: string;
    resolve: (value: InferenceCallRecord<RawNoticeExtraction>) => void;
  }> = [];
  return {
    pending,
    runOnDeviceNoticeExtraction: (text: string) =>
      new Promise<InferenceCallRecord<RawNoticeExtraction>>((resolve) => {
        pending.push({ text, resolve });
      }),
    probe: () =>
      Promise.resolve({
        hasLanguageModelGlobal: true,
        availability: "available" as const,
        userAgent: "test",
        isOnline: false,
        errorDetail: null,
        checkedAtIso: "2026-11-14T00:00:00.000Z",
      }),
  };
});

vi.mock("../../src/ai/onDeviceExtractor", () => ({
  runOnDeviceNoticeExtraction: harness.runOnDeviceNoticeExtraction,
}));

vi.mock("../../src/ai/capability", async () => {
  const actual = await vi.importActual<typeof import("../../src/ai/capability")>("../../src/ai/capability");
  return {
    ...actual,
    probeChromeLanguageModelAvailability: harness.probe,
  };
});

const original = normalizeNewlines(readFileSync("examples/energy-backbill-original.txt", "utf8"));
const revised = normalizeNewlines(readFileSync("examples/energy-backbill-revised.txt", "utf8"));
const unsupported = `Northwind Energy

4 March 2026

Dear A Example,

The outstanding balance should be around £520.
Please pay the balance by 20 March 2026.
`;
const network: string[] = [];

function replyJson(): string {
  return (screen.getByTestId("exact-json").textContent ?? "").trim();
}

function setNotice(value: string): void {
  fireEvent.click(screen.getByTestId("nav-read"));
  fireEvent.change(screen.getByTestId("notice-text"), { target: { value } });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

async function boot(): Promise<void> {
  render(<App />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function openAndApprove(): void {
  fireEvent.click(screen.getByTestId("nav-reply"));
  fireEvent.click(screen.getByRole("button", { name: "Review privacy approval" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "I have reviewed this exact payload" }));
  fireEvent.click(screen.getByTestId("privacy-approve"));
}

describe("Phase 5B production grounding", () => {
  beforeEach(() => {
    stubCoreFirebaseEnv();
    harness.pending.length = 0;
    network.length = 0;
    resetUserApprovalStateForTests();
    vi.stubGlobal("fetch", (input: unknown) => {
      network.push(String(input));
      return Promise.reject(new Error("cloud submission is disabled"));
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("shows the demo facts, withholds an unsupported amount, and keeps send disabled", async () => {
    expect(CLOUD_SUBMISSION_ENABLED).toBe(false);
    expect(() => requestCloudSubmission({} as never)).toThrow();
    expect(() => requestClosedBriefSend({} as never)).toThrow();
    await boot();
    expect(document.body.textContent ?? "").not.toMatch(/DEMO_ELIGIBLE|demo-eligible|Cloud eligible|PREFLIGHT_READY/i);
    expect(screen.getByTestId("read-amount")).toHaveTextContent("£1,280");
    expect(screen.getByTestId("read-amount")).not.toHaveTextContent("£0");

    fireEvent.click(screen.getByTestId("nav-plan"));
    expect(screen.getByTestId("plan-amount")).toHaveTextContent("£1,280");
    fireEvent.click(screen.getByTestId("nav-compare"));
    expect(screen.getByTestId("compare-original-amount")).toHaveTextContent("£1,280");
    expect(screen.getByTestId("compare-revised-amount")).toHaveTextContent("£520");
    expect(screen.getByTestId("amount-difference")).toHaveTextContent("Needs review");
    expect(screen.getByTestId("amount-difference")).not.toHaveTextContent("£760");
    expect(screen.getByTestId("compare-relationship")).toHaveTextContent("needs review");

    openAndApprove();
    const approved = (screen.getByTestId("privacy-exact-json").textContent ?? "").trim();
    expect(approved).toContain('"amountsGBP":[1280]');
    expect(approved).toContain('"issueDate":"2026-11-18"');
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    setNotice(unsupported);
    await advance(300);
    expect(screen.getByTestId("read-amount")).toHaveTextContent("Needs review");
    expect(screen.getByTestId("read-amount")).not.toHaveTextContent("£0");
    expect(screen.getByTestId("read-amount")).not.toHaveTextContent("£520");
    fireEvent.click(screen.getByTestId("nav-reply"));
    const withheld = replyJson();
    expect(withheld).toContain('"amountsGBP":[]');
    expect(withheld).not.toContain("520");
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();
    await advance(1000);
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();
    expect(replyJson()).toBe(withheld);

    setNotice(original);
    await advance(300);
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson()).toBe(approved);
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();

    openAndApprove();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByTestId("nav-plan"));
    fireEvent.change(screen.getByLabelText("What you want the reply to ask"), {
      target: { value: "confirm_payment_plan_options" },
    });
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson()).not.toBe(approved);
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
    expect(network).toEqual([]);
    expect(revised.length).toBeGreaterThan(0);
  }, 20_000);

  it("drops a stale comparison when either notice changes", async () => {
    await boot();
    fireEvent.click(screen.getByTestId("nav-compare"));
    expect(screen.getByTestId("amount-difference")).toHaveTextContent("Needs review");
    expect(screen.getByTestId("amount-difference")).not.toHaveTextContent("£760");
    expect(screen.getByTestId("compare-relationship")).toHaveTextContent("needs review");
    expect(screen.getByTestId("compare-original-amount")).toHaveTextContent("£1,280");
    expect(screen.getByTestId("compare-revised-amount")).toHaveTextContent("£520");
    fireEvent.change(screen.getByTestId("revised-text"), {
      target: { value: "Our March letter said you owe £520." },
    });
    expect(screen.getByTestId("compare-revised-amount")).toHaveTextContent("Needs review");
    expect(screen.getByTestId("amount-difference")).toHaveTextContent("Needs review");
    expect(screen.getByTestId("amount-difference")).not.toHaveTextContent("£760");
    expect(screen.getByTestId("amount-difference")).not.toHaveTextContent("£0");
    fireEvent.click(screen.getByTestId("nav-read"));
    fireEvent.change(screen.getByTestId("notice-text"), {
      target: { value: "Imagine your outstanding balance is £1,280." },
    });
    await advance(300);
    fireEvent.click(screen.getByTestId("nav-compare"));
    expect(screen.getByTestId("compare-original-amount")).toHaveTextContent("Needs review");
    expect(screen.getByTestId("compare-original-amount")).not.toHaveTextContent("£1,280");
    expect(screen.getByTestId("amount-difference")).not.toHaveTextContent("lower");
  });

  it("does not let a stale on-device result approve an unsupported notice", async () => {
    await boot();
    fireEvent.click(screen.getByTestId("nav-read"));
    fireEvent.click(screen.getByTestId("read-on-device"));
    setNotice(unsupported);
    const stale = harness.pending[0];
    await act(async () => {
      stale?.resolve({
        output: {
          noticeCategory: "utility_electricity",
          issueDate: "4 March 2026",
          billingPeriod: "",
          amountGBP: 520,
          responseDeadline: "20 March 2026",
          obligations: [{ action: "Pay", dueDate: null, sourceQuote: "should be around" }],
        },
        rawResponseText: "must not be stored",
        inferenceSource: "on_device",
        latencyMs: 4,
      } as InferenceCallRecord<RawNoticeExtraction>);
    });
    await advance(100);
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson()).toBe("No exact payload is available.");
    await advance(200);
    const settled = replyJson();
    expect(settled).toContain('"amountsGBP":[]');
    expect(settled).not.toContain("520");
    fireEvent.click(screen.getByTestId("nav-read"));
    expect(screen.getByTestId("read-amount")).toHaveTextContent("Needs review");
    expect(screen.getByTestId("read-amount")).not.toHaveTextContent("£0");
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
  });

  it("keeps a supported balance when a later sentence only offers help", async () => {
    await boot();
    setNotice(
      "Northwind Energy\n\n18 November 2026\n\nDear A Example,\n\nYour outstanding balance is £640.\nPlease pay by 30 November 2026.\nIf you are struggling to pay, our hardship fund may be able to help.\n"
    );
    await advance(300);
    expect(screen.getByTestId("read-amount")).toHaveTextContent("£640");
    expect(screen.getByTestId("read-amount")).not.toHaveTextContent("Needs review");
    expect(screen.getByTestId("read-deadline")).toHaveTextContent("30 November 2026");
    fireEvent.click(screen.getByTestId("nav-plan"));
    expect(screen.getByTestId("plan-amount")).toHaveTextContent("£640");
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson()).toContain('"amountsGBP":[640]');
    fireEvent.click(screen.getByTestId("nav-compare"));
    expect(screen.getByTestId("compare-original-amount")).toHaveTextContent("£640");
    expect(screen.getByTestId("compare-original-amount")).not.toHaveTextContent("Needs review");
    setNotice(unsupported);
    await advance(300);
    fireEvent.click(screen.getByTestId("nav-read"));
    expect(screen.getByTestId("read-amount")).toHaveTextContent("Needs review");
    expect(screen.getByTestId("read-amount")).not.toHaveTextContent("£520");
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
  });

  it("does not verify a balance that a later credit has cleared when a fee is also stated", async () => {
    await boot();
    setNotice(
      "Northwind Energy\n\n18 November 2026\n\nDear A Example,\n\nYour outstanding balance is £640.\nPlease pay by 30 November 2026.\nA late payment fee of £15 is included.\nA hardship credit has cleared the balance.\n"
    );
    await advance(300);
    expect(screen.getByTestId("read-amount")).not.toHaveTextContent("£640");
    expect(screen.getByTestId("read-amount")).not.toHaveTextContent("Verified");
    expect(screen.getByTestId("read-amount-support")).not.toHaveTextContent("Verified");
    expect(screen.getByTestId("read-deadline")).not.toHaveTextContent("30 November 2026");
    fireEvent.click(screen.getByTestId("nav-plan"));
    expect(screen.getByTestId("plan-amount")).not.toHaveTextContent("£640");
    expect(screen.getByTestId("plan-amount")).not.toHaveTextContent("Verified");
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson()).toContain('"amountsGBP":[]');
    expect(replyJson()).not.toContain("640");
    fireEvent.click(screen.getByTestId("nav-compare"));
    expect(screen.getByTestId("compare-original-amount")).not.toHaveTextContent("£640");
    expect(screen.getByTestId("amount-difference")).not.toHaveTextContent("£640");
    expect(screen.getByTestId("amount-difference")).not.toHaveTextContent("£760");
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
  });

  it("withholds a settlement that comes before the same amount is restated", async () => {
    await boot();
    setNotice(
      "Northwind Energy\n\n18 November 2026\n\nDear A Example,\n\nCustomer services resolved the £640 charge on 2 November 2026.\nPlease pay £640 by 30 November 2026.\n"
    );
    await advance(300);
    expect(screen.getByTestId("read-amount")).not.toHaveTextContent("£640");
    expect(screen.getByTestId("read-amount-support")).not.toHaveTextContent("Verified");
    fireEvent.click(screen.getByTestId("nav-plan"));
    expect(screen.getByTestId("plan-amount")).not.toHaveTextContent("£640");
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson()).toContain('"amountsGBP":[]');
    expect(replyJson()).not.toContain("[640]");
    fireEvent.click(screen.getByTestId("nav-compare"));
    expect(screen.getByTestId("compare-original-amount")).not.toHaveTextContent("£640");
    expect(screen.getByTestId("amount-difference")).not.toHaveTextContent("£640");
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
    expect(network).toEqual([]);
  });

  it("withholds a bill that has been credited in full and an amount that is on hold", async () => {
    await boot();
    setNotice(
      "Northwind Energy\n\n18 November 2026\n\nDear A Example,\n\nYour outstanding balance is £640.\nPlease pay by 30 November 2026.\n\nThis bill has been credited in full; the reminder was about your old account, not this bill.\n"
    );
    await advance(300);
    expect(screen.getByTestId("read-amount")).not.toHaveTextContent("£640");
    expect(screen.getByTestId("read-amount-support")).not.toHaveTextContent("Verified");
    fireEvent.click(screen.getByTestId("nav-plan"));
    expect(screen.getByTestId("plan-amount")).not.toHaveTextContent("£640");
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson()).toContain('"amountsGBP":[]');
    fireEvent.click(screen.getByTestId("nav-compare"));
    expect(screen.getByTestId("compare-original-amount")).not.toHaveTextContent("£640");
    expect(screen.getByTestId("amount-difference")).not.toHaveTextContent("£640");
    setNotice(
      "Northwind Energy\n\n18 November 2026\n\nDear A Example,\n\nYour outstanding balance is £640.\nPlease pay by 30 November 2026.\nYou have disputed this amount and it is on hold while we investigate.\n"
    );
    await advance(300);
    fireEvent.click(screen.getByTestId("nav-read"));
    expect(screen.getByTestId("read-amount")).not.toHaveTextContent("£640");
    expect(screen.getByTestId("read-amount-support")).not.toHaveTextContent("Verified");
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson()).toContain('"amountsGBP":[]');
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
    expect(network).toEqual([]);
  });

  it("keeps a separate demand after a removed £30 dispute and drops approval when the text becomes unsupported", async () => {
    await boot();
    setNotice(
      "Northwind Energy\n\n18 November 2026\n\nDear A Example,\n\nYou have disputed a separate £30 charge, which we have removed.\nYour outstanding balance is £640.\nPlease pay by 30 November 2026.\n"
    );
    await advance(300);
    expect(screen.getByTestId("read-amount")).toHaveTextContent("£640");
    expect(screen.getByTestId("read-amount-support")).not.toHaveTextContent("Needs review");
    expect(screen.getByTestId("read-deadline")).toHaveTextContent("30 November 2026");
    fireEvent.click(screen.getByTestId("nav-plan"));
    expect(screen.getByTestId("plan-amount")).toHaveTextContent("£640");
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson()).toContain('"amountsGBP":[640]');
    openAndApprove();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByTestId("privacy-current")).toBeInTheDocument();
    setNotice(
      "Northwind Energy\n\n18 November 2026\n\nDear A Example,\n\nIt is not true that £640 remains due.\n"
    );
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();
    await advance(300);
    fireEvent.click(screen.getByTestId("nav-read"));
    expect(screen.getByTestId("read-amount")).not.toHaveTextContent("£640");
    expect(screen.getByTestId("read-amount-support")).not.toHaveTextContent("Verified");
    fireEvent.click(screen.getByTestId("nav-compare"));
    expect(screen.getByTestId("compare-original-amount")).not.toHaveTextContent("£640");
    expect(screen.getByTestId("amount-difference")).not.toHaveTextContent("£640");
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson()).toContain('"amountsGBP":[]');
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
    expect(network).toEqual([]);
  });

  it("clears a comparison immediately, settles once, and leaves v2 unchanged", async () => {
    await boot();
    fireEvent.click(screen.getByTestId("nav-read"));
    expect(screen.getByTestId("read-issue-date")).toHaveTextContent("18 November 2026");
    expect(screen.getByTestId("read-deadline")).toHaveTextContent("25 November 2026");
    fireEvent.click(screen.getByTestId("nav-compare"));
    expect(screen.getByTestId("compare-original-issue")).toHaveTextContent("18 November 2026");
    expect(screen.getByTestId("compare-original-issue")).not.toHaveTextContent("Needs review");
    expect(screen.getByTestId("compare-original-response")).toHaveTextContent("25 November 2026");
    expect(screen.getByTestId("compare-original-response")).not.toHaveTextContent("Contact deadline");
    expect(screen.getByTestId("compare-revised-response")).toHaveTextContent("Contact deadline: 16 December 2026");
    expect(screen.getByTestId("amount-difference")).not.toHaveTextContent("£760");
    fireEvent.click(screen.getByTestId("nav-reply"));
    const before = replyJson();
    expect(before).toContain('"amountsGBP":[1280]');
    expect(before).toContain('"issueDate":"2026-11-18"');
    fireEvent.click(screen.getByTestId("nav-compare"));
    const comparable = `Northwind Energy\n\n2 December 2026\n\nDear A Example,\n\nAccount reference: EXAMPLE-8472\nThe balance now requested is £520 for electricity supplied between January and June 2025.\nPlease pay the outstanding balance by 16 December 2026.\n`;
    fireEvent.change(screen.getByTestId("revised-text"), { target: { value: comparable } });
    expect(screen.getByTestId("amount-difference")).toHaveTextContent("Needs review");
    expect(screen.getByTestId("amount-difference")).not.toHaveTextContent("lower");
    await advance(300);
    expect(screen.getByTestId("compare-revised-amount")).toHaveTextContent("£520");
    expect(screen.getByTestId("amount-difference")).toHaveTextContent("£760 lower");
    expect(screen.getByTestId("amount-difference")).not.toHaveTextContent("recovered");
    expect(screen.getByTestId("amount-difference")).not.toHaveTextContent("refund");
    let latest = comparable;
    for (let index = 0; index < 10; index += 1) {
      latest += " ";
      fireEvent.change(screen.getByTestId("revised-text"), { target: { value: latest } });
      expect(screen.getByTestId("amount-difference")).toHaveTextContent("Needs review");
      expect(screen.getByTestId("amount-difference")).not.toHaveTextContent("£760");
    }
    fireEvent.change(screen.getByTestId("revised-text"), {
      target: { value: latest.replace("electricity", "gas") },
    });
    expect(screen.getByTestId("amount-difference")).not.toHaveTextContent("£760");
    await advance(300);
    expect(screen.getByTestId("amount-difference")).toHaveTextContent("Different liabilities");
    expect(screen.getByTestId("amount-difference")).not.toHaveTextContent("£760");
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson()).toBe(before);
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
    expect(network).toEqual([]);
  });

  it("drops approval immediately and survives a strict-mode remount", async () => {
    await boot();
    openAndApprove();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByTestId("privacy-current")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("nav-compare"));
    fireEvent.change(screen.getByTestId("revised-text"), { target: { value: "Revised notice changed." } });
    expect(screen.getByTestId("amount-difference")).toHaveTextContent("Needs review");
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
    cleanup();
    render(
      <StrictMode>
        <App />
      </StrictMode>
    );
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByTestId("nav-compare"));
    fireEvent.change(screen.getByTestId("revised-text"), { target: { value: "First edit." } });
    fireEvent.change(screen.getByTestId("revised-text"), { target: { value: "Second edit." } });
    expect(screen.getByTestId("amount-difference")).not.toHaveTextContent("£760");
    await advance(300);
    expect(screen.getByTestId("compare-revised-amount")).toHaveTextContent("Not stated");
    expect(screen.getByTestId("amount-difference")).toHaveTextContent("Needs review");
    expect(screen.getByTestId("amount-difference")).not.toHaveTextContent("£760");
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
  });
});

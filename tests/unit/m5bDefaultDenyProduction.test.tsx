import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_SUBMISSION_ENABLED, requestCloudSubmission } from "../../src/adapters/cloudApprovalSession";
import { requestClosedBriefSend, resetUserApprovalStateForTests } from "../../src/adapters/privacyApproval";
import type { InferenceCallRecord, RawNoticeExtraction } from "../../src/domain/types";
import { normalizeNewlines } from "../../src/domain/textNormalize";
import { App } from "../../src/App";

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
    expect(screen.getByTestId("read-amount")).toHaveTextContent("£1,280");
    expect(screen.getByTestId("read-amount")).not.toHaveTextContent("£0");

    fireEvent.click(screen.getByTestId("nav-plan"));
    expect(screen.getByTestId("plan-amount")).toHaveTextContent("£1,280");
    fireEvent.click(screen.getByTestId("nav-compare"));
    expect(screen.getByTestId("compare-original-amount")).toHaveTextContent("£1,280");
    expect(screen.getByTestId("compare-revised-amount")).toHaveTextContent("£520");
    expect(screen.getByTestId("amount-difference")).toHaveTextContent("£760 lower");

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
  });

  it("drops a stale comparison when either notice changes", async () => {
    await boot();
    fireEvent.click(screen.getByTestId("nav-compare"));
    expect(screen.getByTestId("amount-difference")).toHaveTextContent("£760 lower");
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
});

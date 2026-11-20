import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_SUBMISSION_ENABLED } from "../../src/adapters/cloudApprovalSession";
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

function extractionRecord(category: RawNoticeExtraction["noticeCategory"]): InferenceCallRecord<RawNoticeExtraction> {
  return {
    output: {
      noticeCategory: category,
      issueDate: "18 November 2026",
      billingPeriod: "January and June 2025",
      amountGBP: 1280,
      responseDeadline: "25 November 2026",
      obligations: [{ action: "Read the notice", dueDate: null, sourceQuote: "synthetic" }],
    },
    rawResponseText: "must not be stored",
    inferenceSource: "on_device",
    latencyMs: 1,
  };
}

describe("Phase 3H inspection debounce liveness", () => {
  beforeEach(() => {
    stubCoreFirebaseEnv();
    harness.pending.length = 0;
    resetUserApprovalStateForTests();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("L1 recovers a payload after a response-goal change inside the debounce window", async () => {
    await boot();
    openAndApprove();
    expect(screen.getByTestId("privacy-approved")).toBeInTheDocument();

    setNotice(`${original} `);
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson()).toBe("No exact payload is available.");
    expect(screen.queryByTestId("privacy-approved")).not.toBeInTheDocument();
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();

    await advance(100);
    fireEvent.click(screen.getByTestId("nav-plan"));
    fireEvent.change(screen.getByLabelText("What you want the reply to ask"), {
      target: { value: "confirm_payment_plan_options" },
    });
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson()).toBe("No exact payload is available.");

    await advance(5000);
    fireEvent.click(screen.getByTestId("nav-reply"));
    const settled = replyJson();
    expect(settled.startsWith("{")).toBe(true);
    expect(settled).toContain("confirm_payment_plan_options");
    expect(settled).toContain("1280");
    expect(screen.queryByTestId("privacy-approved")).not.toBeInTheDocument();
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Review privacy approval" }));
    const approve = screen.getByTestId("privacy-approve") as HTMLButtonElement;
    approve.removeAttribute("disabled");
    fireEvent.click(approve);
    expect(screen.queryByTestId("privacy-approved")).not.toBeInTheDocument();
  });

  it("L3 recovers a payload after a circumstance checkbox change inside the debounce window", async () => {
    await boot();
    setNotice(`${original} `);
    await advance(50);
    fireEvent.click(screen.getByTestId("nav-plan"));
    fireEvent.click(screen.getByRole("checkbox", { name: "The usage period may be longer than 12 months" }));
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson()).toBe("No exact payload is available.");

    await advance(5000);
    fireEvent.click(screen.getByTestId("nav-reply"));
    const settled = replyJson();
    expect(settled.startsWith("{")).toBe(true);
    expect(settled).toContain("usage_billed_over_12_months");
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
  });

  it("does not restore an approval when the notice text returns to the same bytes", async () => {
    await boot();
    openAndApprove();
    const approved = (screen.getByTestId("privacy-exact-json").textContent ?? "").trim();
    setNotice(`${original} x`);
    await advance(300);
    setNotice(original);
    await advance(300);
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson()).toBe(approved);
    expect(screen.queryByTestId("privacy-approved")).not.toBeInTheDocument();
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();
  });

  it("applies an on-device read that finishes during the debounce window and still settles inspection", async () => {
    await boot();
    expect(screen.getByTestId("read-on-device")).toBeEnabled();
    setNotice(`${original} `);
    fireEvent.click(screen.getByTestId("read-on-device"));
    const request = harness.pending[0];
    expect(request?.text.endsWith(" ")).toBe(true);
    await act(async () => {
      request?.resolve(extractionRecord("council_tax"));
    });
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson()).toBe("No exact payload is available.");

    await advance(300);
    fireEvent.click(screen.getByTestId("nav-read"));
    expect(screen.getByTestId("category-guidance")).toHaveTextContent(/did not match the notice text/i);
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson().startsWith("{")).toBe(true);
    expect(replyJson()).not.toContain("citizens-advice-council-tax");
  });

  it("discards an on-device read that belongs to the notice from before the edit", async () => {
    await boot();
    fireEvent.click(screen.getByTestId("read-on-device"));
    setNotice("Please contact our billing team about the account.");
    const request = harness.pending[0];
    await act(async () => {
      request?.resolve(extractionRecord("council_tax"));
    });
    await advance(300);
    fireEvent.click(screen.getByTestId("nav-read"));
    expect(screen.queryByTestId("category-guidance")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("nav-reply"));
    const settled = replyJson();
    expect(settled.startsWith("{")).toBe(true);
    expect(settled).toContain('"amountsGBP":[]');
    expect(CLOUD_SUBMISSION_ENABLED).toBe(false);
    expect(() =>
      requestClosedBriefSend({
        id: "local",
        serialized: settled,
        generation: 1,
        identifierContext: "ctx",
      } as never)
    ).toThrow();
  });
});

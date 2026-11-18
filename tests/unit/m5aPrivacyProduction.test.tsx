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
const network: string[] = [];
const nfcName = original.replace("Dear Sarah Example,", "Dear José Álvarez,");
const nfdName = original.replace("Dear Sarah Example,", "Dear Jose\u0301 Álvarez,");
const otherAccount = original.replace("Account reference: EXAMPLE-8472", "Account reference: EXAMPLE-9999");

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

function extractionRecord(): InferenceCallRecord<RawNoticeExtraction> {
  return {
    output: {
      noticeCategory: "utility_electricity",
      issueDate: "18 November 2026",
      billingPeriod: "January and June 2025",
      amountGBP: 1280,
      responseDeadline: "25 November 2026",
      obligations: [{ action: "Read the notice", dueDate: null, sourceQuote: "synthetic" }],
    },
    rawResponseText: "must not be stored",
    inferenceSource: "on_device",
    latencyMs: 4,
  };
}

describe("Phase 5A production privacy and approval", () => {
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

  it("drops approval when a recognised identifier changes, including unicode form, and does not restore it", async () => {
    await boot();
    openAndApprove();
    const approved = (screen.getByTestId("privacy-exact-json").textContent ?? "").trim();
    expect(approved).toContain('"amountsGBP":[1280]');
    expect(approved).not.toContain("Sarah");
    expect(approved).not.toContain("EXAMPLE-8472");
    expect(approved).not.toContain("José");

    setNotice(nfcName);
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson()).toBe("No exact payload is available.");
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();
    await advance(300);
    const renamed = replyJson();
    expect(renamed).toContain('"amountsGBP":[1280]');
    expect(renamed).not.toContain("José");
    expect(renamed).not.toContain("Álvarez");
    expect(renamed).not.toContain("EXAMPLE-8472");
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();

    setNotice(nfdName);
    await advance(300);
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson()).not.toContain("José");
    expect(replyJson()).not.toContain("\u0301");
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();

    setNotice(otherAccount);
    await advance(300);
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson()).toContain('"amountsGBP":[1280]');
    expect(replyJson()).not.toContain("EXAMPLE-9999");
    expect(replyJson()).not.toContain("9999");
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();

    setNotice(original);
    await advance(300);
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson()).toBe(approved);
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
    expect(network).toEqual([]);
  }, 20000);

  it("keeps the 300 ms debounce and discards a stale on-device result after an identifier edit", async () => {
    await boot();
    openAndApprove();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByTestId("nav-read"));
    fireEvent.click(screen.getByTestId("read-on-device"));
    setNotice(nfcName);
    const stale = harness.pending[0];
    await act(async () => {
      stale?.resolve(extractionRecord());
    });
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson()).toBe("No exact payload is available.");
    await advance(100);
    expect(replyJson()).toBe("No exact payload is available.");
    await advance(200);
    const settled = replyJson();
    expect(settled.startsWith("{")).toBe(true);
    expect(settled).toContain('"amountsGBP":[1280]');
    expect(settled).not.toContain("José");
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
    expect(network).toEqual([]);
  });

  it("withholds an oversized notice and keeps cloud sending disabled", async () => {
    await boot();
    setNotice(`${original}${" ".repeat(8001)}`);
    await advance(300);
    fireEvent.click(screen.getByTestId("nav-read"));
    expect(screen.getByText(/longer than the supported size \(8,000 characters\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson()).toBe("No exact payload is available.");
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
    expect(CLOUD_SUBMISSION_ENABLED).toBe(false);
    expect(() =>
      requestCloudSubmission({
        cloudSendEnabled: false,
        approval: null,
        canonical: null,
        violations: [],
        blockedReason: "Cloud submission is not connected.",
      })
    ).toThrow(/not connected/i);
    expect(() =>
      requestClosedBriefSend({
        kind: "user-canonical-snapshot",
        id: "stale-token",
        generation: 1,
        serialized: "{}",
        guardOptions: {},
        identifierContext: "[]",
        cloudSendEnabled: false,
      })
    ).toThrow();
    const registry = readFileSync("src/domain/approvalRegistry.ts", "utf8");
    expect(registry).not.toContain("rawValue");
    expect(registry).not.toContain("forbiddenIdentifiers");
    expect(registry).not.toContain("José");
    const session = readFileSync("src/adapters/cloudApprovalSession.ts", "utf8");
    expect(session).toContain("export const CLOUD_SUBMISSION_ENABLED = false as const;");
    expect(network).toEqual([]);

    setNotice(revised);
    await advance(300);
    fireEvent.click(screen.getByTestId("nav-reply"));
    const revisedJson = replyJson();
    expect(revisedJson).toContain('"amountsGBP":[520]');
    expect(revisedJson).toContain("2026-12-16");
    expect(revisedJson).not.toContain("Sarah");
    expect(revisedJson).not.toContain("1280");
  });
});

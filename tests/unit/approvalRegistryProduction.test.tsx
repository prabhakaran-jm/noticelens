import { readFileSync } from "node:fs";
import { StrictMode } from "react";
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

describe("production approval registry", () => {
  beforeEach(() => {
    harness.pending.length = 0;
    network.length = 0;
    resetUserApprovalStateForTests();
    vi.stubGlobal(
      "fetch",
      (input: unknown) => {
        network.push(String(input));
        return Promise.reject(new Error("cloud submission is disabled"));
      }
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("shows the exact canonical bytes and clears approval when the modal is closed and reopened after an edit", async () => {
    await boot();
    fireEvent.click(screen.getByTestId("nav-reply"));
    const shown = replyJson();
    expect(shown.startsWith('{"schemaVersion":"noticelens.cloud-brief.v2"')).toBe(true);
    openAndApprove();
    expect((screen.getByTestId("privacy-exact-json").textContent ?? "").trim()).toBe(shown);
    expect(screen.getByTestId("privacy-approved")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "I have reviewed this exact payload" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByTestId("privacy-current")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review privacy approval" }));
    expect(screen.getByRole("checkbox", { name: "I have reviewed this exact payload" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.click(screen.getByTestId("nav-plan"));
    fireEvent.change(screen.getByLabelText("What you want the reply to ask"), {
      target: { value: "confirm_payment_plan_options" },
    });
    fireEvent.change(screen.getByLabelText("What you want the reply to ask"), {
      target: { value: "request_billing_review" },
    });
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson()).toBe(shown);
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review privacy approval" }));
    expect(screen.getByRole("checkbox", { name: "I have reviewed this exact payload" })).not.toBeChecked();
    expect(screen.queryByTestId("privacy-approved")).not.toBeInTheDocument();
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
    expect(network).toEqual([]);
    expect(CLOUD_SUBMISSION_ENABLED).toBe(false);
  });

  it("invalidates during the debounce window for text, goal, checkbox, and repeated edits", async () => {
    await boot();
    openAndApprove();
    const approved = (screen.getByTestId("privacy-exact-json").textContent ?? "").trim();
    setNotice(`${original} `);
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson()).toBe("No exact payload is available.");
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review privacy approval" }));
    const approve = screen.getByTestId("privacy-approve") as HTMLButtonElement;
    approve.removeAttribute("disabled");
    fireEvent.click(approve);
    expect(screen.queryByTestId("privacy-approved")).not.toBeInTheDocument();

    await advance(100);
    fireEvent.click(screen.getByTestId("nav-plan"));
    fireEvent.change(screen.getByLabelText("What you want the reply to ask"), {
      target: { value: "request_breakdown_and_hold" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "The usage period may be longer than 12 months" }));
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson()).toBe("No exact payload is available.");
    await advance(500);
    const settled = replyJson();
    expect(settled.startsWith("{")).toBe(true);
    expect(settled).toContain("request_breakdown_and_hold");
    expect(settled).toContain("usage_billed_over_12_months");
    expect(settled).not.toBe(approved);
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();

    setNotice(`${original}  `);
    setNotice(`${original}   `);
    setNotice(`${original}\n`);
    fireEvent.click(screen.getByTestId("nav-reply"));
    await advance(50);
    expect(replyJson()).toBe("No exact payload is available.");
    await advance(300);
    expect(replyJson().startsWith("{")).toBe(true);
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
  });

  it("does not let a stale or in-window on-device result restore approval", async () => {
    await boot();
    openAndApprove();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByTestId("nav-read"));
    fireEvent.click(screen.getByTestId("read-on-device"));
    setNotice("Please contact our billing team about the account.");
    const stale = harness.pending[0];
    await act(async () => {
      stale?.resolve(extractionRecord());
    });
    await advance(300);
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();
    const withheld = replyJson();
    expect(withheld).toContain('"amountsGBP":[]');

    setNotice(`${original} `);
    fireEvent.click(screen.getByTestId("nav-read"));
    fireEvent.click(screen.getByTestId("read-on-device"));
    const current = harness.pending[1];
    await act(async () => {
      current?.resolve(extractionRecord());
    });
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson()).toBe("No exact payload is available.");
    await advance(300);
    expect(replyJson().startsWith("{")).toBe(true);
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
  });

  it("does not keep approval when the comparison notice changes, and unmounts a pending timer", async () => {
    await boot();
    openAndApprove();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByTestId("nav-compare"));
    fireEvent.change(screen.getByTestId("revised-text"), { target: { value: `${revised}\n` } });
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson().startsWith("{")).toBe(true);
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("nav-compare"));
    fireEvent.change(screen.getByTestId("revised-text"), { target: { value: revised } });
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();

    setNotice(`${original} pending`);
    cleanup();
    await advance(1000);
    expect(network).toEqual([]);
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
    const production = [
      "src/ui/production/NoticeLensApp.tsx",
      "src/ui/privacy/PrivacyApprovalModal.tsx",
      "src/ui/screens/PrepareReplyScreen.tsx",
      "src/domain/approvalRegistry.ts",
    ]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(production).not.toContain("runCloudDraft");
    expect(production).not.toContain("localStorage");
    expect(production).not.toContain("sessionStorage");
    expect(readFileSync("src/adapters/cloudApprovalSession.ts", "utf8")).toContain(
      "export const CLOUD_SUBMISSION_ENABLED = false as const;"
    );
  });

  it("keeps one approval across a strict remount of effects and does not restore it after an edit", async () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    openAndApprove();
    expect(screen.getByTestId("privacy-approved")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Review privacy approval" }));
    expect(screen.getByTestId("privacy-approved")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    setNotice(`${original}\nKeeper token JONES-1001`);
    await advance(300);
    fireEvent.click(screen.getByTestId("nav-reply"));
    const sameBytes = replyJson();
    expect(sameBytes.startsWith("{")).toBe(true);
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();
    setNotice(original);
    await advance(300);
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson()).toBe(sameBytes);
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();
    openAndApprove();
    expect(screen.getByTestId("privacy-approved")).toBeInTheDocument();
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
    expect(network).toEqual([]);
  });

  it("settles a goal and checkbox change made inside the debounce window as a new unapproved payload", async () => {
    await boot();
    openAndApprove();
    const approved = (screen.getByTestId("privacy-exact-json").textContent ?? "").trim();
    setNotice(`${original} `);
    await advance(100);
    fireEvent.click(screen.getByTestId("nav-plan"));
    fireEvent.change(screen.getByLabelText("What you want the reply to ask"), {
      target: { value: "request_breakdown_and_hold" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "The usage period may be longer than 12 months" }));
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(replyJson()).toBe("No exact payload is available.");
    await advance(300);
    const settled = replyJson();
    expect(settled).toContain("request_breakdown_and_hold");
    expect(settled).toContain("usage_billed_over_12_months");
    expect(settled).not.toBe(approved);
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
  });
});

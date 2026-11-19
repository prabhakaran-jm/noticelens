import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_SUBMISSION_ENABLED, createCloudApprovalSession, requestCloudSubmission } from "../../src/adapters/cloudApprovalSession";
import {
  liveCloudDraftMessage,
  resetLiveCloudDispatchForTests,
  sendLiveApprovedCloudDraft,
} from "../../src/adapters/liveCloudDispatch";
import { requestClosedBriefSend, resetUserApprovalStateForTests } from "../../src/adapters/privacyApproval";
import { approvalRegistryTestIsolation, activeApprovalCount } from "../../src/domain/approvalRegistry";
import { normalizeNewlines } from "../../src/domain/textNormalize";
import type { InferenceCallRecord, RawNoticeExtraction } from "../../src/domain/types";
import * as firebaseConfig from "../../src/config/firebase";
import { App } from "../../src/App";

const harness = vi.hoisted(() => {
  const pending: Array<{
    resolve: (value: InferenceCallRecord<RawNoticeExtraction>) => void;
  }> = [];
  return {
    pending,
    runOnDeviceNoticeExtraction: () =>
      new Promise<InferenceCallRecord<RawNoticeExtraction>>((resolve) => {
        pending.push({ resolve });
      }),
    probe: () =>
      Promise.resolve({
        hasLanguageModelGlobal: true,
        availability: "available" as const,
        userAgent: "test",
        isOnline: false,
        errorDetail: null,
        checkedAtIso: "2026-11-18T00:00:00.000Z",
      }),
  };
});

vi.mock("../../src/ai/onDeviceExtractor", () => ({
  runOnDeviceNoticeExtraction: harness.runOnDeviceNoticeExtraction,
}));

vi.mock("../../src/ai/capability", async () => {
  const actual = await vi.importActual<typeof import("../../src/ai/capability")>("../../src/ai/capability");
  return { ...actual, probeChromeLanguageModelAvailability: harness.probe };
});

const original = normalizeNewlines(readFileSync("examples/energy-backbill-original.txt", "utf8"));
const revised = normalizeNewlines(readFileSync("examples/energy-backbill-revised.txt", "utf8"));
const RAW_MARKERS = ["Sarah Example", "EXAMPLE-8472", "14 Example Road", "RG0 0AA"];

function draftJson(summary: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({
    summaryPlainEnglish: summary,
    options: [
      {
        title: "Ask for a billing review",
        rationale: "You can ask the sender to review the stated balance.",
        applicableCondition: "Use this if you want a review of the stated balance.",
      },
    ],
    replyTemplateWithPlaceholders: "Please review the stated balance for [ACCOUNT_REF].",
    citedGuidanceIds: [],
    ...extra,
  });
}

const ORIGINAL_DRAFT = draftJson("You can ask for a review of the stated balance of £1,280.");
const REVISED_DRAFT = draftJson("You can ask for a review of the stated balance of £520.");

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let step = 0; step < 12; step += 1) {
      await Promise.resolve();
    }
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

function openAndApprove(): void {
  fireEvent.click(screen.getByTestId("nav-reply"));
  if (screen.queryByRole("dialog") === null) {
    fireEvent.click(screen.getByRole("button", { name: "Review privacy approval" }));
  }
  const checkbox = screen.getByRole("checkbox", { name: "I have reviewed this exact payload" }) as HTMLInputElement;
  if (!checkbox.checked) {
    fireEvent.click(checkbox);
  }
  fireEvent.click(screen.getByTestId("privacy-approve"));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
}

function setNotice(value: string): void {
  fireEvent.click(screen.getByTestId("nav-read"));
  fireEvent.change(screen.getByTestId("notice-text"), { target: { value } });
}

async function boot(generate: (args: { prompt: string; signal: AbortSignal; modelName: string }) => Promise<{ text: string; inferenceSource: string | undefined }>, timeoutMs?: number): Promise<void> {
  render(<App cloudDraftProbe={{ generate, timeoutMs }} />);
  await flush();
}

describe("Phase 5C-4 Firebase cloud drafting", () => {
  const fetchSpy = vi.fn(() => Promise.reject(new Error("no firebase request")));

  beforeEach(() => {
    harness.pending.length = 0;
    resetUserApprovalStateForTests();
    resetLiveCloudDispatchForTests();
    approvalRegistryTestIsolation.useDefaultPrivacyReview();
    fetchSpy.mockClear();
    vi.stubGlobal("fetch", fetchSpy);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    cleanup();
    approvalRegistryTestIsolation.useDefaultPrivacyReview();
    resetLiveCloudDispatchForTests();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps the production switch off and the old send helpers blocked", () => {
    expect(CLOUD_SUBMISSION_ENABLED).toBe(false);
    const sessionSource = readFileSync("src/adapters/cloudApprovalSession.ts", "utf8");
    expect(sessionSource).toContain("false as const");
    expect(() => requestCloudSubmission(createCloudApprovalSession({ canonical: null }))).toThrow(
      /not connected/i
    );
    expect(() =>
      requestClosedBriefSend({
        id: "m5c4-blocked",
        serialized: "{}",
        guardOptions: {},
      } as never)
    ).toThrow();
    const drafter = readFileSync("src/ai/cloudDrafter.ts", "utf8");
    const frozen = drafter.slice(drafter.indexOf("export async function draftFromFrozenCanonicalBytes"));
    expect(frozen).not.toContain("approveCloudPayload");
    expect(frozen).toContain("generateWithFirebase");
    expect(drafter).toContain("InferenceMode.ONLY_IN_CLOUD");
    const transport = readFileSync("src/adapters/liveCloudDispatch.ts", "utf8");
    const signature = transport.slice(
      transport.indexOf("export async function sendLiveApprovedCloudDraft"),
      transport.indexOf("const probe = import.meta.env.PROD")
    );
    expect(signature).not.toContain("payload");
    expect(signature).not.toContain("reader");
  });

  it("does not send on load, when the modal opens, or when the notice is edited", async () => {
    const generate = vi.fn();
    await boot(generate);
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(screen.getByTestId("cloud-demo-scope")).toHaveTextContent("synthetic-fixture-only");
    fireEvent.click(screen.getByTestId("nav-reply"));
    fireEvent.click(screen.getByRole("button", { name: "Review privacy approval" }));
    fireEvent.click(screen.getByRole("presentation"));
    setNotice(`${original}\n`);
    await advance(300);
    expect(generate).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends one exact original brief and labels the cloud inference", async () => {
    const cloudAi = vi.spyOn(firebaseConfig, "getCloudFirebaseAI");
    const seen: string[] = [];
    const gate = deferred<{ text: string; inferenceSource: string }>();
    await boot((args) => {
      seen.push(args.prompt);
      return gate.promise;
    });
    openAndApprove();
    expect(screen.getByTestId("privacy-current")).toBeInTheDocument();
    const exact = screen.getByTestId("exact-json").textContent ?? "";
    fireEvent.click(screen.getByTestId("cloud-send-button"));
    expect(screen.getByTestId("cloud-draft-status")).toHaveTextContent("Sending the approved brief.");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(exact);
    for (const marker of RAW_MARKERS) {
      expect(seen[0]).not.toContain(marker);
    }
    expect(activeApprovalCount()).toBe(0);
    await act(async () => {
      gate.resolve({ text: ORIGINAL_DRAFT, inferenceSource: "in_cloud" });
    });
    await flush();
    expect(screen.getByTestId("cloud-draft-output")).toHaveTextContent("£1,280");
    expect(screen.getByTestId("cloud-draft-output")).not.toHaveTextContent("760");
    expect(screen.getByTestId("cloud-draft-output")).not.toHaveTextContent(/recovered/i);
    expect(screen.getByTestId("cloud-inference-label")).toHaveTextContent("Cloud inference: in_cloud");
    expect(screen.getByTestId("cloud-copy-button")).toBeDisabled();
    expect(screen.getByTestId("cloud-download-button")).toBeDisabled();
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
    expect(cloudAi).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
  });

  it("sends the revised fixture and keeps an arbitrary notice local", async () => {
    const seen: string[] = [];
    await boot(async (args) => {
      seen.push(args.prompt);
      return { text: REVISED_DRAFT, inferenceSource: "in_cloud" };
    });
    setNotice(revised);
    await advance(300);
    openAndApprove();
    fireEvent.click(screen.getByTestId("cloud-send-button"));
    await flush();
    expect(screen.getByTestId("cloud-draft-output")).toHaveTextContent("£520");
    expect(seen[0]).not.toContain("Sarah Example");
    expect(seen[0]).toContain("noticelens.cloud-brief.v2");
    setNotice("Please pay £10 by Friday.");
    await advance(300);
    expect(screen.getByTestId("notice-text")).toHaveValue("Please pay £10 by Friday.");
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
    expect(screen.getByTestId("cloud-fixture-explanation")).toHaveTextContent("two synthetic examples");
    expect(seen).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a send with no approval and does not restore a consumed approval", async () => {
    const generate = vi.fn(async () => ({ text: ORIGINAL_DRAFT, inferenceSource: "in_cloud" as const }));
    await boot(generate);
    fireEvent.click(screen.getByTestId("nav-reply"));
    const missing = await sendLiveApprovedCloudDraft({ generate });
    expect(missing.outcome).toBe("denied");
    if (missing.outcome === "denied") {
      expect(missing.state).toBe("APPROVAL_MISSING");
    }
    expect(generate).not.toHaveBeenCalled();
    openAndApprove();
    fireEvent.click(screen.getByTestId("cloud-send-button"));
    await flush();
    expect(screen.getByTestId("cloud-draft-output")).toBeInTheDocument();
    const again = await sendLiveApprovedCloudDraft({ generate });
    expect(again.outcome).toBe("denied");
    if (again.outcome === "denied") {
      expect(again.state).toBe("APPROVAL_ALREADY_CONSUMED");
    }
    expect(generate).toHaveBeenCalledTimes(1);
    expect(activeApprovalCount()).toBe(0);
    const disabled = await sendLiveApprovedCloudDraft();
    expect(disabled).toEqual({ outcome: "disabled" });
    expect(liveCloudDraftMessage(disabled)).toBe("Cloud sending is switched off.");
  });

  it("allows one in-flight request and rejects a reentrant send", async () => {
    const gate = deferred<{ text: string; inferenceSource: string }>();
    let calls = 0;
    const generate = () => {
      calls += 1;
      return gate.promise;
    };
    await boot(generate);
    openAndApprove();
    const first = sendLiveApprovedCloudDraft({ generate });
    const second = await sendLiveApprovedCloudDraft({ generate });
    expect(second).toEqual({ outcome: "in_flight" });
    expect(calls).toBe(1);
    gate.resolve({ text: ORIGINAL_DRAFT, inferenceSource: "in_cloud" });
    await flush();
    expect((await first).outcome).toBe("accepted");
    expect(activeApprovalCount()).toBe(0);
  });

  it("rejects a reentrant send from inside the model call", async () => {
    let nested = "";
    await boot(async () => ({ text: ORIGINAL_DRAFT, inferenceSource: "in_cloud" }));
    openAndApprove();
    const outer = await sendLiveApprovedCloudDraft({
      generate: async () => {
        const inner = await sendLiveApprovedCloudDraft({
          generate: async () => ({ text: ORIGINAL_DRAFT, inferenceSource: "in_cloud" }),
        });
        nested = inner.outcome;
        return { text: ORIGINAL_DRAFT, inferenceSource: "in_cloud" };
      },
    });
    expect(nested).toBe("in_flight");
    expect(outer.outcome).toBe("accepted");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("distinguishes timeout, cancellation, and network rejection without showing a draft", async () => {
    const hanging = vi.fn(() => new Promise<{ text: string; inferenceSource: string }>(() => undefined));
    await boot(hanging, 30);
    openAndApprove();
    fireEvent.click(screen.getByTestId("cloud-send-button"));
    await advance(30);
    await flush();
    expect(screen.getByTestId("cloud-draft-error")).toHaveTextContent("timed out");
    expect(screen.queryByTestId("cloud-draft-output")).not.toBeInTheDocument();
    expect(activeApprovalCount()).toBe(0);
    openAndApprove();
    const controller = new AbortController();
    const cancelled = sendLiveApprovedCloudDraft({
      generate: hanging,
      signal: controller.signal,
      timeoutMs: 1000,
    });
    controller.abort();
    await flush();
    expect(await cancelled).toEqual({ outcome: "rejected", reason: "cancelled" });
    expect(screen.queryByTestId("cloud-draft-output")).not.toBeInTheDocument();
    cleanup();
    resetLiveCloudDispatchForTests();
    resetUserApprovalStateForTests();
    const network = vi.fn(async () => {
      throw new Error("offline");
    });
    await boot(network);
    openAndApprove();
    fireEvent.click(screen.getByTestId("cloud-send-button"));
    await flush();
    expect(screen.getByTestId("cloud-draft-error")).toHaveTextContent("rejected");
    expect(screen.getByTestId("cloud-draft-error")).not.toHaveTextContent("offline");
    expect(screen.getByTestId("cloud-draft-error")).not.toHaveTextContent("Sarah");
    expect(screen.queryByTestId("cloud-draft-output")).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires a fresh approval before a retry", async () => {
    let calls = 0;
    await boot(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("offline");
      }
      return { text: ORIGINAL_DRAFT, inferenceSource: "in_cloud" };
    });
    openAndApprove();
    fireEvent.click(screen.getByTestId("cloud-send-button"));
    await flush();
    expect(screen.queryByTestId("cloud-draft-output")).not.toBeInTheDocument();
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
    fireEvent.click(screen.getByTestId("cloud-send-button"));
    await flush();
    expect(calls).toBe(1);
    openAndApprove();
    expect(screen.getByTestId("cloud-send-button")).toBeEnabled();
    fireEvent.click(screen.getByTestId("cloud-send-button"));
    await flush();
    expect(calls).toBe(2);
    expect(screen.getByTestId("cloud-draft-output")).toHaveTextContent("£1,280");
  });

  it.each([
    ["invalid json", "not json"],
    ["a hallucinated amount", draftJson("The recovered difference is £760.")],
    ["a hallucinated deadline", draftJson("Please reply by 1 January 2030.")],
    ["an unsupported legal conclusion", draftJson("This bill is invalid and you are not liable.")],
    ["an extra field", draftJson("You can ask for a review of the stated balance of £1,280.", { extraNote: "no" })],
    ["a personal identifier", draftJson("The account at RG0 0AA should be reviewed.")],
    ["unsupported Ofgem wording on the revised notice", ""],
  ])("rejects %s and does not show it as accepted", async (label, text) => {
    const body =
      label === "unsupported Ofgem wording on the revised notice"
        ? draftJson("Ofgem says the stated balance should be reviewed.")
        : text;
    if (label === "unsupported Ofgem wording on the revised notice") {
      await boot(async () => ({ text: body, inferenceSource: "in_cloud" }));
      setNotice(revised);
      await advance(300);
    } else {
      await boot(async () => ({ text: body, inferenceSource: "in_cloud" }));
    }
    openAndApprove();
    fireEvent.click(screen.getByTestId("cloud-send-button"));
    await flush();
    expect(screen.queryByTestId("cloud-draft-output")).not.toBeInTheDocument();
    expect(screen.getByTestId("cloud-draft-error")).toHaveTextContent("rejected");
    expect(screen.getByTestId("cloud-draft-error")).not.toHaveTextContent("760");
    expect(screen.getByTestId("cloud-draft-error")).not.toHaveTextContent("Sarah");
    expect(activeApprovalCount()).toBe(0);
  });

  async function startPendingSend(): Promise<{ resolve: (value: { text: string; inferenceSource: string }) => void }> {
    const gate = deferred<{ text: string; inferenceSource: string }>();
    await boot(() => gate.promise);
    openAndApprove();
    fireEvent.click(screen.getByTestId("cloud-send-button"));
    return gate;
  }

  function expectNoAcceptedDraft(): void {
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(screen.queryByTestId("cloud-draft-output")).not.toBeInTheDocument();
    expect(screen.getByTestId("cloud-draft-error")).toBeInTheDocument();
  }

  it("drops a late success after an edit", async () => {
    const gate = await startPendingSend();
    setNotice(`${original}\n`);
    gate.resolve({ text: ORIGINAL_DRAFT, inferenceSource: "in_cloud" });
    await flush();
    expectNoAcceptedDraft();
    expect(screen.getByTestId("cloud-draft-error")).toHaveTextContent("notice changed");
  });

  it("drops a late success after a goal change", async () => {
    const gate = await startPendingSend();
    fireEvent.click(screen.getByTestId("nav-plan"));
    fireEvent.change(screen.getByLabelText("What you want the reply to ask"), {
      target: { value: "request_breakdown_and_hold" },
    });
    gate.resolve({ text: ORIGINAL_DRAFT, inferenceSource: "in_cloud" });
    await flush();
    expectNoAcceptedDraft();
  });

  it("drops a late success after a circumstance flag change", async () => {
    const gate = await startPendingSend();
    fireEvent.click(screen.getByTestId("nav-plan"));
    fireEvent.click(screen.getByRole("checkbox", { name: "The usage period may be longer than 12 months" }));
    gate.resolve({ text: ORIGINAL_DRAFT, inferenceSource: "in_cloud" });
    await flush();
    expectNoAcceptedDraft();
  });

  it("drops a late success after the compared document changes", async () => {
    const gate = await startPendingSend();
    fireEvent.click(screen.getByTestId("nav-compare"));
    fireEvent.change(screen.getByTestId("revised-text"), { target: { value: `${revised}\n` } });
    gate.resolve({ text: ORIGINAL_DRAFT, inferenceSource: "in_cloud" });
    await flush();
    expectNoAcceptedDraft();
  });

  it("drops a late success after a newer on-device extraction", async () => {
    harness.pending.length = 0;
    const gate = await startPendingSend();
    fireEvent.click(screen.getByTestId("nav-read"));
    fireEvent.click(screen.getByTestId("read-on-device"));
    const extraction = harness.pending[0];
    await act(async () => {
      extraction?.resolve({
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
      });
    });
    gate.resolve({ text: ORIGINAL_DRAFT, inferenceSource: "in_cloud" });
    await flush();
    expectNoAcceptedDraft();
  });

  it("does not show a late success after unmount", async () => {
    const gate = await startPendingSend();
    cleanup();
    gate.resolve({ text: ORIGINAL_DRAFT, inferenceSource: "in_cloud" });
    await flush();
    expect(screen.queryByTestId("cloud-draft-output")).not.toBeInTheDocument();
  });

  it("rejects a cloud call when App Check is not configured, before any request", () => {
    vi.stubEnv("VITE_FIREBASE_API_KEY", "test-key");
    vi.stubEnv("VITE_FIREBASE_AUTH_DOMAIN", "test.firebaseapp.com");
    vi.stubEnv("VITE_FIREBASE_PROJECT_ID", "test-project");
    vi.stubEnv("VITE_FIREBASE_APP_ID", "1:1:web:test");
    vi.stubEnv("VITE_FIREBASE_APPCHECK_SITE_KEY", "");
    expect(() => firebaseConfig.getCloudFirebaseAI()).toThrow(/App Check/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("leaves the production Send control disabled when the test probe is absent", async () => {
    render(<App />);
    await flush();
    fireEvent.click(screen.getByTestId("nav-reply"));
    const button = screen.getByTestId("cloud-send-button");
    expect(button).toBeDisabled();
    expect(screen.getByTestId("cloud-disabled")).toHaveTextContent(/Cloud sending disabled/i);
    expect(screen.getByTestId("cloud-demo-scope")).toHaveTextContent("synthetic-fixture-only");
    fireEvent.click(button);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

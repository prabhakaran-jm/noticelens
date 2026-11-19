import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_SUBMISSION_ENABLED, createCloudApprovalSession, requestCloudSubmission } from "../../src/adapters/cloudApprovalSession";
import { requestClosedBriefSend, resetUserApprovalStateForTests } from "../../src/adapters/privacyApproval";
import { isRealCloudDiagnosticEnabled } from "../../src/adapters/realCloudDiagnostic";
import { activeApprovalCount, approvalRegistryTestIsolation } from "../../src/domain/approvalRegistry";
import { normalizeNewlines } from "../../src/domain/textNormalize";
import type { InferenceCallRecord, RawNoticeExtraction } from "../../src/domain/types";
import { App } from "../../src/App";
import { resetLiveCloudDispatchForTests, sendLiveApprovedCloudDraft } from "../../src/adapters/liveCloudDispatch";

const sdk = vi.hoisted(() => {
  const generateContent = vi.fn();
  const getGenerativeModel = vi.fn();
  return {
    generateContent,
    getGenerativeModel,
    useRealCloudAi: false,
    lastConfig: null as unknown,
  };
});

vi.mock("firebase/ai", async () => {
  const actual = await vi.importActual<typeof import("firebase/ai")>("firebase/ai");
  sdk.getGenerativeModel.mockImplementation((_ai: unknown, config: unknown) => {
    sdk.lastConfig = config;
    return { generateContent: sdk.generateContent };
  });
  return { ...actual, getGenerativeModel: sdk.getGenerativeModel };
});

vi.mock("../../src/config/firebase", async () => {
  const actual = await vi.importActual<typeof import("../../src/config/firebase")>("../../src/config/firebase");
  return {
    ...actual,
    getCloudFirebaseAI: () => {
      if (sdk.useRealCloudAi) {
        return actual.getCloudFirebaseAI();
      }
      return { diagnosticDouble: false };
    },
  };
});

const harness = vi.hoisted(() => ({
  runOnDeviceNoticeExtraction: () =>
    new Promise<InferenceCallRecord<RawNoticeExtraction>>(() => undefined),
  probe: () =>
    Promise.resolve({
      hasLanguageModelGlobal: true,
      availability: "available" as const,
      userAgent: "test",
      isOnline: false,
      errorDetail: null,
      checkedAtIso: "2026-11-19T00:00:00.000Z",
    }),
}));

vi.mock("../../src/ai/onDeviceExtractor", () => ({
  runOnDeviceNoticeExtraction: harness.runOnDeviceNoticeExtraction,
}));

vi.mock("../../src/ai/capability", async () => {
  const actual = await vi.importActual<typeof import("../../src/ai/capability")>("../../src/ai/capability");
  return { ...actual, probeChromeLanguageModelAvailability: harness.probe };
});

const original = normalizeNewlines(readFileSync("examples/energy-backbill-original.txt", "utf8"));
const RAW_MARKERS = ["Sarah Example", "EXAMPLE-8472", "14 Example Road", "RG0 0AA"];

function draftJson(summary: string): string {
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
  });
}

const ORIGINAL_DRAFT = draftJson("You can ask for a review of the stated balance of £1,280.");

function sdkResponse(text: string, inferenceSource: string | undefined = "in_cloud") {
  return { response: { text: () => text, inferenceSource } };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let step = 0; step < 12; step += 1) {
      await Promise.resolve();
    }
  });
}

function enableDiagnostic(): void {
  vi.stubEnv("DEV", true);
  vi.stubEnv("VITE_NOTICELENS_REAL_CLOUD_DIAGNOSTIC", "1");
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

describe("Phase 5C-5 real Firebase diagnostic gate", () => {
  const fetchSpy = vi.fn(() => Promise.reject(new Error("no firebase request")));

  beforeEach(() => {
    sdk.generateContent.mockReset();
    sdk.getGenerativeModel.mockClear();
    sdk.useRealCloudAi = false;
    sdk.lastConfig = null;
    sdk.generateContent.mockResolvedValue(sdkResponse(ORIGINAL_DRAFT));
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
    vi.useRealTimers();
  });

  it("stays off without the environment flag, including URL and localStorage", () => {
    localStorage.setItem("VITE_NOTICELENS_REAL_CLOUD_DIAGNOSTIC", "1");
    window.history.replaceState(null, "", "/?VITE_NOTICELENS_REAL_CLOUD_DIAGNOSTIC=1");
    expect(isRealCloudDiagnosticEnabled("127.0.0.1")).toBe(false);
    expect(isRealCloudDiagnosticEnabled("localhost")).toBe(false);
    localStorage.removeItem("VITE_NOTICELENS_REAL_CLOUD_DIAGNOSTIC");
  });

  it("turns on only for the exact flag on a loopback host", () => {
    enableDiagnostic();
    expect(isRealCloudDiagnosticEnabled("127.0.0.1")).toBe(true);
    expect(isRealCloudDiagnosticEnabled("localhost")).toBe(true);
    expect(isRealCloudDiagnosticEnabled("::1")).toBe(true);
    expect(isRealCloudDiagnosticEnabled("[::1]")).toBe(true);
    expect(isRealCloudDiagnosticEnabled("example.com")).toBe(false);
    vi.stubEnv("VITE_NOTICELENS_REAL_CLOUD_DIAGNOSTIC", "true");
    expect(isRealCloudDiagnosticEnabled("127.0.0.1")).toBe(false);
  });

  it("reads the opt-in only after a boolean DEV check and ignores storage", () => {
    const source = readFileSync("src/adapters/realCloudDiagnostic.ts", "utf8");
    expect(source).toContain("import.meta.env.DEV !== true");
    expect(source).toContain('import.meta.env.VITE_NOTICELENS_REAL_CLOUD_DIAGNOSTIC !== "1"');
    expect(source).not.toMatch(/localStorage\s*[.\[]/);
    expect(source).not.toContain("URLSearchParams");
    expect(source).not.toContain("location.search");
  });

  it("keeps the production switch and the old send helpers blocked", () => {
    expect(CLOUD_SUBMISSION_ENABLED).toBe(false);
    const sessionSource = readFileSync("src/adapters/cloudApprovalSession.ts", "utf8");
    expect(sessionSource).toContain("false as const");
    expect(() => requestCloudSubmission(createCloudApprovalSession({ canonical: null }))).toThrow(/not connected/i);
    expect(() =>
      requestClosedBriefSend({
        id: "m5c5-blocked",
        serialized: "{}",
        guardOptions: {},
      } as never)
    ).toThrow();
    const dispatch = readFileSync("src/adapters/liveCloudDispatch.ts", "utf8");
    const signature = dispatch.slice(
      dispatch.indexOf("export async function sendLiveApprovedCloudDraft"),
      dispatch.indexOf("const probe = import.meta.env.PROD")
    );
    expect(signature).not.toContain("payload");
    expect(signature).not.toContain("reader");
    expect(dispatch).toContain("isRealCloudDiagnosticEnabled");
  });

  it("does not send on load, modal open, navigation, or an edit when the diagnostic is on", async () => {
    enableDiagnostic();
    render(<App />);
    await flush();
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(screen.getByTestId("real-cloud-diagnostic")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review privacy approval" }));
    fireEvent.click(screen.getByRole("presentation"));
    fireEvent.click(screen.getByTestId("nav-read"));
    fireEvent.change(screen.getByTestId("notice-text"), { target: { value: `${original}\n` } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(sdk.generateContent).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 20_000);

  it("keeps Send disabled without consent and for an unsupported notice", async () => {
    enableDiagnostic();
    render(<App />);
    await flush();
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
    fireEvent.click(screen.getByTestId("cloud-send-button"));
    expect(sdk.generateContent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("nav-read"));
    fireEvent.change(screen.getByTestId("notice-text"), { target: { value: "Please pay £10 by Friday." } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    openAndApprove();
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
    expect(sdk.generateContent).not.toHaveBeenCalled();
  });

  it("sends the exact approved bytes once through the Firebase SDK entry", async () => {
    enableDiagnostic();
    render(<App />);
    await flush();
    openAndApprove();
    const exact = screen.getByTestId("exact-json").textContent ?? "";
    expect(screen.getByTestId("cloud-send-button")).toBeEnabled();
    fireEvent.click(screen.getByTestId("cloud-send-button"));
    await flush();
    expect(sdk.getGenerativeModel).toHaveBeenCalledTimes(1);
    const config = sdk.lastConfig as {
      mode?: string;
      inCloudParams?: { model?: string; generationConfig?: { responseMimeType?: string } };
    };
    expect(config.mode).toBe("only_in_cloud");
    expect(config.inCloudParams?.generationConfig?.responseMimeType).toBe("application/json");
    expect(sdk.generateContent).toHaveBeenCalledTimes(1);
    const prompt = String(sdk.generateContent.mock.calls[0]?.[0] ?? "");
    expect(prompt).toContain(exact);
    expect(prompt).toContain("USER-APPROVED REDACTED STRUCTURAL BRIEF");
    expect(prompt).toContain("If a salutation is necessary, use exactly 'Dear Sir or Madam,'.");
    expect(prompt).toContain("Do not invent any person, supplier or recipient name.");
    for (const marker of RAW_MARKERS) {
      expect(prompt).not.toContain(marker);
    }
    expect(screen.getByTestId("cloud-draft-output")).toHaveTextContent("£1,280");
    expect(screen.getByTestId("cloud-draft-output")).not.toHaveTextContent("760");
    expect(screen.getByTestId("cloud-inference-label")).toHaveTextContent("in_cloud");
    expect(screen.getByTestId("cloud-model-name")).toBeInTheDocument();
    expect(screen.getByTestId("cloud-copy-button")).toBeDisabled();
    expect(screen.getByTestId("cloud-download-button")).toBeDisabled();
    expect(activeApprovalCount()).toBe(0);
    fireEvent.click(screen.getByTestId("cloud-send-button"));
    await flush();
    expect(sdk.generateContent).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a second call while the first SDK call is still running", async () => {
    enableDiagnostic();
    render(<App />);
    await flush();
    openAndApprove();
    const gate = deferred<ReturnType<typeof sdkResponse>>();
    sdk.generateContent.mockImplementation(() => gate.promise);
    const first = sendLiveApprovedCloudDraft();
    const second = await sendLiveApprovedCloudDraft();
    expect(second).toEqual({ outcome: "in_flight" });
    expect(sdk.generateContent).toHaveBeenCalledTimes(1);
    gate.resolve(sdkResponse(ORIGINAL_DRAFT));
    const finished = await first;
    expect(finished.outcome).toBe("accepted");
    expect(activeApprovalCount()).toBe(0);
  });

  it("reports timeout without accepting a late SDK result", async () => {
    enableDiagnostic();
    render(<App />);
    await flush();
    openAndApprove();
    sdk.generateContent.mockImplementation(() => new Promise(() => undefined));
    const pending = sendLiveApprovedCloudDraft({ timeoutMs: 25 });
    await act(async () => {
      vi.advanceTimersByTime(30);
    });
    await expect(pending).resolves.toEqual({ outcome: "rejected", reason: "timeout" });
    expect(screen.queryByTestId("cloud-draft-output")).not.toBeInTheDocument();
    expect(activeApprovalCount()).toBe(0);
  });

  it("rejects a network failure and an invalid model response without an accepted draft", async () => {
    enableDiagnostic();
    render(<App />);
    await flush();
    openAndApprove();
    sdk.generateContent.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByTestId("cloud-send-button"));
    await flush();
    expect(screen.queryByTestId("cloud-draft-output")).not.toBeInTheDocument();
    expect(screen.getByTestId("cloud-draft-error")).toHaveTextContent("rejected");
    expect(screen.getByTestId("cloud-draft-error")).not.toHaveTextContent("Sarah");
    expect(activeApprovalCount()).toBe(0);
    openAndApprove();
    sdk.generateContent.mockResolvedValueOnce(sdkResponse("not json"));
    fireEvent.click(screen.getByTestId("cloud-send-button"));
    await flush();
    expect(screen.queryByTestId("cloud-draft-output")).not.toBeInTheDocument();
    expect(screen.getByTestId("cloud-draft-error")).toHaveTextContent("rejected");
    expect(screen.getByTestId("cloud-draft-violations")).toHaveTextContent("Cloud output was not valid JSON");
  });

  it("stops before a model request when App Check is not configured", async () => {
    enableDiagnostic();
    sdk.useRealCloudAi = true;
    vi.stubEnv("VITE_FIREBASE_API_KEY", "test-key");
    vi.stubEnv("VITE_FIREBASE_AUTH_DOMAIN", "test.firebaseapp.com");
    vi.stubEnv("VITE_FIREBASE_PROJECT_ID", "test-project");
    vi.stubEnv("VITE_FIREBASE_APP_ID", "1:1:web:test");
    vi.stubEnv("VITE_FIREBASE_APPCHECK_SITE_KEY", "");
    render(<App />);
    await flush();
    openAndApprove();
    fireEvent.click(screen.getByTestId("cloud-send-button"));
    await flush();
    expect(sdk.generateContent).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId("cloud-draft-output")).not.toBeInTheDocument();
    expect(screen.getByTestId("cloud-draft-error")).toHaveTextContent("rejected");
    expect(activeApprovalCount()).toBe(0);
  });

  it("does not show a late success after an edit", async () => {
    enableDiagnostic();
    render(<App />);
    await flush();
    openAndApprove();
    const gate = deferred<ReturnType<typeof sdkResponse>>();
    sdk.generateContent.mockImplementation(() => gate.promise);
    fireEvent.click(screen.getByTestId("cloud-send-button"));
    fireEvent.click(screen.getByTestId("nav-read"));
    fireEvent.change(screen.getByTestId("notice-text"), { target: { value: `${original}\n` } });
    gate.resolve(sdkResponse(ORIGINAL_DRAFT));
    await flush();
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(screen.queryByTestId("cloud-draft-output")).not.toBeInTheDocument();
    expect(screen.getByTestId("cloud-draft-error")).toBeInTheDocument();
  });

  it("leaves Send disabled when the diagnostic flag and the test probe are both absent", async () => {
    render(<App />);
    await flush();
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
    expect(screen.queryByTestId("real-cloud-diagnostic")).not.toBeInTheDocument();
    expect(screen.getByTestId("cloud-disabled")).toHaveTextContent(/Cloud sending disabled/i);
    expect(CLOUD_SUBMISSION_ENABLED).toBe(false);
  });
});

import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildClosedCloudBrief } from "../../src/adapters/buildClosedCloudBrief";
import {
  CLOUD_SUBMISSION_ENABLED,
  createCloudApprovalSession,
  requestCloudSubmission,
} from "../../src/adapters/cloudApprovalSession";
import { groundNoticeFacts } from "../../src/adapters/groundNoticeFacts";
import {
  bindLiveCloudDispatch,
  createDispatchOwner,
  dispatchLiveCloudBoundary,
  resetLiveCloudDispatchForTests,
} from "../../src/adapters/liveCloudDispatch";
import { requestClosedBriefSend, resetUserApprovalStateForTests } from "../../src/adapters/privacyApproval";
import { evaluateCloudPreflight, type LiveCloudPreflightState } from "../../src/adapters/secureCloudPreflight";
import { sourceGenerationId } from "../../src/adapters/supportedNoticeGate";
import {
  activeApprovalCount,
  approvalLifecycle,
  approvalRegistryTestIsolation,
  approvePending,
  registerApprovablePayload,
  type ApprovalBinding,
} from "../../src/domain/approvalRegistry";
import { normalizeNewlines } from "../../src/domain/textNormalize";
import type { InferenceCallRecord, RawNoticeExtraction } from "../../src/domain/types";
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
        checkedAtIso: "2026-11-18T00:00:00.000Z",
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

const TODAY = "2026-11-18";
const original = normalizeNewlines(readFileSync("examples/energy-backbill-original.txt", "utf8"));
const revised = normalizeNewlines(readFileSync("examples/energy-backbill-revised.txt", "utf8"));

function canonicalFor(text: string): string {
  const view = groundNoticeFacts({ rawNoticeText: normalizeNewlines(text), today: TODAY });
  return buildClosedCloudBrief({ view, responseGoal: "request_billing_review" }).serialized;
}

function liveFor(text: string): LiveCloudPreflightState {
  const raw = normalizeNewlines(text);
  return {
    rawNoticeText: raw,
    today: TODAY,
    presentedSourceGenerationId: sourceGenerationId(raw),
    noticeGeneration: 4,
    extractionGeneration: 0,
    identifierContextId: "ie-1",
    documentContextId: "sess-1-doc-0",
    responseGoal: "request_billing_review",
    circumstanceFlags: [],
    presentedCanonicalBytes: canonicalFor(raw),
    approvalHandle: null,
  };
}

function approve(state: LiveCloudPreflightState) {
  const binding: ApprovalBinding = {
    schema: "noticelens.cloud-brief.v2",
    canonicalBytes: state.presentedCanonicalBytes,
    noticeGeneration: state.noticeGeneration,
    identifierContextId: state.identifierContextId,
    responseGoal: "request_billing_review",
    circumstanceFlags: [],
    extractionGeneration: state.extractionGeneration,
    documentContextId: state.documentContextId,
  };
  const registered = registerApprovablePayload(binding);
  if (!registered.ok) {
    throw new Error(registered.reason);
  }
  expect(approvePending(registered.handle, binding)).toBe(true);
  return registered.handle;
}

async function boot(): Promise<void> {
  render(<App />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

function openAndApprove(): void {
  fireEvent.click(screen.getByTestId("nav-reply"));
  fireEvent.click(screen.getByRole("button", { name: "Review privacy approval" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "I have reviewed this exact payload" }));
  fireEvent.click(screen.getByTestId("privacy-approve"));
}

function setNotice(value: string): void {
  fireEvent.click(screen.getByTestId("nav-read"));
  fireEvent.change(screen.getByTestId("notice-text"), { target: { value } });
}

function expectSendStaysOff(): void {
  fireEvent.click(screen.getByTestId("nav-reply"));
  for (const button of screen.getAllByTestId("cloud-send-button")) {
    expect(button).toBeDisabled();
  }
  expect(screen.getByRole("button", { name: "Copy reply" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Download .txt" })).toBeDisabled();
  expect(CLOUD_SUBMISSION_ENABLED).toBe(false);
}

describe("Phase 5C-2 preflight input hardening", () => {
  beforeEach(() => {
    approvalRegistryTestIsolation.reset();
    resetLiveCloudDispatchForTests();
  });

  it("denies null, a non-object, and a throwing getter without throwing", () => {
    expect(() => evaluateCloudPreflight(null as never)).not.toThrow();
    expect(evaluateCloudPreflight(null as never).state).toBe("SOURCE_NOT_ELIGIBLE");
    expect(evaluateCloudPreflight(undefined as never).authorisesSend).toBe(false);
    const bomb: Record<string, unknown> = {};
    Object.defineProperty(bomb, "rawNoticeText", {
      get() {
        throw new Error("getter");
      },
    });
    expect(() => evaluateCloudPreflight(bomb as never)).not.toThrow();
    expect(evaluateCloudPreflight(bomb as never).state).not.toBe("PREFLIGHT_READY");
  });

  it("reads each live field once, so a later getter value cannot replace the notice", () => {
    const state = liveFor(original);
    const handle = approve(state);
    let reads = 0;
    const live = { ...state, approvalHandle: handle };
    Object.defineProperty(live, "rawNoticeText", {
      configurable: true,
      get() {
        reads += 1;
        if (reads > 1) {
          throw new Error("second read");
        }
        return original;
      },
    });
    const decision = evaluateCloudPreflight(live);
    expect(decision).toEqual({ state: "PREFLIGHT_READY", authorisesSend: false, consumed: true });
    expect(reads).toBe(1);
    expect(approvalLifecycle(handle)).toBe("CONSUMED");
  });

  it("rejects a malformed exponent and duplicate keys without consuming the approval", () => {
    const state = liveFor(original);
    const handle = approve(state);
    const exponent = evaluateCloudPreflight({
      ...state,
      approvalHandle: handle,
      presentedCanonicalBytes: state.presentedCanonicalBytes.replace("1280", "1e+"),
    });
    expect(exponent.state).toBe("PAYLOAD_NONCANONICAL");
    expect(exponent.consumed).toBe(false);
    expect(approvalLifecycle(handle)).toBe("APPROVED");
    const duplicate = evaluateCloudPreflight({
      ...state,
      approvalHandle: handle,
      presentedCanonicalBytes: state.presentedCanonicalBytes.replace(
        '"schemaVersion":"noticelens.cloud-brief.v2"',
        '"schemaVersion":"noticelens.cloud-brief.v1","schemaVersion":"noticelens.cloud-brief.v2"'
      ),
    });
    expect(duplicate.state).toBe("PAYLOAD_NONCANONICAL");
    expect(approvalLifecycle(handle)).toBe("APPROVED");
    const source = readFileSync("src/adapters/secureCloudPreflight.ts", "utf8");
    const scanner = source.slice(source.indexOf("duplicateKeys = jsonHasDuplicateKeys"));
    expect(scanner.slice(0, 160)).toContain('return decide("PAYLOAD_NONCANONICAL")');
    expect(scanner.slice(0, 160)).not.toContain("duplicateKeys = false");
  });

  it("keeps an in-flight dispatch from consuming a second time", () => {
    let innerState = "";
    const release = bindLiveCloudDispatch(createDispatchOwner(), () => {
      const inner = dispatchLiveCloudBoundary();
      innerState = inner.state;
      expect(inner.consumed).toBe(false);
      expect(inner.canonicalBytes).toBeNull();
      return null;
    });
    const outer = dispatchLiveCloudBoundary();
    expect(innerState).toBe("DISPATCH_IN_FLIGHT");
    expect(outer.state).toBe("DISPATCH_DENIED");
    expect(outer.authorisesSend).toBe(false);
    release();
    expect(dispatchLiveCloudBoundary().state).toBe("DISPATCH_DENIED");
  });
});

describe("Phase 5C-2 live dispatch in the app", () => {
  beforeEach(() => {
    harness.pending.length = 0;
    resetUserApprovalStateForTests();
    resetLiveCloudDispatchForTests();
    vi.stubGlobal("fetch", () => Promise.reject(new Error("cloud submission is disabled")));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    cleanup();
    resetLiveCloudDispatchForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("dispatches the original fixture once and keeps every send control disabled", async () => {
    await boot();
    openAndApprove();
    const shown = (screen.getByTestId("exact-json").textContent ?? "").trim();
    const first = dispatchLiveCloudBoundary();
    const second = dispatchLiveCloudBoundary();
    expect(first.state).toBe("PREFLIGHT_READY");
    expect(first.authorisesSend).toBe(false);
    expect(first.consumed).toBe(true);
    expect(first.canonicalBytes).toBe(shown);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.canonicalBytes).not.toContain("EXAMPLE-8472");
    expect(first.canonicalBytes).not.toContain("Sarah");
    expect(second.state).not.toBe("PREFLIGHT_READY");
    expect(second.canonicalBytes).toBeNull();
    expect(second.consumed).toBe(false);
    expectSendStaysOff();
    expect(activeApprovalCount()).toBe(0);
    expect(() => requestCloudSubmission(createCloudApprovalSession({ canonical: null }))).toThrow(/not connected/i);
    expect(() => requestClosedBriefSend({ id: "m5c2", serialized: "{", guardOptions: {}, identifierContext: "", generation: 0 } as never)).toThrow();
  });

  it("dispatches the revised fixture from the live notice and denies an arbitrary notice", async () => {
    await boot();
    setNotice(revised);
    await advance(300);
    openAndApprove();
    const shown = (screen.getByTestId("exact-json").textContent ?? "").trim();
    const ready = dispatchLiveCloudBoundary();
    expect(ready.state).toBe("PREFLIGHT_READY");
    expect(ready.canonicalBytes).toBe(shown);
    expect(ready.authorisesSend).toBe(false);
    cleanup();
    resetUserApprovalStateForTests();
    await boot();
    setNotice("Please pay the outstanding balance of £10 by Friday.");
    await advance(300);
    const denied = dispatchLiveCloudBoundary();
    expect(denied.state).not.toBe("PREFLIGHT_READY");
    expect(denied.authorisesSend).toBe(false);
    expect(denied.canonicalBytes).toBeNull();
    expectSendStaysOff();
  });

  it("invalidates an edit immediately, including a restore of the same fixture", async () => {
    await boot();
    openAndApprove();
    const approvedBytes = (screen.getByTestId("exact-json").textContent ?? "").trim();
    setNotice(`${original.slice(0, -1)}x`);
    const edited = dispatchLiveCloudBoundary();
    expect(edited.state).not.toBe("PREFLIGHT_READY");
    expect(edited.consumed).toBe(false);
    expect(edited.canonicalBytes).toBeNull();
    expect(edited.canonicalBytes).not.toBe(approvedBytes);
    setNotice(original);
    await advance(300);
    const restored = dispatchLiveCloudBoundary();
    expect(restored.state).not.toBe("PREFLIGHT_READY");
    expect(activeApprovalCount()).toBe(0);
    expectSendStaysOff();
  });

  it("drops the approval when the goal or a circumstance flag changes", async () => {
    await boot();
    openAndApprove();
    fireEvent.click(screen.getByTestId("nav-plan"));
    fireEvent.change(screen.getByLabelText("What you want the reply to ask"), {
      target: { value: "confirm_payment_plan_options" },
    });
    const goal = dispatchLiveCloudBoundary();
    expect(goal.state).toBe("UNSUPPORTED_GOAL_OR_FLAGS");
    expect(goal.consumed).toBe(false);
    expectSendStaysOff();
    cleanup();
    resetUserApprovalStateForTests();
    await boot();
    openAndApprove();
    fireEvent.click(screen.getByTestId("nav-plan"));
    fireEvent.click(screen.getByRole("checkbox", { name: "The usage period may be longer than 12 months" }));
    const flag = dispatchLiveCloudBoundary();
    expect(flag.state).toBe("UNSUPPORTED_GOAL_OR_FLAGS");
    expect(flag.canonicalBytes).toBeNull();
    expectSendStaysOff();
  });

  it("does not let a stale on-device result restore a dispatch", async () => {
    await boot();
    openAndApprove();
    fireEvent.click(screen.getByTestId("nav-read"));
    fireEvent.click(screen.getByTestId("read-on-device"));
    const stale = harness.pending[0];
    expect(stale).toBeDefined();
    setNotice(`${original} `);
    await act(async () => {
      stale?.resolve({
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
      await Promise.resolve();
    });
    const decision = dispatchLiveCloudBoundary();
    expect(decision.state).not.toBe("PREFLIGHT_READY");
    expect(decision.consumed).toBe(false);
    expectSendStaysOff();
  });

  it("gives a second document with the same fixture text its own approval", async () => {
    await boot();
    openAndApprove();
    expect(activeApprovalCount()).toBe(1);
    cleanup();
    await boot();
    const carried = dispatchLiveCloudBoundary();
    expect(carried.state).not.toBe("PREFLIGHT_READY");
    expect(activeApprovalCount()).toBe(0);
    openAndApprove();
    expect(activeApprovalCount()).toBe(1);
    const first = dispatchLiveCloudBoundary();
    const second = dispatchLiveCloudBoundary();
    expect(first.state).toBe("PREFLIGHT_READY");
    expect(first.authorisesSend).toBe(false);
    expect(second.state).not.toBe("PREFLIGHT_READY");
    expect(activeApprovalCount()).toBe(0);
    expectSendStaysOff();
  });

  it("denies a pending handle and does not restore a consumed approval", () => {
    const state = liveFor(original);
    const binding: ApprovalBinding = {
      schema: "noticelens.cloud-brief.v2",
      canonicalBytes: state.presentedCanonicalBytes,
      noticeGeneration: state.noticeGeneration,
      identifierContextId: state.identifierContextId,
      responseGoal: "request_billing_review",
      circumstanceFlags: [],
      extractionGeneration: state.extractionGeneration,
      documentContextId: state.documentContextId,
    };
    const registered = registerApprovablePayload(binding);
    if (!registered.ok) {
      throw new Error(registered.reason);
    }
    const release = bindLiveCloudDispatch(createDispatchOwner(), () => ({ ...state, approvalHandle: registered.handle }));
    const pending = dispatchLiveCloudBoundary();
    expect(pending.state).toBe("APPROVAL_MISSING");
    expect(pending.consumed).toBe(false);
    expect(pending.canonicalBytes).toBeNull();
    expect(approvalLifecycle(registered.handle)).toBe("PENDING_APPROVAL");
    expect(approvePending(registered.handle, binding)).toBe(true);
    const ready = dispatchLiveCloudBoundary();
    expect(ready.state).toBe("PREFLIGHT_READY");
    expect(ready.canonicalBytes).toBe(state.presentedCanonicalBytes);
    expect(ready.authorisesSend).toBe(false);
    const reused = dispatchLiveCloudBoundary();
    expect(reused.state).toBe("APPROVAL_ALREADY_CONSUMED");
    expect(reused.consumed).toBe(false);
    expect(approvalLifecycle(registered.handle)).toBe("CONSUMED");
    release();
  });

  it("drops the approval when the identifier epoch or the same-text document changes", async () => {
    await boot();
    openAndApprove();
    setNotice(`${original}\nKeeper token JONES-1001`);
    const duringEdit = dispatchLiveCloudBoundary();
    expect(duringEdit.state).not.toBe("PREFLIGHT_READY");
    expect(duringEdit.canonicalBytes).toBeNull();
    await advance(300);
    setNotice(original);
    await advance(300);
    const restored = dispatchLiveCloudBoundary();
    expect(restored.state).not.toBe("PREFLIGHT_READY");
    expect(activeApprovalCount()).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Load synthetic energy sample" }));
    const reloaded = dispatchLiveCloudBoundary();
    expect(reloaded.state).not.toBe("PREFLIGHT_READY");
    expect(reloaded.consumed).toBe(false);
    expectSendStaysOff();
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();
  });

  it("drops the approval when the revised document or a current extraction changes generation", async () => {
    await boot();
    openAndApprove();
    fireEvent.click(screen.getByTestId("nav-compare"));
    fireEvent.change(screen.getByTestId("revised-text"), { target: { value: `${revised}\n` } });
    const revisedChange = dispatchLiveCloudBoundary();
    expect(revisedChange.state).not.toBe("PREFLIGHT_READY");
    expect(revisedChange.consumed).toBe(false);
    fireEvent.change(screen.getByTestId("revised-text"), { target: { value: revised } });
    await advance(300);
    const revisedRestored = dispatchLiveCloudBoundary();
    expect(revisedRestored.state).not.toBe("PREFLIGHT_READY");
    expect(activeApprovalCount()).toBe(0);
    cleanup();
    resetUserApprovalStateForTests();
    await boot();
    openAndApprove();
    fireEvent.click(screen.getByTestId("nav-read"));
    fireEvent.click(screen.getByTestId("read-on-device"));
    const current = harness.pending[0];
    expect(current).toBeDefined();
    await act(async () => {
      current?.resolve({
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
      await Promise.resolve();
    });
    const afterExtraction = dispatchLiveCloudBoundary();
    expect(afterExtraction.state).not.toBe("PREFLIGHT_READY");
    expect(afterExtraction.canonicalBytes).toBeNull();
    expect(activeApprovalCount()).toBe(0);
    expectSendStaysOff();
  });

  it("does not call the network and does not expose a dispatch control", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("cloud submission is disabled")));
    vi.stubGlobal("fetch", fetchSpy);
    await boot();
    openAndApprove();
    dispatchLiveCloudBoundary();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId("cloud-dispatch")).not.toBeInTheDocument();
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
    const appSource = readFileSync("src/ui/production/NoticeLensApp.tsx", "utf8");
    const dispatchSource = readFileSync("src/adapters/liveCloudDispatch.ts", "utf8");
    expect(appSource).not.toContain("onClick={dispatchLiveCloudBoundary}");
    expect(dispatchSource).not.toContain("fetch(");
    expect(dispatchSource).not.toContain("sendBeacon");
    expect(dispatchSource).not.toContain("WebSocket");
    expect(dispatchSource).not.toContain("httpsCallable");
    expect(dispatchSource).not.toContain("getGenerativeModel");
    expect(dispatchLiveCloudBoundary.length).toBe(0);
  });
});

import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as closedBriefBuilder from "../../src/adapters/buildClosedCloudBrief";
import { buildClosedCloudBrief } from "../../src/adapters/buildClosedCloudBrief";
import { CLOUD_SUBMISSION_ENABLED } from "../../src/adapters/cloudApprovalSession";
import { groundNoticeFacts } from "../../src/adapters/groundNoticeFacts";
import {
  bindLiveCloudDispatch,
  createDispatchOwner,
  deferredDispatchForTests,
  dispatchLiveCloudBoundary,
  isDispatchOwner,
  resetLiveCloudDispatchForTests,
} from "../../src/adapters/liveCloudDispatch";
import { recordClosedBriefApproval, resetUserApprovalStateForTests } from "../../src/adapters/privacyApproval";
import type { LiveCloudPreflightState } from "../../src/adapters/secureCloudPreflight";
import { sourceGenerationId } from "../../src/adapters/supportedNoticeGate";
import {
  activeApprovalCount,
  approvalLifecycle,
  approvalRegistryTestIsolation,
  approvePending,
  attachDispatchOwner,
  invalidateApprovalsForOwner,
  openPrivacyReview,
  closePrivacyReview,
  registerApprovablePayload,
  type ApprovalBinding,
} from "../../src/domain/approvalRegistry";
import { normalizeNewlines } from "../../src/domain/textNormalize";
import type { InferenceCallRecord, RawNoticeExtraction } from "../../src/domain/types";
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

const TODAY = "2026-11-18";
const original = normalizeNewlines(readFileSync("examples/energy-backbill-original.txt", "utf8"));

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

function bindingFor(state: LiveCloudPreflightState): ApprovalBinding {
  return {
    schema: "noticelens.cloud-brief.v2",
    canonicalBytes: state.presentedCanonicalBytes,
    noticeGeneration: state.noticeGeneration,
    identifierContextId: state.identifierContextId,
    responseGoal: "request_billing_review",
    circumstanceFlags: [],
    extractionGeneration: state.extractionGeneration,
    documentContextId: state.documentContextId,
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function boot(ui: ReactElement = <App />, container?: HTMLElement): Promise<void> {
  render(ui, container ? { container } : undefined);
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

function openAndApprove(root: ParentNode = document.body): void {
  const view = within(root as HTMLElement);
  fireEvent.click(view.getByTestId("nav-reply"));
  fireEvent.click(view.getByRole("button", { name: "Review privacy approval" }));
  fireEvent.click(view.getByRole("checkbox", { name: "I have reviewed this exact payload" }));
  fireEvent.click(view.getByTestId("privacy-approve"));
}

describe("Phase 5C-3 dispatch ownership", () => {
  beforeEach(() => {
    approvalRegistryTestIsolation.reset();
    approvalRegistryTestIsolation.useDefaultPrivacyReview();
    resetLiveCloudDispatchForTests();
  });

  afterEach(() => {
    approvalRegistryTestIsolation.useDefaultPrivacyReview();
    resetLiveCloudDispatchForTests();
  });

  it("keeps one owner across a rebind and ignores a stale cleanup", () => {
    const owner = createDispatchOwner();
    let seen = "";
    const stale = bindLiveCloudDispatch(owner, () => {
      seen = "old";
      return null;
    });
    const current = bindLiveCloudDispatch(owner, () => {
      seen = "new";
      return null;
    });
    stale();
    expect(dispatchLiveCloudBoundary().state).toBe("DISPATCH_DENIED");
    expect(seen).toBe("new");
    current();
    seen = "";
    dispatchLiveCloudBoundary();
    expect(seen).toBe("");
  });

  it("fails closed while two owners are bound and does not let a forged owner replace the reader", () => {
    const appOwner = createDispatchOwner();
    const forged = createDispatchOwner();
    let seen = "";
    const releaseApp = bindLiveCloudDispatch(appOwner, () => {
      seen = "app";
      return null;
    });
    const releaseForged = bindLiveCloudDispatch(forged, () => {
      seen = "forged";
      return null;
    });
    expect(dispatchLiveCloudBoundary().state).toBe("DISPATCH_DENIED");
    expect(seen).toBe("");
    releaseForged();
    dispatchLiveCloudBoundary();
    expect(seen).toBe("app");
    releaseApp();
    expect(isDispatchOwner({ kind: "noticelens.dispatch-owner" })).toBe(false);
    let forgedCalled = false;
    bindLiveCloudDispatch({ kind: "noticelens.dispatch-owner" } as never, () => {
      forgedCalled = true;
      return null;
    });
    dispatchLiveCloudBoundary();
    expect(forgedCalled).toBe(false);
  });

  it("denies a throwing reader and a malformed snapshot without logging the notice", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const owner = createDispatchOwner();
    const state = liveFor(original);
    const binding = bindingFor(state);
    const review = openPrivacyReview();
    approvalRegistryTestIsolation.setPrivacyReviewRequired(true);
    const registered = registerApprovablePayload(binding, review);
    if (!registered.ok) {
      throw new Error(registered.reason);
    }
    expect(approvePending(registered.handle, binding, review)).toBe(true);
    closePrivacyReview(review);
    const release = bindLiveCloudDispatch(owner, () => {
      throw new Error(original);
    });
    const thrown = dispatchLiveCloudBoundary();
    expect(thrown.state).toBe("DISPATCH_DENIED");
    expect(thrown.canonicalBytes).toBeNull();
    expect(approvalLifecycle(registered.handle)).toBe("APPROVED");
    expect(error).not.toHaveBeenCalled();
    release();
    bindLiveCloudDispatch(owner, () => {
      const live = { ...state, approvalHandle: registered.handle };
      Object.defineProperty(live, "rawNoticeText", {
        get() {
          throw new Error(original);
        },
      });
      return live;
    });
    const malformed = dispatchLiveCloudBoundary();
    expect(malformed.state).toBe("DISPATCH_DENIED");
    expect(approvalLifecycle(registered.handle)).toBe("APPROVED");
    expect(warn).not.toHaveBeenCalled();
    error.mockRestore();
    warn.mockRestore();
  });

  it("denies a canonical builder exception and does not consume the approval", () => {
    const state = liveFor(original);
    const binding = bindingFor(state);
    const registered = registerApprovablePayload(binding);
    if (!registered.ok) {
      throw new Error(registered.reason);
    }
    expect(approvePending(registered.handle, binding)).toBe(true);
    const owner = createDispatchOwner();
    bindLiveCloudDispatch(owner, () => ({ ...state, approvalHandle: registered.handle }));
    const realBuild = closedBriefBuilder.buildClosedCloudBrief;
    let builds = 0;
    const spy = vi.spyOn(closedBriefBuilder, "buildClosedCloudBrief").mockImplementation((input) => {
      builds += 1;
      if (builds > 1) {
        throw new Error("builder failed");
      }
      return realBuild(input);
    });
    const decision = dispatchLiveCloudBoundary();
    spy.mockRestore();
    expect(decision.state).toBe("DISPATCH_DENIED");
    expect(decision.authorisesSend).toBe(false);
    expect(approvalLifecycle(registered.handle)).toBe("APPROVED");
  });

  it("refuses approval outside the privacy review and invalidates only that owner's pending handle", () => {
    approvalRegistryTestIsolation.setPrivacyReviewRequired(true);
    const state = liveFor(original);
    const binding = bindingFor(state);
    const outside = registerApprovablePayload(binding);
    expect(outside.ok).toBe(false);
    expect(() => recordClosedBriefApproval(state.presentedCanonicalBytes, state.presentedCanonicalBytes, 4, {})).toThrow();
    const review = openPrivacyReview();
    const registered = registerApprovablePayload(binding, review);
    if (!registered.ok) {
      throw new Error(registered.reason);
    }
    const owner = createDispatchOwner();
    const other = createDispatchOwner();
    attachDispatchOwner(registered.handle, owner);
    closePrivacyReview(review);
    expect(approvePending(registered.handle, binding, review)).toBe(false);
    expect(approvalLifecycle(registered.handle)).toBe("PENDING_APPROVAL");
    const otherState = { ...state, documentContextId: "sess-2-doc-0", noticeGeneration: 9 };
    const otherBinding = bindingFor(otherState);
    approvalRegistryTestIsolation.useDefaultPrivacyReview();
    const otherRegistered = registerApprovablePayload(otherBinding);
    if (!otherRegistered.ok) {
      throw new Error(otherRegistered.reason);
    }
    expect(approvePending(otherRegistered.handle, otherBinding)).toBe(true);
    attachDispatchOwner(otherRegistered.handle, other);
    invalidateApprovalsForOwner(owner);
    expect(approvalLifecycle(registered.handle)).toBe("INVALIDATED");
    expect(approvalLifecycle(otherRegistered.handle)).toBe("APPROVED");
    expect(approvePending(registered.handle, binding)).toBe(false);
  });

  it("holds the lock for a deferred signal and does not restore a consumed approval", async () => {
    const state = liveFor(original);
    const binding = bindingFor(state);
    const registered = registerApprovablePayload(binding);
    if (!registered.ok) {
      throw new Error(registered.reason);
    }
    expect(approvePending(registered.handle, binding)).toBe(true);
    const owner = createDispatchOwner();
    bindLiveCloudDispatch(owner, () => ({ ...state, approvalHandle: registered.handle }));
    const gate = deferred();
    const pending = deferredDispatchForTests(gate.promise);
    const second = dispatchLiveCloudBoundary();
    expect(second.state).toBe("DISPATCH_IN_FLIGHT");
    expect(second.consumed).toBe(false);
    expect(second.canonicalBytes).toBeNull();
    gate.reject(new Error("cancelled"));
    const decision = await pending;
    expect(decision.state).toBe("PREFLIGHT_READY");
    expect(decision.authorisesSend).toBe(false);
    expect(decision.canonicalBytes).toBe(state.presentedCanonicalBytes);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(approvalLifecycle(registered.handle)).toBe("CONSUMED");
    const replay = dispatchLiveCloudBoundary();
    expect(replay.state).toBe("APPROVAL_ALREADY_CONSUMED");
    expect(replay.canonicalBytes).toBeNull();
    const source = readFileSync("src/adapters/liveCloudDispatch.ts", "utf8");
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("gate(");
    expect(source).not.toContain("sendBeacon");
    expect(source).not.toContain("WebSocket");
    expect(source).not.toContain("httpsCallable");
  });
});

describe("Phase 5C-3 app lifecycle", () => {
  beforeEach(() => {
    harness.pending.length = 0;
    resetUserApprovalStateForTests();
    resetLiveCloudDispatchForTests();
    approvalRegistryTestIsolation.useDefaultPrivacyReview();
    vi.stubGlobal("fetch", () => Promise.reject(new Error("cloud submission is disabled")));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    cleanup();
    approvalRegistryTestIsolation.useDefaultPrivacyReview();
    resetLiveCloudDispatchForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("dispatches the first mount once and keeps send disabled", async () => {
    await boot();
    openAndApprove();
    const shown = (screen.getByTestId("exact-json").textContent ?? "").trim();
    const first = dispatchLiveCloudBoundary();
    const second = dispatchLiveCloudBoundary();
    expect(first.state).toBe("PREFLIGHT_READY");
    expect(first.canonicalBytes).toBe(shown);
    expect(first.authorisesSend).toBe(false);
    expect(second.state).not.toBe("PREFLIGHT_READY");
    expect(CLOUD_SUBMISSION_ENABLED).toBe(false);
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
  });

  it("invalidates on unmount, including a strict remount, and does not reuse the old approval", async () => {
    const first = render(
      <StrictMode>
        <App />
      </StrictMode>
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    openAndApprove();
    expect(activeApprovalCount()).toBe(1);
    first.unmount();
    expect(activeApprovalCount()).toBe(0);
    await boot(
      <StrictMode>
        <App />
      </StrictMode>
    );
    expect(dispatchLiveCloudBoundary().state).not.toBe("PREFLIGHT_READY");
    openAndApprove();
    expect(dispatchLiveCloudBoundary().state).toBe("PREFLIGHT_READY");
    expect(dispatchLiveCloudBoundary().state).not.toBe("PREFLIGHT_READY");
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
  });

  it("does not let a second mounted app share or steal the first approval", async () => {
    const hostA = document.createElement("div");
    const hostB = document.createElement("div");
    document.body.append(hostA, hostB);
    render(<App />, { container: hostA });
    render(<App />, { container: hostB });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    openAndApprove(hostA);
    openAndApprove(hostB);
    expect(activeApprovalCount()).toBe(2);
    const ambiguous = dispatchLiveCloudBoundary();
    expect(ambiguous.state).toBe("DISPATCH_DENIED");
    expect(ambiguous.consumed).toBe(false);
    expect(activeApprovalCount()).toBe(2);
    cleanup();
    hostA.remove();
    hostB.remove();
  });

  it("invalidates the unmounted app and leaves the newer app able to dispatch once", async () => {
    const hostA = document.createElement("div");
    const hostB = document.createElement("div");
    document.body.append(hostA, hostB);
    const first = render(<App />, { container: hostA });
    render(<App />, { container: hostB });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    openAndApprove(hostA);
    openAndApprove(hostB);
    first.unmount();
    hostA.remove();
    expect(activeApprovalCount()).toBe(1);
    const ready = dispatchLiveCloudBoundary();
    const again = dispatchLiveCloudBoundary();
    expect(ready.state).toBe("PREFLIGHT_READY");
    expect(ready.authorisesSend).toBe(false);
    expect(again.state).not.toBe("PREFLIGHT_READY");
    expect(activeApprovalCount()).toBe(0);
    expect(within(hostB).getByTestId("cloud-send-button")).toBeDisabled();
    cleanup();
    hostB.remove();
  });

  it("drops an edit immediately and does not let a stale on-device result dispatch", async () => {
    await boot();
    openAndApprove();
    fireEvent.click(screen.getByTestId("nav-read"));
    fireEvent.change(screen.getByTestId("notice-text"), { target: { value: `${original.slice(0, -1)}x` } });
    expect(dispatchLiveCloudBoundary().state).not.toBe("PREFLIGHT_READY");
    fireEvent.change(screen.getByTestId("notice-text"), { target: { value: original } });
    await advance(300);
    expect(dispatchLiveCloudBoundary().state).not.toBe("PREFLIGHT_READY");
    expect(activeApprovalCount()).toBe(0);
    openAndApprove();
    fireEvent.click(screen.getByTestId("nav-read"));
    fireEvent.click(screen.getByTestId("read-on-device"));
    const stale = harness.pending[0];
    fireEvent.change(screen.getByTestId("notice-text"), { target: { value: `${original} ` } });
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
    expect(dispatchLiveCloudBoundary().state).not.toBe("PREFLIGHT_READY");
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
  });

  it("keeps a started request frozen across an edit and does not replay it", async () => {
    await boot();
    openAndApprove();
    const shown = (screen.getByTestId("exact-json").textContent ?? "").trim();
    const gate = deferred();
    const started = deferredDispatchForTests(gate.promise);
    const during = dispatchLiveCloudBoundary();
    expect(during.state).toBe("DISPATCH_IN_FLIGHT");
    fireEvent.click(screen.getByTestId("nav-read"));
    fireEvent.change(screen.getByTestId("notice-text"), { target: { value: `${original} note` } });
    gate.resolve();
    const decision = await started;
    expect(decision.canonicalBytes).toBe(shown);
    expect(decision.authorisesSend).toBe(false);
    const replay = dispatchLiveCloudBoundary();
    expect(replay.state).not.toBe("PREFLIGHT_READY");
    expect(replay.canonicalBytes).toBeNull();
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
  });

  it("releases the lock after cancellation or success and does not restore consent", async () => {
    await boot();
    openAndApprove();
    const cancelGate = deferred();
    const cancelled = deferredDispatchForTests(cancelGate.promise);
    cancelGate.reject(new Error("timeout"));
    const cancelDecision = await cancelled;
    expect(cancelDecision.consumed).toBe(true);
    expect(cancelDecision.authorisesSend).toBe(false);
    expect(dispatchLiveCloudBoundary().state).not.toBe("PREFLIGHT_READY");
    cleanup();
    resetUserApprovalStateForTests();
    await boot();
    openAndApprove();
    const successGate = deferred();
    const succeeded = deferredDispatchForTests(successGate.promise);
    expect(dispatchLiveCloudBoundary().state).toBe("DISPATCH_IN_FLIGHT");
    successGate.resolve();
    const success = await succeeded;
    expect(success.state).toBe("PREFLIGHT_READY");
    expect(success.authorisesSend).toBe(false);
    expect(dispatchLiveCloudBoundary().state).toBe("APPROVAL_ALREADY_CONSUMED");
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
  });

  it("keeps the lock when the app unmounts during a pending request", async () => {
    await boot();
    openAndApprove();
    const gate = deferred();
    const pending = deferredDispatchForTests(gate.promise);
    cleanup();
    expect(dispatchLiveCloudBoundary().state).toBe("DISPATCH_IN_FLIGHT");
    gate.resolve();
    const decision = await pending;
    expect(decision.consumed).toBe(true);
    expect(decision.authorisesSend).toBe(false);
    await boot();
    expect(dispatchLiveCloudBoundary().state).not.toBe("PREFLIGHT_READY");
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
  });

  it("still requires the privacy review when the production gate is on", async () => {
    approvalRegistryTestIsolation.setPrivacyReviewRequired(true);
    const outside = registerApprovablePayload({} as ApprovalBinding);
    expect(outside.ok).toBe(false);
    await boot();
    openAndApprove();
    const decision = dispatchLiveCloudBoundary();
    expect(decision.state).toBe("PREFLIGHT_READY");
    expect(decision.authorisesSend).toBe(false);
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
  });
});

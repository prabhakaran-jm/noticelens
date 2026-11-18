import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildClosedCloudBrief } from "../../src/adapters/buildClosedCloudBrief";
import {
  CLOUD_SUBMISSION_ENABLED,
  createCloudApprovalSession,
  requestCloudSubmission,
} from "../../src/adapters/cloudApprovalSession";
import { groundNoticeFacts } from "../../src/adapters/groundNoticeFacts";
import { requestClosedBriefSend } from "../../src/adapters/privacyApproval";
import {
  evaluateCloudPreflight,
  type CloudPreflightDecision,
  type LiveCloudPreflightState,
} from "../../src/adapters/secureCloudPreflight";
import { assessSupportedNotice, sourceGenerationId } from "../../src/adapters/supportedNoticeGate";
import {
  approvalLifecycle,
  approvalRegistryTestIsolation,
  approvePending,
  invalidateActiveApprovals,
  registerApprovablePayload,
  revokeApproval,
  type ApprovalBinding,
} from "../../src/domain/approvalRegistry";
import { normalizeNewlines } from "../../src/domain/textNormalize";
import { BENCHMARK_NOTICE_FIXTURES } from "../../src/fixtures/benchmarkNotices";

const TODAY = "2026-11-18";
const original = normalizeNewlines(readFileSync("examples/energy-backbill-original.txt", "utf8"));
const revised = normalizeNewlines(readFileSync("examples/energy-backbill-revised.txt", "utf8"));

function canonicalFor(text: string): string {
  const raw = normalizeNewlines(text);
  const view = groundNoticeFacts({ rawNoticeText: raw, today: TODAY });
  return buildClosedCloudBrief({ view, responseGoal: "request_billing_review" }).serialized;
}

function liveFor(
  text: string,
  patch: Partial<LiveCloudPreflightState> = {}
): LiveCloudPreflightState {
  const raw = normalizeNewlines(text);
  let presentedCanonicalBytes = "";
  try {
    presentedCanonicalBytes = canonicalFor(raw);
  } catch {
    presentedCanonicalBytes = "";
  }
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
    presentedCanonicalBytes,
    approvalHandle: null,
    ...patch,
  };
}

function approve(state: LiveCloudPreflightState, canonicalBytes = state.presentedCanonicalBytes) {
  const binding: ApprovalBinding = {
    schema: "noticelens.cloud-brief.v2",
    canonicalBytes,
    noticeGeneration: state.noticeGeneration,
    identifierContextId: state.identifierContextId,
    responseGoal: "request_billing_review",
    circumstanceFlags: [],
    extractionGeneration: state.extractionGeneration,
    documentContextId: state.documentContextId,
  };
  const registered = registerApprovablePayload(binding);
  expect(registered.ok).toBe(true);
  if (!registered.ok) {
    throw new Error(registered.reason);
  }
  expect(approvePending(registered.handle, binding)).toBe(true);
  return registered.handle;
}

function ready(text: string, patch: Partial<LiveCloudPreflightState> = {}) {
  const state = liveFor(text, patch);
  const handle = approve(state);
  return evaluateCloudPreflight({ ...state, approvalHandle: handle });
}

function rewrite(serialized: string, mutate: (payload: Record<string, unknown>) => void): string {
  const payload = JSON.parse(serialized) as Record<string, unknown>;
  mutate(payload);
  return JSON.stringify(payload);
}

function expectClosed(decision: CloudPreflightDecision): void {
  expect(decision.state).not.toBe("PREFLIGHT_READY");
  expect(decision.authorisesSend).toBe(false);
  expect(decision.consumed).toBe(false);
  expect(JSON.stringify(decision)).not.toContain("EXAMPLE-8472");
  expect(JSON.stringify(decision)).not.toContain("Sarah");
}

describe("Phase 5C-1 secure cloud preflight", () => {
  beforeEach(() => {
    approvalRegistryTestIsolation.reset();
  });

  it.each([
    ["original fixture", () => original, "ie-1", "sess-1-doc-0", 1, 0],
    ["revised fixture", () => revised, "ie-1", "sess-1-doc-0", 1, 0],
    ["original with CRLF", () => original.replace(/\n/g, "\r\n"), "ie-2", "sess-2-doc-1", 2, 0],
    ["revised with a later edit generation", () => revised, "ie-3", "sess-3-doc-2", 7, 0],
    ["original at generation zero", () => original, "ie-4", "sess-4-doc-0", 0, 0],
    ["original after an on-device generation", () => original, "ie-5", "sess-5-doc-1", 3, 2],
    ["revised with an identifier-context id", () => revised, "idctx-4", "sess-6-doc-0", 4, 0],
    ["original with a legacy document id", () => original, "ie-8", "legacy-doc-9", 5, 1],
    ["revised at a high generation", () => revised, "ie-9", "sess-9-doc-8", 40, 3],
    ["original in a second session", () => original, "ie-10", "sess-10-doc-4", 6, 0],
  ] as const)("accepts a controlled preflight for %s", (_label, text, identifier, document, noticeGeneration, extractionGeneration) => {
    const decision = ready(text(), {
      identifierContextId: identifier,
      documentContextId: document,
      noticeGeneration,
      extractionGeneration,
    });
    expect(decision).toEqual({
      state: "PREFLIGHT_READY",
      authorisesSend: false,
      consumed: true,
    });
    expect(JSON.stringify(decision)).not.toContain("EXAMPLE-8472");
    expect(JSON.stringify(decision)).not.toContain("Sarah");
    expect(JSON.stringify(decision)).not.toContain("£");
  });

  it("keeps the two fixture generations distinct and consumes each approval once", () => {
    const originalState = liveFor(original, { documentContextId: "sess-1-doc-0", noticeGeneration: 1 });
    const revisedState = liveFor(revised, { documentContextId: "sess-1-doc-1", noticeGeneration: 2 });
    expect(originalState.presentedSourceGenerationId).not.toBe(revisedState.presentedSourceGenerationId);
    const originalHandle = approve(originalState);
    const revisedHandle = approve(revisedState);
    expect(evaluateCloudPreflight({ ...originalState, approvalHandle: originalHandle }).state).toBe("PREFLIGHT_READY");
    expect(evaluateCloudPreflight({ ...revisedState, approvalHandle: revisedHandle }).state).toBe("PREFLIGHT_READY");
    expect(approvalLifecycle(originalHandle)).toBe("CONSUMED");
    expect(approvalLifecycle(revisedHandle)).toBe("CONSUMED");
  });

  it.each([
    ["extra rawNotice", (payload: Record<string, unknown>) => { payload.rawNotice = original; }],
    ["extra accountReference", (payload: Record<string, unknown>) => { payload.accountReference = "EXAMPLE-8472"; }],
    ["extra nested obligation property", (payload: Record<string, unknown>) => {
      const obligations = payload.obligations as Record<string, unknown>[];
      obligations[0] = { ...obligations[0], rawText: "pay now" };
    }],
    ["extra obligation owner", (payload: Record<string, unknown>) => {
      const obligations = payload.obligations as Record<string, unknown>[];
      obligations[0] = { ...obligations[0], owner: "customer" };
    }],
    ["changed amount", (payload: Record<string, unknown>) => { payload.amountsGBP = [1281]; }],
    ["changed issue date", (payload: Record<string, unknown>) => { payload.issueDate = "2026-11-19"; }],
    ["changed deadline", (payload: Record<string, unknown>) => { payload.responseDeadlines = ["2026-11-26"]; }],
    ["changed category", (payload: Record<string, unknown>) => { payload.noticeCategory = "utility_gas"; }],
    ["changed response goal inside JSON", (payload: Record<string, unknown>) => { payload.responseGoal = "request_breakdown_and_hold"; }],
    ["circumstance flag inside JSON", (payload: Record<string, unknown>) => { payload.circumstanceFlags = ["clarify_dates"]; }],
    ["changed obligation action", (payload: Record<string, unknown>) => {
      const obligations = payload.obligations as Record<string, unknown>[];
      obligations[0] = { ...obligations[0], actionSummary: "contact_sender" };
    }],
    ["changed obligation date", (payload: Record<string, unknown>) => {
      const obligations = payload.obligations as Record<string, unknown>[];
      obligations[0] = { ...obligations[0], dueDate: "2026-11-26" };
    }],
    ["invalid schema version", (payload: Record<string, unknown>) => { payload.schemaVersion = "noticelens.cloud-brief.v9"; }],
    ["v1 schema version", (payload: Record<string, unknown>) => { payload.schemaVersion = "noticelens.cloud-brief.v1"; }],
    ["amount typed as a string", (payload: Record<string, unknown>) => { payload.amountsGBP = ["1280"]; }],
    ["extra billing-period property", (payload: Record<string, unknown>) => {
      payload.billingPeriod = { ...(payload.billingPeriod as object), note: "extra" };
    }],
    ["unknown action summary", (payload: Record<string, unknown>) => {
      const obligations = payload.obligations as Record<string, unknown>[];
      obligations[0] = { ...obligations[0], actionSummary: "pay_everything" };
    }],
    ["extra nested object", (payload: Record<string, unknown>) => { payload.note = { raw: original }; }],
    ["tampered guidance id", (payload: Record<string, unknown>) => { payload.guidanceIds = ["invented-guidance"]; }],
    ["null issue date replaced with prose", (payload: Record<string, unknown>) => { payload.issueDate = "18 November 2026"; }],
  ])("rejects a non-canonical or changed payload: %s", (_label, mutate) => {
    const state = liveFor(original);
    const handle = approve(state);
    const decision = evaluateCloudPreflight({
      ...state,
      approvalHandle: handle,
      presentedCanonicalBytes: rewrite(state.presentedCanonicalBytes, mutate),
    });
    expectClosed(decision);
    expect(["PAYLOAD_NONCANONICAL", "PAYLOAD_CHANGED"]).toContain(decision.state);
    expect(approvalLifecycle(handle)).toBe("APPROVED");
  });

  it.each([
    ["malformed JSON", "{"],
    ["empty payload", ""],
    ["null payload", "null"],
    ["array payload", "[]"],
    ["duplicate root key", (bytes: string) => bytes.replace(
      '"schemaVersion":"noticelens.cloud-brief.v2"',
      '"schemaVersion":"noticelens.cloud-brief.v1","schemaVersion":"noticelens.cloud-brief.v2"'
    )],
    ["duplicate nested obligation key", (bytes: string) => bytes.replace(
      '"actionSummary":"pay_or_contact"',
      '"actionSummary":"contact_sender","actionSummary":"pay_or_contact"'
    )],
    ["reordered keys", (bytes: string) => {
      const payload = JSON.parse(bytes) as Record<string, unknown>;
      const next: Record<string, unknown> = {};
      for (const key of Object.keys(payload).reverse()) {
        next[key] = payload[key];
      }
      return JSON.stringify(next);
    }],
    ["pretty-printed JSON", (bytes: string) => JSON.stringify(JSON.parse(bytes), null, 2)],
    ["space after the first colon", (bytes: string) => bytes.replace(":", ": ")],
  ])("rejects raw JSON that is not the exact canonical bytes: %s", (_label, produced) => {
    const state = liveFor(original);
    const handle = approve(state);
    const presentedCanonicalBytes = typeof produced === "string"
      ? produced
      : produced(state.presentedCanonicalBytes);
    expect(presentedCanonicalBytes).not.toBe(state.presentedCanonicalBytes);
    const decision = evaluateCloudPreflight({ ...state, approvalHandle: handle, presentedCanonicalBytes });
    expectClosed(decision);
    expect(["PAYLOAD_NONCANONICAL", "PAYLOAD_CHANGED"]).toContain(decision.state);
    expect(approvalLifecycle(handle)).toBe("APPROVED");
  });

  it.each([
    ["missing handle", (state: LiveCloudPreflightState) => ({ ...state, approvalHandle: null })],
    ["fabricated handle", (state: LiveCloudPreflightState) => ({ ...state, approvalHandle: { kind: "noticelens.approval-handle", approved: true } })],
    ["other document session", (state: LiveCloudPreflightState) => ({ ...state, documentContextId: "sess-9-doc-9" })],
    ["other identifier context", (state: LiveCloudPreflightState) => ({ ...state, identifierContextId: "ie-99" })],
    ["other notice generation", (state: LiveCloudPreflightState) => ({ ...state, noticeGeneration: 99 })],
    ["other extraction generation", (state: LiveCloudPreflightState) => ({ ...state, extractionGeneration: 99 })],
    ["unsupported goal", (state: LiveCloudPreflightState) => ({ ...state, responseGoal: "request_breakdown_and_hold" })],
    ["circumstance flag selected", (state: LiveCloudPreflightState) => ({ ...state, circumstanceFlags: ["usage_billed_over_12_months"] })],
  ])("rejects an approval-context attack: %s", (_label, change) => {
    const state = liveFor(original);
    const handle = approve(state);
    const decision = evaluateCloudPreflight(change({ ...state, approvalHandle: handle }));
    expectClosed(decision);
    expect(approvalLifecycle(handle)).toBe("APPROVED");
  });

  it.each([
    ["goal with trailing space", { responseGoal: "request_billing_review " }],
    ["unknown circumstance flag", { circumstanceFlags: ["not_a_flag"] }],
    ["flag sent as text", { circumstanceFlags: "usage_billed_over_12_months" as unknown as string[] }],
    ["empty goal", { responseGoal: "" }],
    ["second document epoch", { documentContextId: "sess-1-doc-1" }],
    ["identifier epoch bumped", { identifierContextId: "ie-2" }],
  ])("rejects a further approval-lifecycle change: %s", (_label, patch) => {
    const state = liveFor(original);
    const handle = approve(state);
    const decision = evaluateCloudPreflight({ ...state, ...patch, approvalHandle: handle });
    expectClosed(decision);
    expect(approvalLifecycle(handle)).toBe("APPROVED");
  });

  it("does not approve a second registration of the same bytes", () => {
    const state = liveFor(original);
    const handle = approve(state);
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
    const second = registerApprovablePayload(binding);
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(approvePending(second.handle, binding)).toBe(false);
    const decision = evaluateCloudPreflight({ ...state, approvalHandle: second.handle });
    expect(decision.state).toBe("APPROVAL_MISSING");
    expectClosed(decision);
    expect(approvalLifecycle(handle)).toBe("APPROVED");
    expect(evaluateCloudPreflight({ ...state, approvalHandle: handle }).state).toBe("PREFLIGHT_READY");
  });

  it("does not treat a pending registration as approval", () => {
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
    expect(registered.ok).toBe(true);
    if (!registered.ok) {
      return;
    }
    const decision = evaluateCloudPreflight({ ...state, approvalHandle: registered.handle });
    expect(decision.state).toBe("APPROVAL_MISSING");
    expect(approvalLifecycle(registered.handle)).toBe("PENDING_APPROVAL");
  });

  it("rejects an invalidated handle twice and does not restore it", () => {
    const state = liveFor(original);
    const handle = approve(state);
    expect(revokeApproval(handle)).toBe(true);
    const first = evaluateCloudPreflight({ ...state, approvalHandle: handle });
    const second = evaluateCloudPreflight({ ...state, approvalHandle: handle });
    expect(first.state).toBe("APPROVAL_INVALIDATED");
    expect(second.state).toBe("APPROVAL_INVALIDATED");
    expectClosed(first);
    expectClosed(second);
    expect(approvalLifecycle(handle)).toBe("INVALIDATED");
  });

  it("consumes one successful preflight and rejects the next two attempts", () => {
    const state = liveFor(revised);
    const handle = approve(state);
    const first = evaluateCloudPreflight({ ...state, approvalHandle: handle });
    const second = evaluateCloudPreflight({ ...state, approvalHandle: handle });
    const third = evaluateCloudPreflight({ ...state, approvalHandle: handle });
    expect(first.state).toBe("PREFLIGHT_READY");
    expect(first.authorisesSend).toBe(false);
    expect(second.state).toBe("APPROVAL_ALREADY_CONSUMED");
    expect(third.state).toBe("APPROVAL_ALREADY_CONSUMED");
    expectClosed(second);
    expect(approvalLifecycle(handle)).toBe("CONSUMED");
  });

  it("lets a failed attempt leave the approval usable exactly once", () => {
    const state = liveFor(original);
    const handle = approve(state);
    const wrong = evaluateCloudPreflight({
      ...state,
      approvalHandle: handle,
      presentedCanonicalBytes: state.presentedCanonicalBytes.replace("1280", "1281"),
    });
    expectClosed(wrong);
    expect(approvalLifecycle(handle)).toBe("APPROVED");
    const readyDecision = evaluateCloudPreflight({ ...state, approvalHandle: handle });
    const again = evaluateCloudPreflight({ ...state, approvalHandle: handle });
    expect(readyDecision.state).toBe("PREFLIGHT_READY");
    expect(again.state).toBe("APPROVAL_ALREADY_CONSUMED");
  });

  it("does not let the revised fixture consume the original approval", () => {
    const originalState = liveFor(original);
    const handle = approve(originalState);
    const revisedState = liveFor(revised, {
      noticeGeneration: originalState.noticeGeneration,
      identifierContextId: originalState.identifierContextId,
      documentContextId: originalState.documentContextId,
      extractionGeneration: originalState.extractionGeneration,
    });
    const decision = evaluateCloudPreflight({ ...revisedState, approvalHandle: handle });
    expect(decision.state).toBe("APPROVAL_CONTEXT_MISMATCH");
    expectClosed(decision);
    expect(approvalLifecycle(handle)).toBe("APPROVED");
  });

  it("ignores caller booleans, model text, and an old eligibility object", () => {
    const approved = liveFor(original);
    const handle = approve(approved);
    const priorDecision = assessSupportedNotice({ rawNoticeText: original, today: TODAY });
    expect(priorDecision.state).toBe("DEMO_ELIGIBLE");
    const upload = "Uploaded notice. Please pay the outstanding balance of £640 by 30 November 2026.";
    const decision = evaluateCloudPreflight({
      ...liveFor(upload, {
        presentedCanonicalBytes: approved.presentedCanonicalBytes,
        presentedSourceGenerationId: sourceGenerationId(upload),
      }),
      approvalHandle: handle,
      approved: true,
      eligible: true,
      trusted: true,
      modelText: original,
      priorDecision,
    } as LiveCloudPreflightState);
    expect(decision.state).toBe("SOURCE_NOT_ELIGIBLE");
    expectClosed(decision);
    expect(approvalLifecycle(handle)).toBe("APPROVED");
  });

  it("drops a stale on-device result after the notice is edited", () => {
    const state = liveFor(original, { extractionGeneration: 2 });
    const handle = approve(state);
    invalidateActiveApprovals();
    const edited = `${original.slice(0, -1)}x`;
    const decision = evaluateCloudPreflight({
      ...liveFor(edited, { extractionGeneration: 2 }),
      approvalHandle: handle,
      presentedSourceGenerationId: state.presentedSourceGenerationId,
      modelText: original,
    } as LiveCloudPreflightState);
    expect(decision.state).toBe("SOURCE_CHANGED");
    expectClosed(decision);
    expect(approvalLifecycle(handle)).toBe("INVALIDATED");
  });

  it.each([
    ["unsupported upload", "Please pay the outstanding balance of £640 by 30 November 2026."],
    ["historical payment", "Payment received on 3 October 2026. Your outstanding balance of £1,280 was paid in full."],
    ["cancelled demand", "Your outstanding balance of £1,280 has been cancelled."],
    ["settled demand", "Your outstanding balance of £1,280 has been paid in full."],
    ["disputed demand", "The £1,280 charge is disputed and on hold."],
    ["copied notice", `Copy of our earlier letter.\n\n${original}`],
    ["quoted notice", `The customer wrote: "${original}"`],
    ["embedded fixture", `Unrelated note.\n\n${original}\n\nThanks.`],
    ["one-character edit", `${original.slice(0, -1)}x`],
    ["changed account", original.replace("EXAMPLE-8472", "EXAMPLE-8473")],
    ["changed source amount", original.replace("£1,280", "£1,281")],
    ["changed source deadline", original.replace("25 November 2026", "26 November 2026")],
    ["empty notice", ""],
  ])("fails closed for an unsupported or edited source: %s", (_label, text) => {
    const approved = liveFor(original);
    const handle = approve(approved);
    const decision = evaluateCloudPreflight({
      ...liveFor(text),
      approvalHandle: handle,
      noticeGeneration: approved.noticeGeneration,
      identifierContextId: approved.identifierContextId,
      documentContextId: approved.documentContextId,
      extractionGeneration: approved.extractionGeneration,
    });
    expect(decision.state).toBe("SOURCE_NOT_ELIGIBLE");
    expectClosed(decision);
    expect(approvalLifecycle(handle)).toBe("APPROVED");
  });

  it("rejects the other synthetic benchmark notices", () => {
    const gas = BENCHMARK_NOTICE_FIXTURES.find((item) => item.id === "gas-catchup-arrears");
    expect(gas).toBeDefined();
    const approved = liveFor(original);
    const handle = approve(approved);
    const decision = evaluateCloudPreflight({ ...liveFor(gas!.rawText), approvalHandle: handle });
    expect(decision.state).toBe("SOURCE_NOT_ELIGIBLE");
    expectClosed(decision);
    expect(approvalLifecycle(handle)).toBe("APPROVED");
  });

  it("rejects a stale or forged generation id on the exact fixture", () => {
    const state = liveFor(original);
    const handle = approve(state);
    const stale = evaluateCloudPreflight({
      ...state,
      approvalHandle: handle,
      presentedSourceGenerationId: "sg1-00000000-1",
    });
    const forged = evaluateCloudPreflight({
      ...state,
      approvalHandle: handle,
      presentedSourceGenerationId: `${state.presentedSourceGenerationId}-copied`,
    });
    expect(stale.state).toBe("SOURCE_CHANGED");
    expect(forged.state).toBe("SOURCE_CHANGED");
    expectClosed(stale);
    expectClosed(forged);
    expect(approvalLifecycle(handle)).toBe("APPROVED");
  });

  it("rejects a one-character edit that presents the previous generation id", () => {
    const state = liveFor(original);
    const handle = approve(state);
    const edited = `${original.slice(0, -1)}x`;
    const decision = evaluateCloudPreflight({
      ...liveFor(edited),
      approvalHandle: handle,
      presentedSourceGenerationId: state.presentedSourceGenerationId,
      presentedCanonicalBytes: state.presentedCanonicalBytes,
    });
    expect(decision.state).toBe("SOURCE_CHANGED");
    expectClosed(decision);
    expect(approvalLifecycle(handle)).toBe("APPROVED");
  });

  it("does not send, log, or enable cloud submission", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is closed"));
    const decision = ready(original);
    expect(decision.state).toBe("PREFLIGHT_READY");
    expect(decision.authorisesSend).toBe(false);
    expect(CLOUD_SUBMISSION_ENABLED).toBe(false);
    expect(() => requestCloudSubmission(createCloudApprovalSession({ canonical: null }))).toThrow(/not connected/i);
    expect(() => requestClosedBriefSend({ id: "m5c1", serialized: "{", guardOptions: {}, identifierContext: "", generation: 0 } as never)).toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    const source = readFileSync("src/adapters/secureCloudPreflight.ts", "utf8");
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("sendBeacon");
    expect(source).not.toContain("WebSocket");
    expect(source).not.toContain("httpsCallable");
    expect(source).not.toContain("getGenerativeModel");
    expect(source).not.toContain("cloudDrafter");
    info.mockRestore();
    log.mockRestore();
    fetchSpy.mockRestore();
  });
});

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  approvalLifecycle,
  approvalRegistryTestIsolation,
  approvePending,
  authoriseExactApproval,
  activeApprovalCount,
  invalidateActiveApprovals,
  isHandleApproved,
  isPayloadApproved,
  registerApprovablePayload,
  releaseInvalidatedApprovals,
  retainedApprovalCount,
  revokeApproval,
  type ApprovalBinding,
  type ApprovalHandle,
} from "../../src/domain/approvalRegistry";
import {
  approvalStillMatches,
  privacyApprovalView,
  recordClosedBriefApproval,
  requestClosedBriefSend,
  resetUserApprovalStateForTests,
  type ApprovalCheckContext,
} from "../../src/adapters/privacyApproval";
import {
  canonicalClosedCloudBrief,
  CLOSED_CLOUD_BRIEF_SCHEMA_VERSION,
} from "../../src/domain/closedCloudBrief";
import type { CircumstanceFlag, ResponseGoal } from "../../src/domain/types";
import { CLOUD_SUBMISSION_ENABLED } from "../../src/adapters/cloudApprovalSession";

function canonical(overrides: Record<string, unknown> = {}) {
  return canonicalClosedCloudBrief({
    schemaVersion: CLOSED_CLOUD_BRIEF_SCHEMA_VERSION,
    noticeCategory: "utility_electricity",
    issueDate: "2026-11-18",
    billingPeriod: { start: "2025-01", end: "2025-06" },
    amountsGBP: [1280],
    responseDeadlines: ["2026-11-25"],
    obligations: [{ actionSummary: "pay_or_contact", dueDate: "2026-11-25" }],
    responseGoal: "request_billing_review",
    guidanceIds: ["ofgem-backbilling-12m-v1"],
    ...overrides,
  });
}

function binding(bytes: string, patch: Partial<ApprovalBinding> = {}): ApprovalBinding {
  const parsed = JSON.parse(bytes) as {
    responseGoal: ResponseGoal;
    circumstanceFlags?: CircumstanceFlag[];
  };
  return {
    schema: "noticelens.cloud-brief.v2",
    canonicalBytes: bytes,
    noticeGeneration: 1,
    identifierContextId: "ie-1",
    responseGoal: parsed.responseGoal,
    circumstanceFlags: parsed.circumstanceFlags ?? [],
    extractionGeneration: 0,
    documentContextId: "sess-1-doc-0",
    ...patch,
  };
}

function approve(value: ApprovalBinding): ApprovalHandle {
  const registered = registerApprovablePayload(value);
  expect(registered.ok).toBe(true);
  if (!registered.ok) {
    throw new Error(registered.reason);
  }
  expect(approvePending(registered.handle, value)).toBe(true);
  return registered.handle;
}

describe("handle-specific approval authority", () => {
  beforeEach(() => {
    approvalRegistryTestIsolation.reset();
    resetUserApprovalStateForTests();
  });

  it("does not let a second approved record survive revocation of the first", () => {
    const current = binding(canonical().serialized);
    const first = registerApprovablePayload(current);
    const second = registerApprovablePayload(current);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(approvePending(first.handle, current)).toBe(true);
    expect(approvePending(second.handle, current)).toBe(false);
    expect(approvalLifecycle(second.handle)).toBe("PENDING_APPROVAL");
    expect(isHandleApproved(first.handle, current)).toBe(true);
    expect(isHandleApproved(second.handle, current)).toBe(false);
    expect(isPayloadApproved(current)).toBe(true);
    expect(revokeApproval(first.handle)).toBe(true);
    expect(isPayloadApproved(current)).toBe(false);
    expect(isHandleApproved(second.handle, current)).toBe(false);
    expect(approvePending(first.handle, current)).toBe(false);
    expect(authoriseExactApproval(second.handle, current)).toEqual({ ok: false, reason: "not-approved" });
    revokeApproval(second.handle);
    releaseInvalidatedApprovals();
    expect(isPayloadApproved(current)).toBe(false);
  });

  it("authorises one exact handle once and does not restore it", () => {
    const current = binding(canonical().serialized);
    const handle = approve(current);
    expect(authoriseExactApproval(handle, binding(canonical({ amountsGBP: [520] }).serialized))).toEqual({
      ok: false,
      reason: "mismatched",
    });
    expect(authoriseExactApproval(handle, binding(current.canonicalBytes, { noticeGeneration: 2 }))).toEqual({
      ok: false,
      reason: "mismatched",
    });
    expect(authoriseExactApproval(handle, binding(current.canonicalBytes, { identifierContextId: "ie-2" }))).toEqual({
      ok: false,
      reason: "mismatched",
    });
    expect(approvalLifecycle(handle)).toBe("APPROVED");
    expect(authoriseExactApproval(handle, current)).toEqual({ ok: true });
    expect(approvalLifecycle(handle)).toBe("CONSUMED");
    expect(isHandleApproved(handle, current)).toBe(false);
    expect(isPayloadApproved(current)).toBe(false);
    expect(authoriseExactApproval(handle, current)).toEqual({ ok: false, reason: "already-consumed" });
    expect(approvePending(handle, current)).toBe(false);
    expect(revokeApproval(handle)).toBe(false);
    const clone = { ...handle };
    expect(authoriseExactApproval(clone, current)).toEqual({ ok: false, reason: "missing-handle" });
    expect(authoriseExactApproval({ kind: "noticelens.approval-handle" }, current)).toEqual({
      ok: false,
      reason: "missing-handle",
    });
  });

  it("rejects a stale handle after the test registry is replaced", () => {
    const current = binding(canonical().serialized);
    const stale = approve(current);
    approvalRegistryTestIsolation.reset();
    expect(approvalLifecycle(stale)).toBe("NO_APPROVAL");
    expect(isHandleApproved(stale, current)).toBe(false);
    expect(approvePending(stale, current)).toBe(false);
    expect(authoriseExactApproval(stale, current).ok).toBe(false);
    const fresh = approve(current);
    expect(isHandleApproved(fresh, current)).toBe(true);
    expect(isHandleApproved(stale, current)).toBe(false);
    expect(authoriseExactApproval(stale, current)).toEqual({ ok: false, reason: "missing-handle" });
  });

  it("releases invalidated records and keeps a held handle terminal", () => {
    const bytes = canonical().serialized;
    const held: ApprovalHandle[] = [];
    for (let index = 0; index < 400; index += 1) {
      const current = binding(bytes, {
        noticeGeneration: index,
        documentContextId: `sess-1-doc-${index}`,
      });
      held.push(approve(current));
      invalidateActiveApprovals();
      expect(retainedApprovalCount()).toBe(0);
      expect(activeApprovalCount()).toBe(0);
    }
    const stale = held[0];
    expect(stale).toBeDefined();
    if (!stale) {
      return;
    }
    const staleBinding = binding(bytes, { noticeGeneration: 0, documentContextId: "sess-1-doc-0" });
    expect(approvalLifecycle(stale)).toBe("INVALIDATED");
    expect(authoriseExactApproval(stale, staleBinding)).toEqual({ ok: false, reason: "invalidated" });
    expect(approvePending(stale, staleBinding)).toBe(false);
    const restored = binding(bytes, { noticeGeneration: 400, documentContextId: "sess-1-doc-400" });
    const fresh = approve(restored);
    expect(isHandleApproved(fresh, restored)).toBe(true);
    expect(isHandleApproved(stale, restored)).toBe(false);
    expect(retainedApprovalCount()).toBe(1);
  });

  it("keeps the application and send modules from resetting the registry", () => {
    const sources = [
      "src/ui/production/NoticeLensApp.tsx",
      "src/ui/privacy/PrivacyApprovalModal.tsx",
      "src/ui/screens/PrepareReplyScreen.tsx",
      "src/adapters/cloudApprovalSession.ts",
    ]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(sources).not.toContain("resetApprovalRegistryForTests");
    expect(sources).not.toContain("approvalRegistryTestIsolation");
    expect(readFileSync("src/ui/production/NoticeLensApp.tsx", "utf8")).not.toContain("runCloudDraft");
    expect(readFileSync("src/domain/approvalRegistry.ts", "utf8")).not.toContain("resetApprovalRegistryForTests");
    expect(CLOUD_SUBMISSION_ENABLED).toBe(false);
  });
});

describe("legacy approval view fails closed without the full context", () => {
  beforeEach(() => {
    resetUserApprovalStateForTests();
  });

  function recorded(identifiers: readonly string[] = []) {
    const serialized = canonical().serialized;
    const approval = recordClosedBriefApproval(serialized, serialized, 4, {
      forbiddenIdentifiers: [...identifiers],
    });
    const context = approval.boundContext;
    expect(context).toBeDefined();
    if (!context) {
      throw new Error("missing bound context");
    }
    return { serialized, approval, context };
  }

  function view(
    approval: ReturnType<typeof recorded>["approval"],
    serialized: string,
    generation: number,
    context: ApprovalCheckContext | undefined,
    guardOptions = context?.guardOptions
  ) {
    return privacyApprovalView({
      serialized,
      limitations: [],
      approval,
      generation,
      guardOptions,
      context,
    }).matchesCurrentPayload;
  }

  it("rejects omitted, partial, and changed context while accepting the captured context", () => {
    const first = recorded(["Alice Example"]);
    expect(view(first.approval, first.serialized, 4, first.context)).toBe(true);
    expect(approvalStillMatches(first.approval, first.serialized, 4, first.context)).toBe(true);
    expect(approvalStillMatches(first.approval, first.serialized, 4)).toBe(false);
    expect(view(first.approval, first.serialized, 4, undefined, undefined)).toBe(false);
    expect(view(first.approval, first.serialized, 4, undefined, {})).toBe(false);
    expect(
      view(first.approval, first.serialized, 4, {
        ...first.context,
        guardOptions: {},
      })
    ).toBe(false);

    const otherIdentifiers: ApprovalCheckContext = {
      ...first.context,
      guardOptions: { forbiddenIdentifiers: ["Bob Example"] },
    };
    expect(view(first.approval, first.serialized, 4, otherIdentifiers)).toBe(false);
    expect(view(first.approval, first.serialized, 5, first.context)).toBe(false);
    expect(
      view(first.approval, first.serialized, 4, {
        ...first.context,
        documentContextId: "sess-9-doc-9",
      })
    ).toBe(false);
    expect(
      view(first.approval, first.serialized, 4, {
        ...first.context,
        responseGoal: "confirm_payment_plan_options",
      })
    ).toBe(false);
    expect(
      view(first.approval, first.serialized, 4, {
        ...first.context,
        circumstanceFlags: ["clarify_dates"],
      })
    ).toBe(false);
    expect(
      view(first.approval, first.serialized, 4, {
        ...first.context,
        extractionGeneration: 3,
      })
    ).toBe(false);
    expect(view(first.approval, first.serialized.replace("1280", "520"), 4, first.context)).toBe(false);

    const second = recorded(["Bob Example"]);
    expect(view(first.approval, first.serialized, 4, second.context, second.context.guardOptions)).toBe(false);
    expect(view(second.approval, second.serialized, 4, second.context)).toBe(true);
    expect(() => requestClosedBriefSend(second.approval)).toThrow(/not connected/i);
    expect(view(second.approval, second.serialized, 4, second.context)).toBe(false);
    expect(() => requestClosedBriefSend(second.approval)).toThrow(/already been used/i);
  });
});

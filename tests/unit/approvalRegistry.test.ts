import { readFileSync } from "node:fs";
import { describe, expect, it, beforeEach } from "vitest";
import {
  amountFactPresentation,
  displayVerifiedAmount,
  groundNoticeFacts,
} from "../../src/adapters/groundNoticeFacts";
import {
  approvalLifecycle,
  approvalBindingsEqual,
  approvePending,
  bindingLifecycle,
  invalidateActiveApprovals,
  isPayloadApproved,
  registerApprovablePayload,
  approvalRegistryTestIsolation,
  revokeApproval,
  type ApprovalBinding,
  type ApprovalHandle,
} from "../../src/domain/approvalRegistry";
import {
  canonicalClosedCloudBrief,
  CLOSED_CLOUD_BRIEF_SCHEMA_VERSION,
} from "../../src/domain/closedCloudBrief";
import type { CircumstanceFlag, ResponseGoal } from "../../src/domain/types";
import { CLOUD_SUBMISSION_ENABLED } from "../../src/adapters/cloudApprovalSession";
import { requestClosedBriefSend, resetUserApprovalStateForTests } from "../../src/adapters/privacyApproval";

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

describe("immutable approval registry", () => {
  beforeEach(() => {
    approvalRegistryTestIsolation.reset();
    resetUserApprovalStateForTests();
  });

  it("approves one exact pending payload and does not approve it twice", () => {
    const bytes = canonical().serialized;
    const current = binding(bytes);
    const registered = registerApprovablePayload(current);
    expect(registered.ok).toBe(true);
    if (!registered.ok) {
      return;
    }
    expect(registered.lifecycle).toBe("PENDING_APPROVAL");
    expect(bindingLifecycle(current)).toBe("PENDING_APPROVAL");
    expect(isPayloadApproved(current)).toBe(false);
    expect(approvePending(registered.handle, current)).toBe(true);
    expect(approvalLifecycle(registered.handle)).toBe("APPROVED");
    expect(isPayloadApproved(current)).toBe(true);
    expect(approvePending(registered.handle, current)).toBe(false);
    expect(approvalLifecycle(registered.handle)).toBe("APPROVED");
    expect(revokeApproval(registered.handle)).toBe(true);
    expect(revokeApproval(registered.handle)).toBe(false);
    expect(approvalLifecycle(registered.handle)).toBe("INVALIDATED");
    expect(approvePending(registered.handle, current)).toBe(false);
    expect(isPayloadApproved(current)).toBe(false);
    expect(bindingLifecycle(current)).toBe("INVALIDATED");
  });

  it("rejects reordered, pretty-printed, and altered canonical bytes", () => {
    const exact = canonical();
    const parsed = JSON.parse(exact.serialized) as Record<string, unknown>;
    const reordered = JSON.stringify({
      responseGoal: parsed.responseGoal,
      schemaVersion: parsed.schemaVersion,
      noticeCategory: parsed.noticeCategory,
      issueDate: parsed.issueDate,
      billingPeriod: parsed.billingPeriod,
      amountsGBP: parsed.amountsGBP,
      responseDeadlines: parsed.responseDeadlines,
      obligations: parsed.obligations,
      guidanceIds: parsed.guidanceIds,
    });
    expect(reordered).not.toBe(exact.serialized);
    expect(registerApprovablePayload(binding(reordered)).ok).toBe(false);
    const pretty = JSON.stringify(parsed, null, 2);
    expect(registerApprovablePayload(binding(pretty)).ok).toBe(false);
    expect(isPayloadApproved(binding(pretty))).toBe(false);

    approve(binding(exact.serialized));
    expect(isPayloadApproved(binding(canonical({ amountsGBP: [520] }).serialized))).toBe(false);
    expect(isPayloadApproved(binding(canonical({ responseDeadlines: ["2026-12-01"], obligations: [{ actionSummary: "pay_or_contact", dueDate: "2026-12-01" }] }).serialized))).toBe(false);
    expect(
      isPayloadApproved(
        binding(
          canonical({
            obligations: [{ actionSummary: "contact_sender", dueDate: "2026-11-25" }],
          }).serialized
        )
      )
    ).toBe(false);
    const otherGoal = canonical({ responseGoal: "confirm_payment_plan_options" });
    expect(isPayloadApproved(binding(otherGoal.serialized))).toBe(false);
    const flagged = canonical({ circumstanceFlags: ["usage_billed_over_12_months"] });
    expect(isPayloadApproved(binding(flagged.serialized))).toBe(false);
    expect(isPayloadApproved(binding(exact.serialized))).toBe(true);
  });

  it("does not share an approval across notices, generations, or identifier contexts", () => {
    const bytes = canonical().serialized;
    approve(binding(bytes));
    expect(isPayloadApproved(binding(bytes, { documentContextId: "sess-2-doc-0" }))).toBe(false);
    expect(isPayloadApproved(binding(bytes, { noticeGeneration: 2 }))).toBe(false);
    expect(isPayloadApproved(binding(bytes, { identifierContextId: "ie-2" }))).toBe(false);
    expect(isPayloadApproved(binding(bytes, { extractionGeneration: 1 }))).toBe(false);
    expect(isPayloadApproved(binding(bytes))).toBe(true);
  });

  it("does not restore an invalidated approval when the same bytes return on a new generation", () => {
    const bytes = canonical().serialized;
    const first = binding(bytes, { noticeGeneration: 1, documentContextId: "sess-1-doc-0" });
    const handle = approve(first);
    invalidateActiveApprovals();
    expect(approvalLifecycle(handle)).toBe("INVALIDATED");
    expect(isPayloadApproved(first)).toBe(false);
    const restored = binding(bytes, { noticeGeneration: 2, documentContextId: "sess-1-doc-1" });
    expect(isPayloadApproved(restored)).toBe(false);
    expect(bindingLifecycle(restored)).toBe("NO_APPROVAL");
    approve(restored);
    expect(isPayloadApproved(restored)).toBe(true);
    expect(isPayloadApproved(first)).toBe(false);
    expect(approvePending(handle, first)).toBe(false);
  });

  it("rejects mutated bindings, clones, forgeries, and malformed context", () => {
    const bytes = canonical().serialized;
    const flags: CircumstanceFlag[] = [];
    const current = binding(bytes, { circumstanceFlags: flags });
    const registered = registerApprovablePayload(current);
    expect(registered.ok).toBe(true);
    if (!registered.ok) {
      return;
    }
    flags.push("clarify_dates");
    (current as { canonicalBytes: string }).canonicalBytes = "mutated";
    expect(approvePending(registered.handle, binding(bytes))).toBe(true);
    expect(isPayloadApproved(binding(bytes))).toBe(true);

    const clone = { ...registered.handle };
    expect(approvePending(clone, binding(bytes))).toBe(false);
    expect(revokeApproval(clone)).toBe(false);
    expect(approvalLifecycle(clone)).toBe("NO_APPROVAL");
    const forged = { kind: "noticelens.approval-handle" as const };
    expect(approvePending(forged, binding(bytes))).toBe(false);
    expect(revokeApproval(forged)).toBe(false);
    const copied = structuredClone(registered.handle);
    expect(approvePending(copied, binding(bytes))).toBe(false);

    expect(registerApprovablePayload({ ...binding(bytes), canonicalBytes: "" }).ok).toBe(false);
    expect(registerApprovablePayload({ ...binding(bytes), identifierContextId: '["Sarah Example"]' }).ok).toBe(false);
    expect(registerApprovablePayload({ ...binding(bytes), identifierContextId: "sarah-example" }).ok).toBe(false);
    expect(registerApprovablePayload({ ...binding(bytes), documentContextId: "notice-a" }).ok).toBe(false);
    expect(registerApprovablePayload({ ...binding(bytes), noticeGeneration: 1.5 }).ok).toBe(false);
    expect(registerApprovablePayload({ ...binding(bytes), noticeGeneration: -1 }).ok).toBe(false);
    expect(isPayloadApproved({ ...binding(bytes), canonicalBytes: "" })).toBe(false);
    expect(approvalBindingsEqual(binding(bytes), binding(canonical({ amountsGBP: [760] }).serialized))).toBe(false);
    expect(CLOUD_SUBMISSION_ENABLED).toBe(false);
  });

  it("rejects a delayed approve after the generation is invalidated", () => {
    const bytes = canonical().serialized;
    const current = binding(bytes, { noticeGeneration: 4 });
    const registered = registerApprovablePayload(current);
    expect(registered.ok).toBe(true);
    if (!registered.ok) {
      return;
    }
    invalidateActiveApprovals();
    const superseded = binding(bytes, { noticeGeneration: 5 });
    expect(approvePending(registered.handle, current)).toBe(false);
    expect(approvePending(registered.handle, superseded)).toBe(false);
    expect(isPayloadApproved(current)).toBe(false);
    expect(isPayloadApproved(superseded)).toBe(false);
  });

  it("does not promote an unsupported fact to verified", () => {
    const text =
      "Your outstanding balance is £1,280.\nThe £1,280 demand has been cancelled.\nPlease pay the outstanding balance of £1,280 by 25 November 2026.";
    const view = groundNoticeFacts({ rawNoticeText: text, today: "2026-11-13" });
    expect(displayVerifiedAmount(view)).toBeNull();
    expect(amountFactPresentation(view)).toBe("needs_review");
    const built = canonical({
      amountsGBP: [],
      responseDeadlines: [],
      obligations: [],
      issueDate: null,
      billingPeriod: null,
    });
    approve(binding(built.serialized));
    expect(displayVerifiedAmount(view)).toBeNull();
    expect(amountFactPresentation(view)).toBe("needs_review");
    expect(readFileSync("src/domain/approvalRegistry.ts", "utf8")).not.toMatch(/localStorage|sessionStorage/);
    expect(() =>
      requestClosedBriefSend({
        kind: "user-canonical-snapshot",
        id: "forged",
        generation: 1,
        serialized: built.serialized,
        guardOptions: {},
        identifierContext: "[]",
        cloudSendEnabled: false,
      })
    ).toThrow(/canonical validation|not connected|already been used/i);
  });
});

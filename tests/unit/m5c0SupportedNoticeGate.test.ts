import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildClosedCloudBrief } from "../../src/adapters/buildClosedCloudBrief";
import {
  CLOUD_SUBMISSION_ENABLED,
  createCloudApprovalSession,
  requestCloudSubmission,
} from "../../src/adapters/cloudApprovalSession";
import {
  displayVerifiedAmount,
  displayVerifiedIssueDate,
  groundNoticeFacts,
  verifiedResponseDeadlineIso,
} from "../../src/adapters/groundNoticeFacts";
import { requestClosedBriefSend } from "../../src/adapters/privacyApproval";
import {
  assessSupportedNotice,
  rejectionForPayloadShape,
  sourceGenerationId,
} from "../../src/adapters/supportedNoticeGate";
import { compareNoticeTexts } from "../../src/domain/compareNotices";
import { CLOSED_CLOUD_BRIEF_ROOT_KEYS } from "../../src/domain/closedCloudBrief";
import { invalidateActiveApprovals } from "../../src/domain/approvalRegistry";
import { verifiedBalanceForSource } from "../../src/domain/sourceGrounding";
import { normalizeNewlines } from "../../src/domain/textNormalize";
import { BENCHMARK_NOTICE_FIXTURES } from "../../src/fixtures/benchmarkNotices";

const TODAY = "2026-11-18";
const original = normalizeNewlines(readFileSync("examples/energy-backbill-original.txt", "utf8"));
const revised = normalizeNewlines(readFileSync("examples/energy-backbill-revised.txt", "utf8"));

function assess(text: string, extra: Parameters<typeof assessSupportedNotice>[0] = { rawNoticeText: text, today: TODAY }) {
  return assessSupportedNotice({ ...extra, rawNoticeText: text, today: extra.today ?? TODAY });
}

describe("Phase 5C-0 supported notice gate", () => {
  it("accepts only the exact original and revised synthetic notices", () => {
    const originalDecision = assess(original);
    const revisedDecision = assess(revised);
    expect(originalDecision).toMatchObject({
      state: "DEMO_ELIGIBLE",
      reason: null,
      fixtureId: "energy-backbill-original",
      authorisesSend: false,
      sourceGenerationId: sourceGenerationId(original),
    });
    expect(revisedDecision).toMatchObject({
      state: "DEMO_ELIGIBLE",
      reason: null,
      fixtureId: "energy-backbill-revised",
      authorisesSend: false,
      sourceGenerationId: sourceGenerationId(revised),
    });
    expect(originalDecision.sourceGenerationId).not.toBe(revisedDecision.sourceGenerationId);
    expect(originalDecision.sourceGenerationId).not.toContain("EXAMPLE-8472");
    expect(originalDecision.sourceGenerationId).not.toContain("Sarah");

    const originalView = groundNoticeFacts({ rawNoticeText: original, today: TODAY });
    const revisedView = groundNoticeFacts({ rawNoticeText: revised, today: TODAY });
    expect(displayVerifiedAmount(originalView)).toBe(1280);
    expect(displayVerifiedIssueDate(originalView)).toBe("18 November 2026");
    expect(verifiedResponseDeadlineIso(originalView)).toBe("2026-11-25");
    expect(displayVerifiedAmount(revisedView)).toBe(520);
    expect(displayVerifiedIssueDate(revisedView)).toBe("2 December 2026");
    expect(verifiedResponseDeadlineIso(revisedView)).toBe("2026-12-16");

    const originalPayload = buildClosedCloudBrief({
      view: originalView,
      responseGoal: "request_billing_review",
    }).payload;
    const revisedPayload = buildClosedCloudBrief({
      view: revisedView,
      responseGoal: "request_billing_review",
    }).payload;
    expect(originalPayload).toMatchObject({
      schemaVersion: "noticelens.cloud-brief.v2",
      noticeCategory: "utility_electricity",
      issueDate: "2026-11-18",
      billingPeriod: { start: "2025-01", end: "2025-06" },
      amountsGBP: [1280],
      responseDeadlines: ["2026-11-25"],
      obligations: [{ actionSummary: "pay_or_contact", dueDate: "2026-11-25" }],
    });
    expect(revisedPayload).toMatchObject({
      noticeCategory: "other_household_notice",
      issueDate: "2026-12-02",
      billingPeriod: null,
      amountsGBP: [520],
      responseDeadlines: ["2026-12-16"],
      obligations: [{ actionSummary: "contact_sender", dueDate: "2026-12-16" }],
    });
    expect(revisedPayload.obligations.some((item) => item.actionSummary === "pay_or_contact")).toBe(false);
    for (const payload of [originalPayload, revisedPayload]) {
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain("EXAMPLE-8472");
      expect(serialized).not.toContain("Sarah Example");
      expect(serialized).not.toContain("14 Example Road");
      expect(serialized).not.toContain("outstanding balance of £1,280");
      expect(Object.keys(payload).sort()).toEqual([...CLOSED_CLOUD_BRIEF_ROOT_KEYS].sort());
    }
  });

  it("treats a newline-only difference as the same source", () => {
    const crlf = original.replace(/\n/g, "\r\n");
    expect(assess(crlf)).toMatchObject({
      state: "DEMO_ELIGIBLE",
      fixtureId: "energy-backbill-original",
      sourceGenerationId: sourceGenerationId(original),
    });
  });

  it("rejects a one-character edit and does not keep the previous generation", () => {
    const edited = `${original.slice(0, -1)}x`;
    const decision = assess(edited);
    expect(decision.state).toBe("LOCAL_REVIEW_ONLY");
    expect(decision.reason).toBe("not_approved_fixture");
    expect(decision.fixtureId).toBeNull();
    expect(decision.sourceGenerationId).not.toBe(sourceGenerationId(original));
    expect(decision.authorisesSend).toBe(false);
  });

  it.each([
    ["changed account", original.replace("EXAMPLE-8472", "EXAMPLE-8473")],
    ["changed amount", original.replace("£1,280", "£1,281")],
    ["changed issue date", original.replace("18 November 2026", "19 November 2026")],
    ["changed obligation", original.replace("Please pay the balance", "Please ignore the balance")],
    ["changed category", original.replace("electricity", "gas")],
    ["copied notice", `Copy of our earlier letter.\n\n${original}`],
    ["quoted notice", `The customer wrote: "${original}"`],
    ["embedded fixture", `Unrelated note.\n\n${original}\n\nThanks.`],
    ["unsupported upload", "Please pay the outstanding balance of £640 by 30 November 2026."],
    [
      "historical payment",
      "Payment received on 3 October 2026. Your outstanding balance of £1,280 was paid in full.",
    ],
    ["cancelled demand", "Your outstanding balance of £1,280 has been cancelled."],
    ["settled demand", "Your outstanding balance of £1,280 has been paid in full."],
    ["disputed demand", "The £1,280 charge is disputed and on hold."],
  ])("fails closed for %s", (_name, text) => {
    const decision = assess(text);
    expect(decision.state).toBe("LOCAL_REVIEW_ONLY");
    expect(decision.reason).toBe("not_approved_fixture");
    expect(decision.fixtureId).toBeNull();
    expect(decision.authorisesSend).toBe(false);
  });

  it("does not make the gate the thing that verifies an unsupported amount", () => {
    const cancelled = "Your outstanding balance of £1,280 has been cancelled.";
    expect(verifiedBalanceForSource(cancelled).authority).not.toBe("verified");
    assess(cancelled);
    expect(verifiedBalanceForSource(cancelled).amountGBP).toBeNull();
    const disputed = "The £1,280 charge is disputed and on hold.";
    expect(verifiedBalanceForSource(disputed).amountGBP).toBeNull();
  });

  it("does not accept the other synthetic benchmark notices", () => {
    const gas = BENCHMARK_NOTICE_FIXTURES.find((item) => item.id === "gas-catchup-arrears");
    expect(gas).toBeDefined();
    expect(assess(gas!.rawText)).toMatchObject({
      state: "LOCAL_REVIEW_ONLY",
      reason: "not_approved_fixture",
      fixtureId: null,
    });
  });

  it("rejects a stale source generation and a forged one", () => {
    const live = assess(original);
    const edited = original.replace("£1,280", "£1,281");
    expect(assess(edited, { rawNoticeText: edited, today: TODAY, claimedSourceGenerationId: live.sourceGenerationId })).toMatchObject({
      state: "LOCAL_REVIEW_ONLY",
      reason: "stale_source_generation",
    });
    expect(
      assess(original, { rawNoticeText: original, today: TODAY, claimedSourceGenerationId: "sg1-00000000-0" })
    ).toMatchObject({
      state: "LOCAL_REVIEW_ONLY",
      reason: "stale_source_generation",
      fixtureId: null,
    });
    expect(
      assess(original, { rawNoticeText: original, today: TODAY, claimedSourceGenerationId: live.sourceGenerationId })
    ).toMatchObject({ state: "DEMO_ELIGIBLE", fixtureId: "energy-backbill-original" });
  });

  it("ignores a new document session, approval, and model text", () => {
    const first = assess(original, { rawNoticeText: original, today: TODAY, sessionId: "sess-a" });
    const second = assess(original, { rawNoticeText: original, today: TODAY, sessionId: "sess-b" });
    expect(second).toEqual(first);
    expect(
      assess("Uploaded notice. Please pay £10.", {
        rawNoticeText: "Uploaded notice. Please pay £10.",
        today: TODAY,
        sessionId: "sess-new",
        approvalGranted: true,
        modelText: original,
      })
    ).toMatchObject({
      state: "LOCAL_REVIEW_ONLY",
      reason: "not_approved_fixture",
      authorisesSend: false,
    });
    invalidateActiveApprovals();
    expect(assess(original, { rawNoticeText: original, today: TODAY, approvalGranted: true }).authorisesSend).toBe(
      false
    );
    expect(assess(original, { rawNoticeText: original, today: TODAY, approvalGranted: true }).state).toBe(
      "DEMO_ELIGIBLE"
    );
  });

  it("rejects an unexpected v2 field and keeps identifiers out of the decision", () => {
    const view = groundNoticeFacts({ rawNoticeText: original, today: TODAY });
    const payload = buildClosedCloudBrief({ view, responseGoal: "request_billing_review" }).payload;
    expect(rejectionForPayloadShape(payload)).toBeNull();
    expect(rejectionForPayloadShape({ ...payload, rawNotice: original })).toBe("unexpected_v2_field");
    expect(rejectionForPayloadShape({ ...payload, accountReference: "EXAMPLE-8472" })).toBe("unexpected_v2_field");
  });

  it("does not authorise send and does not log the notice", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const decision = assess(original);
    expect(decision.authorisesSend).toBe(false);
    expect(CLOUD_SUBMISSION_ENABLED).toBe(false);
    expect(() => requestCloudSubmission(createCloudApprovalSession({ canonical: null }))).toThrow(/not connected/i);
    expect(() =>
      requestClosedBriefSend({
        id: "m5c0-not-an-approval",
        serialized: "{",
        guardOptions: {},
        identifierContext: "",
        generation: 0,
      } as never)
    ).toThrow();
    expect(info).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    const source = readFileSync("src/adapters/supportedNoticeGate.ts", "utf8");
    expect(source).not.toContain("fetch(");
    info.mockRestore();
    log.mockRestore();
  });

  it("leaves the demo comparison unverified", () => {
    const comparison = compareNoticeTexts(original, revised, { today: TODAY });
    expect(comparison.relationship).toBe("RELATIONSHIP_UNVERIFIED");
    expect(comparison.amount.value).toBe(1280);
    expect(comparison.amount.revised).toBe(520);
    expect(comparison.amount.differenceGBP).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { buildCloudBrief } from "../../src/adapters/cloudBriefBuilder";
import { CLOUD_SUBMISSION_ENABLED } from "../../src/adapters/cloudApprovalSession";
import { briefSourceFromGrounded, groundNoticeFacts } from "../../src/adapters/groundNoticeFacts";
import {
  approvalStillMatches,
  recordUserPayloadApproval,
  requestApprovedCloudSend,
  resetUserApprovalStateForTests,
} from "../../src/adapters/privacyApproval";
import { canonicalCloudPayload } from "../../src/domain/cloudPayloadGuard";
import {
  approveCloudPayload,
  resetCloudSendStateForTests,
} from "../../src/domain/cloudSendApproval";
import { decideNoticeCategory } from "../../src/domain/noticeCategory";
import {
  groundCalendarDate,
  groundMonetaryAmount,
  groundObligation,
} from "../../src/domain/sourceGrounding";
import { M0_SMOKE_TEST_CLOUD_PAYLOAD } from "../../src/fixtures/benchmarkNotices";
import type { RawNoticeExtraction } from "../../src/domain/types";

const TODAY = "2026-11-13";

describe("M2A-5 category guidance follows the notice text", () => {
  it("does not apply Ofgem guidance when the model calls a council-tax notice electricity", () => {
    const text = [
      "16 November 2026",
      "Dear Priya Testperson,",
      "Council Tax reference: CTAX-90214",
      "Our records show missed Council Tax instalments totalling £312.00 for the billing period October to November 2026.",
      "You must bring your account up to date by paying £312.00 by 30 November 2026, or contact the Council Tax office before that date.",
    ].join("\n");
    const quote =
      "You must bring your account up to date by paying £312.00 by 30 November 2026, or contact the Council Tax office before that date.";
    const extraction: RawNoticeExtraction = {
      noticeCategory: "utility_electricity",
      issueDate: "16 November 2026",
      billingPeriod: "October to November 2026",
      amountGBP: 312,
      responseDeadline: "30 November 2026",
      obligations: [{ action: "Pay the instalments", dueDate: "30 November 2026", sourceQuote: quote }],
    };
    const view = groundNoticeFacts({ rawNoticeText: text, today: TODAY, extraction });
    expect(view.noticeCategory).toBe("council_tax");
    expect(view.categoryDecision.modelIgnored).toBe(true);
    expect(view.categoryDecision.guidanceIds).toEqual(["citizens-advice-council-tax-reminder-v1"]);
    expect(view.categoryDecision.guidanceIds).not.toContain("ofgem-backbilling-12m-v1");

    const inspection = buildCloudBrief({
      rawNoticeText: text,
      source: briefSourceFromGrounded(view),
      edits: {
        responseGoal: "request_breakdown_and_hold",
        circumstanceFlags: [],
        extraKnownIdentifiers: ["Priya Testperson"],
      },
    });
    expect(inspection.canonical?.payload.noticeCategory).toBe("council_tax");
    expect(inspection.canonical?.payload.guidanceIds).not.toContain("ofgem-backbilling-12m-v1");
  });

  it("does not trust an electricity label when the notice states no category", () => {
    const decision = decideNoticeCategory(
      "Please contact our billing team by 25 November 2026.",
      "utility_electricity"
    );
    expect(decision.noticeCategory).toBe("other_household_notice");
    expect(decision.guidanceIds).toEqual([]);
    expect(decision.needsConfirmation).toBe(true);
    expect(decision.modelIgnored).toBe(true);
  });

  it("keeps Ofgem guidance when the notice itself is an electricity notice", () => {
    const decision = decideNoticeCategory(
      "Outstanding balance for electricity supplied between January and June 2025.",
      "utility_electricity"
    );
    expect(decision.noticeCategory).toBe("utility_electricity");
    expect(decision.guidanceIds).toEqual(["ofgem-backbilling-12m-v1"]);
    expect(decision.modelIgnored).toBe(false);
  });
});

describe("source claims stay unverified when the quotation does not support them", () => {
  const source = "Outstanding balance of £1,280. Please pay by 25 November 2026.";

  it("rejects a truncated quotation, a negated amount, and a contradictory action", () => {
    expect(groundMonetaryAmount(source, 1280, "balance of £1,280...").support).toBe("incomplete");
    expect(groundMonetaryAmount(source, 1280, "balance of £1,280...").verifiedForDisplay).toBeNull();
    expect(groundCalendarDate(source, "2026-11-25", "by 25 November 2026…").support).toBe(
      "incomplete"
    );
    expect(groundMonetaryAmount(source, 520, "Outstanding balance of £1,280.").support).toBe(
      "substring_only"
    );
    const negated = "The balance of £1,280 is not due.";
    expect(groundMonetaryAmount(negated, 1280, negated).support).toBe("substring_only");
    expect(groundMonetaryAmount(negated, 1280, negated).verifiedForDisplay).toBeNull();
    expect(
      groundMonetaryAmount(source, 1280, "Outstanding balance of £1,280.").verifiedForDisplay
    ).toBe(1280);
    const mixed = "Please pay £1,280 or the revised £520 today.";
    expect(groundMonetaryAmount(mixed, 1280, mixed).support).toBe("ambiguous");
    const contradicted = groundObligation(
      source,
      "This debt is cancelled",
      "Please pay by 25 November 2026."
    );
    expect(contradicted.support).not.toBe("supports_claim");
    expect(contradicted.verifiedForDisplay).toBeNull();
  });
});

describe("privacy approval is exact, local, and cannot send", () => {
  it("drops the approval when the canonical bytes change and does not take the send lock", () => {
    resetCloudSendStateForTests();
    resetUserApprovalStateForTests();
    const canonical = canonicalCloudPayload(M0_SMOKE_TEST_CLOUD_PAYLOAD);
    const approval = recordUserPayloadApproval(canonical.serialized, canonical.serialized, 1, {});
    expect(CLOUD_SUBMISSION_ENABLED).toBe(false);
    expect(approval.cloudSendEnabled).toBe(false);
    expect(approval.generation).toBe(1);
    expect(approval.boundContext).toBeDefined();
    expect(approvalStillMatches(approval, canonical.serialized, 1, approval.boundContext)).toBe(true);
    expect(approvalStillMatches(approval, canonical.serialized, 1)).toBe(false);
    expect(approvalStillMatches(approval, canonical.serialized.replace("1280", "520"), 1)).toBe(false);
    expect(approvalStillMatches(approval, canonical.serialized, 2)).toBe(false);
    expect(() =>
      recordUserPayloadApproval(canonical.serialized, canonical.serialized.replace("1280", "520"), 1, {})
    ).toThrow(/current canonical payload/);
    expect(() => requestApprovedCloudSend(approval)).toThrow(/not connected/i);
    expect(approvalStillMatches(approval, canonical.serialized, 1)).toBe(false);
    expect(() => requestApprovedCloudSend(approval)).toThrow(/already been used/i);

    const flight = approveCloudPayload(M0_SMOKE_TEST_CLOUD_PAYLOAD);
    expect(flight.begin()).toBe(canonical.serialized);
    expect(() => flight.begin()).toThrow(/not in an approved state/i);
    flight.cancel();
  });

  it("rejects unknown keys, malformed placeholders, and PII before an approval exists", () => {
    resetUserApprovalStateForTests();
    const canonical = canonicalCloudPayload(M0_SMOKE_TEST_CLOUD_PAYLOAD);
    const unknown = canonicalCloudPayload(M0_SMOKE_TEST_CLOUD_PAYLOAD).payload as unknown as Record<
      string,
      unknown
    >;
    const withUnknown = JSON.stringify({ ...unknown, extraNote: "no" });
    expect(() => recordUserPayloadApproval(withUnknown, withUnknown, 1, {})).toThrow(
      /canonical validation/
    );

    const malformed = {
      ...canonical.payload,
      redactedObligations: [
        {
          ...canonical.payload.redactedObligations[0],
          redactedClause: "Please see [NOT_CANONICAL] before you reply.",
        },
      ],
    };
    const malformedSerialized = JSON.stringify(malformed);
    expect(() => recordUserPayloadApproval(malformedSerialized, malformedSerialized, 1, {})).toThrow(
      /malformed placeholder|canonical validation/
    );

    const leaking = {
      ...canonical.payload,
      redactedObligations: [
        {
          ...canonical.payload.redactedObligations[0],
          redactedClause: "Please write to ada@example.com about the balance.",
        },
      ],
    };
    const leakingSerialized = JSON.stringify(leaking);
    expect(() => recordUserPayloadApproval(leakingSerialized, leakingSerialized, 1, {})).toThrow(
      /canonical validation/
    );

    const partial = {
      ...canonical.payload,
      redactedObligations: [
        {
          ...canonical.payload.redactedObligations[0],
          redactedClause: "The saved reference is [RECIPIENT_NAME]-8472 today.",
        },
      ],
    };
    const partialSerialized = JSON.stringify(partial);
    expect(() => recordUserPayloadApproval(partialSerialized, partialSerialized, 1, {})).toThrow(
      /canonical validation|partial identifier/
    );

    const stale = recordUserPayloadApproval(canonical.serialized, canonical.serialized, 4, {});
    expect(approvalStillMatches(stale, canonical.serialized, 5)).toBe(false);
    expect(CLOUD_SUBMISSION_ENABLED).toBe(false);
  });

  it("uses the same forbidden identifiers at approval and at the blocked send", () => {
    resetCloudSendStateForTests();
    resetUserApprovalStateForTests();
    const canonical = canonicalCloudPayload(M0_SMOKE_TEST_CLOUD_PAYLOAD);
    const named = {
      ...canonical.payload,
      redactedObligations: [
        {
          ...canonical.payload.redactedObligations[0]!,
          redactedClause: "Please contact Priya Testperson before the response date.",
        },
      ],
    };
    const serialized = JSON.stringify(named);
    expect(() => recordUserPayloadApproval(serialized, serialized, 1, {})).not.toThrow();
    expect(() =>
      recordUserPayloadApproval(serialized, serialized, 1, {
        forbiddenIdentifiers: ["Priya Testperson"],
      })
    ).toThrow(/canonical validation/);

    const approval = recordUserPayloadApproval(serialized, serialized, 2, {});
    approval.guardOptions.forbiddenIdentifiers?.push("Priya Testperson");
    let sendError = "";
    expect(() => {
      try {
        requestApprovedCloudSend(approval);
      } catch (error) {
        sendError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    }).toThrow(/canonical validation/);
    expect(sendError).not.toMatch(/Priya|Testperson/);
    expect(() => requestApprovedCloudSend(approval)).toThrow(/already been used/i);

    const clean = recordUserPayloadApproval(canonical.serialized, canonical.serialized, 3, {
      forbiddenIdentifiers: ["Priya Testperson"],
      rawNoticeText: "Dear Priya Testperson",
    });
    expect(clean.guardOptions.forbiddenIdentifiers).toEqual(["Priya Testperson"]);
    expect(clean.serialized).toBe(canonical.serialized);
    expect(() => requestApprovedCloudSend(clean)).toThrow(/not connected/i);
    expect(() => requestApprovedCloudSend(clean)).toThrow(/already been used/i);
    const flight = approveCloudPayload(M0_SMOKE_TEST_CLOUD_PAYLOAD);
    expect(flight.begin()).toBe(canonical.serialized);
    flight.cancel();
    expect(CLOUD_SUBMISSION_ENABLED).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { buildCloudBrief } from "../../src/adapters/cloudBriefBuilder";
import {
  recordUserPayloadApproval,
  requestApprovedCloudSend,
  resetUserApprovalStateForTests,
} from "../../src/adapters/privacyApproval";
import { CLOUD_SUBMISSION_ENABLED } from "../../src/adapters/cloudApprovalSession";
import {
  canonicalCloudPayload,
  revalidateFinalCloudPayload,
  validateCloudBoundPayload,
} from "../../src/domain/cloudPayloadGuard";
import { redactAndBuildBrief } from "../../src/domain/redactAndBrief";
import { M0_SMOKE_TEST_CLOUD_PAYLOAD } from "../../src/fixtures/benchmarkNotices";
import type { CloudBoundStructuralPayload } from "../../src/domain/types";

const PAY = "Please pay the outstanding balance of £640 by 2 December 2026.";

function clausePayload(redactedClause: string): CloudBoundStructuralPayload {
  return {
    ...M0_SMOKE_TEST_CLOUD_PAYLOAD,
    redactedObligations: [
      {
        actionSummary: "contact_sender",
        dueDate: "2026-12-02",
        redactedClause,
      },
    ],
  };
}

function missedByBoth(redacted: string, secret: string, clause: string, forbidden: string[]): boolean {
  let guardMissed = false;
  try {
    validateCloudBoundPayload(clausePayload(clause), { forbiddenIdentifiers: forbidden });
    guardMissed = true;
  } catch {
    guardMissed = false;
  }
  return redacted.includes(secret) && guardMissed;
}

describe("M2B-2B local pipeline", () => {
  it("redacts, grounds, and guards a disguised name together with a joined reference", () => {
    resetUserApprovalStateForTests();
    const soft = "Mi\u00ADna Cal\u00ADder";
    const rawNoticeText = [
      "2 December 2026",
      `Dear ${soft},`,
      "Account reference: CALDER5521",
      "Mina wrote to Calder about the supply.",
      "Our records show an outstanding balance of £640 for electricity supplied between March and April 2025.",
      "Thank you for your payment of £1,280.",
      PAY,
    ].join("\n");
    const redaction = redactAndBuildBrief({
      rawNoticeText,
      responseGoal: "request_billing_review",
      guidanceIds: ["ofgem-backbilling-12m-v1"],
      extraKnownIdentifiers: ["Mina Calder"],
      extraction: {
        noticeCategory: "utility_electricity",
        issueDate: "2 December 2026",
        billingPeriod: "March and April 2025",
        amountGBP: 640,
        responseDeadline: "2 December 2026",
        obligations: [{ action: "Pay the stated balance", dueDate: "2 December 2026", sourceQuote: PAY }],
      },
    });
    expect(redaction.ok).toBe(true);
    if (!redaction.ok) {
      return;
    }
    expect(redaction.redactedNoticePreview).not.toContain("Mina");
    expect(redaction.redactedNoticePreview).not.toContain("Calder");
    expect(redaction.redactedNoticePreview).not.toContain("5521");
    expect(redaction.redactedNoticePreview).toContain(
      "[RECIPIENT_NAME] wrote to [RECIPIENT_NAME] about the supply."
    );
    expect(redaction.structuralBrief.amountsGBP).toEqual([640]);
    expect(JSON.stringify(redaction.structuralBrief)).not.toContain("5521");
    expect(JSON.stringify(redaction.structuralBrief)).not.toContain("Mina");

    const inspection = buildCloudBrief({
      rawNoticeText,
      source: {
        noticeCategory: "utility_electricity",
        issueDate: "2 December 2026",
        billingPeriod: "March and April 2025",
        amountGBP: 640,
        amountsGBP: [640],
        responseDeadline: "2 December 2026",
        responseDeadlines: ["2 December 2026"],
        obligations: [{ action: "Pay the stated balance", dueDate: "2 December 2026", sourceQuote: PAY }],
      },
      edits: {
        responseGoal: "request_billing_review",
        circumstanceFlags: [],
        extraKnownIdentifiers: ["Mina Calder"],
      },
    });
    expect(inspection.canonical).not.toBeNull();
    expect(inspection.guardOptions.forbiddenIdentifiers).toEqual(
      expect.arrayContaining(["Mina Calder", soft])
    );
    expect(inspection.exactSerialized).not.toContain("Mina");
    expect(inspection.exactSerialized).not.toContain("5521");
    expect(inspection.exactSerialized).not.toContain("1280");

    const forbidden = inspection.guardOptions.forbiddenIdentifiers ?? [];
    expect(
      missedByBoth(
        redaction.redactedNoticePreview,
        "Mina",
        "Please contact Mina before the response date.",
        forbidden
      )
    ).toBe(false);
    expect(() =>
      validateCloudBoundPayload(clausePayload("Please contact Mina before the response date."), {
        forbiddenIdentifiers: forbidden,
        rawNoticeText,
      })
    ).toThrow(/forbidden local identifier/);
    expect(() =>
      revalidateFinalCloudPayload(clausePayload("The saved reference is CALDER5521 today."), {
        forbiddenIdentifiers: forbidden,
        rawNoticeText,
      })
    ).toThrow(/account reference/);
    expect(() =>
      revalidateFinalCloudPayload(clausePayload("The saved reference is [ACCOUNT_REF]#5521 today."), {
        forbiddenIdentifiers: forbidden,
      })
    ).toThrow(/partial identifier/);

    const canonical = canonicalCloudPayload(inspection.canonical?.payload, inspection.guardOptions);
    expect(canonical.serialized).toBe(inspection.exactSerialized);
    const approval = recordUserPayloadApproval(
      canonical.serialized,
      canonical.serialized,
      1,
      inspection.guardOptions
    );
    expect(approval.serialized).toBe(canonical.serialized);
    expect(approval.guardOptions.forbiddenIdentifiers).toEqual(forbidden);
    expect(() => requestApprovedCloudSend(approval)).toThrow(/not connected/i);
    expect(() => requestApprovedCloudSend(approval)).toThrow(/already been used/i);
    expect(CLOUD_SUBMISSION_ENABLED).toBe(false);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildCloudBrief,
  readableRowsFromPayload,
} from "../../src/adapters/cloudBriefBuilder";
import {
  CLOUD_SUBMISSION_ENABLED,
  createCloudApprovalSession,
  requestCloudSubmission,
} from "../../src/adapters/cloudApprovalSession";
import {
  briefSourceFromGrounded,
  groundNoticeFacts,
} from "../../src/adapters/groundNoticeFacts";
import { CloudSendSafetyError } from "../../src/domain/cloudSendApproval";

const original = readFileSync("examples/energy-backbill-original.txt", "utf8");

describe("cloud brief builder and disabled approval session", () => {
  it("builds a readable inspection and an exact serialized snapshot", () => {
    const view = groundNoticeFacts({ rawNoticeText: original, today: "2026-11-13" });
    const inspection = buildCloudBrief({
      rawNoticeText: original,
      source: briefSourceFromGrounded(view),
      edits: {
        responseGoal: "request_billing_review",
        circumstanceFlags: [],
        extraKnownIdentifiers: [],
      },
    });
    expect(inspection.redaction.ok).toBe(true);
    expect(inspection.declaredComplete).toBe(false);
    expect(inspection.canonical).not.toBeNull();
    expect(inspection.exactSerialized).toBe(inspection.canonical?.serialized);
    expect(inspection.exactSerialized).not.toBe(inspection.formattedInspectionJson);
    expect(inspection.formattedInspectionJson).toContain("\n");
    expect(inspection.exactSerialized).not.toContain("\n");
    expect(inspection.readableRows.map((row) => row.value).join(" ")).toContain("1,280");
    expect(inspection.limitations.join(" ")).toMatch(/does not guarantee/i);
    const amountRow = inspection.readableRows.find((row) => row.label === "Amounts");
    expect(amountRow?.value).toMatch(/1,280/);
  });

  it("labels a missing amount as Not stated and drops an exact snapshot after a leaking edit", () => {
    const text = [
      "18 November 2026",
      "Dear Sarah Example,",
      "Please contact our billing team by 25 November 2026 to discuss your account.",
    ].join("\n");
    const view = groundNoticeFacts({ rawNoticeText: text, today: "2026-11-13" });
    const source = briefSourceFromGrounded(view);
    const inspection = buildCloudBrief({
      rawNoticeText: text,
      source,
      edits: {
        responseGoal: "request_billing_review",
        circumstanceFlags: [],
        extraKnownIdentifiers: ["Sarah Example"],
        clauseReplacements: {
          0: "Please contact Sarah Example before the response date.",
        },
      },
    });
    expect(view.amount.verifiedForDisplay).toBeNull();
    expect(inspection.exactSerialized).toBeNull();
    expect(inspection.violations.join(" ")).toMatch(/forbidden local identifier/i);
    if (inspection.redaction.ok) {
      const rows = readableRowsFromPayload({
        ...inspection.redaction.structuralBrief,
        amountsGBP: [],
      });
      expect(rows.find((row) => row.label === "Amounts")?.value).toBe("Not stated");
    }
  });

  it("refuses cloud submission even when a canonical snapshot exists", () => {
    const view = groundNoticeFacts({ rawNoticeText: original, today: "2026-11-13" });
    const inspection = buildCloudBrief({
      rawNoticeText: original,
      source: briefSourceFromGrounded(view),
      edits: {
        responseGoal: "request_billing_review",
        circumstanceFlags: ["clarify_dates"],
        extraKnownIdentifiers: [],
      },
    });
    const session = createCloudApprovalSession({
      canonical: inspection.canonical,
      violations: inspection.violations,
    });
    expect(CLOUD_SUBMISSION_ENABLED).toBe(false);
    expect(session.cloudSendEnabled).toBe(false);
    expect(session.approval).toBeNull();
    expect(session.blockedReason).toMatch(/not connected/i);
    expect(() => requestCloudSubmission(session)).toThrow(CloudSendSafetyError);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildClosedCloudBrief } from "../../src/adapters/buildClosedCloudBrief";
import {
  CLOUD_SUBMISSION_BLOCKED_REASON,
  CLOUD_SUBMISSION_ENABLED,
  requestCloudSubmission,
} from "../../src/adapters/cloudApprovalSession";
import { briefSourceFromGrounded, groundNoticeFacts } from "../../src/adapters/groundNoticeFacts";
import { actionSummaryLabel } from "../../src/adapters/cloudBriefBuilder";
import { canonicalCloudPayload } from "../../src/domain/cloudPayloadGuard";
import {
  canonicalClosedCloudBrief,
  ClosedCloudBriefValidationError,
  CLOSED_CLOUD_BRIEF_SCHEMA_VERSION,
  TRUSTED_ACTION_SUMMARY_LABELS,
} from "../../src/domain/closedCloudBrief";
import { M0_SMOKE_TEST_CLOUD_PAYLOAD } from "../../src/fixtures/benchmarkNotices";

const TODAY = "2026-11-13";
const original = readFileSync("examples/energy-backbill-original.txt", "utf8");

function validBrief(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
  };
}

describe("closed cloud brief v2", () => {
  it("1. accepts only the allowed root fields and obligation keys", () => {
    const result = canonicalClosedCloudBrief(validBrief());
    expect(Object.keys(result.payload)).toEqual([
      "schemaVersion",
      "noticeCategory",
      "issueDate",
      "billingPeriod",
      "amountsGBP",
      "responseDeadlines",
      "obligations",
      "responseGoal",
      "guidanceIds",
    ]);
    expect(Object.keys(result.payload.obligations[0]!)).toEqual(["actionSummary", "dueDate"]);
    expect(result.payload.schemaVersion).toBe("noticelens.cloud-brief.v2");
  });

  it("2. rejects redactedClause", () => {
    expect(() =>
      canonicalClosedCloudBrief(
        validBrief({
          obligations: [
            {
              actionSummary: "pay_or_contact",
              dueDate: "2026-11-25",
              redactedClause: "Please pay the balance",
            },
          ],
        })
      )
    ).toThrow(ClosedCloudBriefValidationError);
  });

  it("3. rejects sourceQuote", () => {
    expect(() => canonicalClosedCloudBrief(validBrief({ sourceQuote: original }))).toThrow(
      /forbidden key|allowlist/i
    );
  });

  it("4. rejects rawNoticeText", () => {
    expect(() => canonicalClosedCloudBrief(validBrief({ rawNoticeText: original }))).toThrow(
      /forbidden key|allowlist/i
    );
  });

  it("5. rejects names, account references, and addresses", () => {
    expect(() => canonicalClosedCloudBrief(validBrief({ noticeCategory: "Sarah Example" }))).toThrow(
      ClosedCloudBriefValidationError
    );
    expect(() => canonicalClosedCloudBrief(validBrief({ issueDate: "EXAMPLE-8472" }))).toThrow(
      ClosedCloudBriefValidationError
    );
    expect(() =>
      canonicalClosedCloudBrief(validBrief({ issueDate: "14 Example Road, Reading, RG0 0AA" }))
    ).toThrow(ClosedCloudBriefValidationError);
  });

  it("6. rejects identifier maps", () => {
    expect(() =>
      canonicalClosedCloudBrief(
        validBrief({
          localIdentifierMap: { locality: "browser-only", entries: [{ value: "Sarah Example" }] },
        })
      )
    ).toThrow(/forbidden key|allowlist/i);
    expect(() =>
      canonicalClosedCloudBrief(validBrief({ identifierMap: { Sarah: "[RECIPIENT_NAME]" } }))
    ).toThrow(/forbidden key|allowlist/i);
  });

  it("7. rejects placeholders", () => {
    expect(() =>
      canonicalClosedCloudBrief(
        validBrief({
          obligations: [{ actionSummary: "[RECIPIENT_NAME]", dueDate: "[ACCOUNT_REF]" }],
        })
      )
    ).toThrow(ClosedCloudBriefValidationError);
    expect(() => canonicalClosedCloudBrief(validBrief({ guidanceIds: ["[LOCAL_ID]"] }))).toThrow(
      ClosedCloudBriefValidationError
    );
  });

  it("8. rejects free text and unknown properties", () => {
    expect(() =>
      canonicalClosedCloudBrief(validBrief({ note: "Please pay Sarah Example immediately" }))
    ).toThrow(/allowlist/i);
    expect(() =>
      canonicalClosedCloudBrief(
        validBrief({
          obligations: [
            {
              actionSummary: "pay_or_contact",
              dueDate: "2026-11-25",
              comment: "Pay or contact the sender",
            },
          ],
        })
      )
    ).toThrow(/allowlist/i);
    expect(() => canonicalClosedCloudBrief(validBrief({ responseGoal: "Pay the stated balance" }))).toThrow(
      ClosedCloudBriefValidationError
    );
  });

  it("9. requires the exact schema version and rejects v1", () => {
    expect(() => canonicalClosedCloudBrief(M0_SMOKE_TEST_CLOUD_PAYLOAD)).toThrow(/v1 payload is not accepted/i);
    expect(() => canonicalClosedCloudBrief(validBrief({ schemaVersion: "noticelens.cloud-brief.v1" }))).toThrow(
      /v1 payload is not accepted/i
    );
    expect(() => canonicalClosedCloudBrief(validBrief({ schemaVersion: "noticelens.cloud-brief.v3" }))).toThrow(
      ClosedCloudBriefValidationError
    );
    const historical = canonicalCloudPayload(M0_SMOKE_TEST_CLOUD_PAYLOAD);
    expect(historical.payload.schemaVersion).toBe("noticelens.cloud-brief.v1");
    expect(historical.payload.redactedObligations[0]?.redactedClause).toContain("Please pay");
    expect(() => canonicalCloudPayload(validBrief())).toThrow(/schema|allowlist|v1/i);
  });

  it("10. enforces strict limits", () => {
    expect(() =>
      canonicalClosedCloudBrief(
        validBrief({
          obligations: Array.from({ length: 7 }, () => ({
            actionSummary: "contact_sender",
            dueDate: null,
          })),
        })
      )
    ).toThrow(/too many/i);
    expect(() => canonicalClosedCloudBrief(validBrief({ amountsGBP: [1, 2, 3, 4, 5, 6, 7] }))).toThrow(
      /too many/i
    );
    expect(() =>
      canonicalClosedCloudBrief(
        validBrief({
          responseDeadlines: [
            "2026-11-25",
            "2026-11-26",
            "2026-11-27",
            "2026-11-28",
            "2026-11-29",
            "2026-11-30",
            "2026-12-01",
          ],
        })
      )
    ).toThrow(/too many/i);
  });

  it("11. requires ISO dates", () => {
    expect(() => canonicalClosedCloudBrief(validBrief({ issueDate: "18 November 2026" }))).toThrow(
      /ISO calendar date/i
    );
    expect(() => canonicalClosedCloudBrief(validBrief({ issueDate: "2026-02-31" }))).toThrow(
      /ISO calendar date/i
    );
    expect(() =>
      canonicalClosedCloudBrief(validBrief({ billingPeriod: { start: "January 2025", end: "June 2025" } }))
    ).toThrow(/calendar value/i);
    expect(() => canonicalClosedCloudBrief(validBrief({ responseDeadlines: ["2026-11-18"] }))).toThrow(
      /issue date is not a response deadline/i
    );
    const accepted = canonicalClosedCloudBrief(validBrief({ issueDate: null, billingPeriod: null }));
    expect(accepted.payload.issueDate).toBeNull();
    expect(accepted.payload.billingPeriod).toBeNull();
  });

  it("12. enforces finite GBP bounds", () => {
    expect(() => canonicalClosedCloudBrief(validBrief({ amountsGBP: [Number.NaN] }))).toThrow(/non-finite/i);
    expect(() => canonicalClosedCloudBrief(validBrief({ amountsGBP: [Number.POSITIVE_INFINITY] }))).toThrow(
      /non-finite/i
    );
    expect(() => canonicalClosedCloudBrief(validBrief({ amountsGBP: [-0] }))).toThrow(/non-finite/i);
    expect(() => canonicalClosedCloudBrief(validBrief({ amountsGBP: [-520] }))).toThrow(/range/i);
    expect(() => canonicalClosedCloudBrief(validBrief({ amountsGBP: [1.234] }))).toThrow(/range/i);
    expect(() => canonicalClosedCloudBrief(validBrief({ amountsGBP: [1_000_000.01] }))).toThrow(/range/i);
    expect(canonicalClosedCloudBrief(validBrief({ amountsGBP: [1280] })).payload.amountsGBP).toEqual([1280]);
    expect(canonicalClosedCloudBrief(validBrief({ amountsGBP: [] })).payload.amountsGBP).toEqual([]);
  });

  it("13. enforces category-specific guidance", () => {
    expect(() =>
      canonicalClosedCloudBrief(
        validBrief({ guidanceIds: ["citizens-advice-council-tax-reminder-v1"] })
      )
    ).toThrow(/not allowed for this notice category/i);
    expect(() =>
      canonicalClosedCloudBrief(
        validBrief({
          noticeCategory: "other_household_notice",
          guidanceIds: ["ofgem-backbilling-12m-v1"],
        })
      )
    ).toThrow(/not allowed for this notice category/i);
    const council = canonicalClosedCloudBrief(
      validBrief({
        noticeCategory: "council_tax",
        guidanceIds: ["citizens-advice-council-tax-reminder-v1"],
      })
    );
    expect(council.payload.guidanceIds).toEqual(["citizens-advice-council-tax-reminder-v1"]);
  });

  it("14. produces canonical serialization", () => {
    const reversed = {
      guidanceIds: ["ofgem-backbilling-12m-v1"],
      responseGoal: "request_billing_review",
      obligations: [{ dueDate: "2026-11-25", actionSummary: "pay_or_contact" }],
      responseDeadlines: ["2026-11-25"],
      amountsGBP: [1280],
      billingPeriod: { end: "2025-06", start: "2025-01" },
      issueDate: "2026-11-18",
      noticeCategory: "utility_electricity",
      schemaVersion: CLOSED_CLOUD_BRIEF_SCHEMA_VERSION,
    };
    const result = canonicalClosedCloudBrief(reversed);
    expect(result.serialized).toBe(
      JSON.stringify({
        schemaVersion: "noticelens.cloud-brief.v2",
        noticeCategory: "utility_electricity",
        issueDate: "2026-11-18",
        billingPeriod: { start: "2025-01", end: "2025-06" },
        amountsGBP: [1280],
        responseDeadlines: ["2026-11-25"],
        obligations: [{ actionSummary: "pay_or_contact", dueDate: "2026-11-25" }],
        responseGoal: "request_billing_review",
        guidanceIds: ["ofgem-backbilling-12m-v1"],
      })
    );
    expect(JSON.parse(result.serialized)).toEqual(result.payload);
  });

  it("15. returns an immutable detached result", () => {
    const input = validBrief();
    const result = canonicalClosedCloudBrief(input);
    (input.amountsGBP as number[]).push(520);
    (input.obligations as Array<Record<string, unknown>>)[0]!.dueDate = "2026-12-01";
    expect(result.payload.amountsGBP).toEqual([1280]);
    expect(result.payload.obligations[0]?.dueDate).toBe("2026-11-25");
    expect(Object.isFrozen(result.payload)).toBe(true);
    expect(Object.isFrozen(result.payload.obligations)).toBe(true);
    expect(Object.isFrozen(result.payload.obligations[0])).toBe(true);
    expect(() => {
      (result.payload.amountsGBP as number[]).push(1);
    }).toThrow(TypeError);
    expect(result.payload).not.toBe(input);
  });

  it("16. builds v2 from supported grounded facts and copies no notice prose", () => {
    const view = groundNoticeFacts({ rawNoticeText: original, today: TODAY });
    const built = buildClosedCloudBrief({
      view,
      responseGoal: "request_billing_review",
      circumstanceFlags: ["usage_billed_over_12_months"],
    });
    expect(built.payload).toMatchObject({
      schemaVersion: "noticelens.cloud-brief.v2",
      noticeCategory: "utility_electricity",
      issueDate: "2026-11-18",
      billingPeriod: { start: "2025-01", end: "2025-06" },
      amountsGBP: [1280],
      responseDeadlines: ["2026-11-25"],
      responseGoal: "request_billing_review",
      guidanceIds: ["ofgem-backbilling-12m-v1"],
      circumstanceFlags: ["usage_billed_over_12_months"],
    });
    const supported = view.obligations
      .filter((item) => item.headingSupport === "supports_claim" && item.verifiedForDisplay !== null)
      .map((item) => item.verifiedForDisplay);
    expect(supported).toContain("pay_or_contact");
    expect(built.payload.obligations.map((item) => item.actionSummary)).toEqual(supported);
    expect(built.payload.obligations[0]?.dueDate).toBe("2026-11-25");
    const serialized = built.serialized;
    for (const forbidden of [
      "Sarah",
      "EXAMPLE-8472",
      "Example Road",
      "RG0 0AA",
      "Please pay",
      "meter readings",
      "Dear ",
      "[RECIPIENT_NAME]",
      "[ACCOUNT_REF]",
      "sourceQuote",
      "redactedClause",
      "rawNoticeText",
      ...Object.values(TRUSTED_ACTION_SUMMARY_LABELS),
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(actionSummaryLabel("pay_or_contact")).toBe("Pay or contact the sender");
    expect(serialized).toContain("pay_or_contact");

    const historical = groundNoticeFacts({
      rawNoticeText: [
        "Thank you for your payment of £1,280.",
        "Outstanding balance of £520.",
        "Please pay the outstanding balance of £520 by 25 November 2026.",
      ].join("\n"),
      today: TODAY,
    });
    expect(buildClosedCloudBrief({ view: historical, responseGoal: "request_billing_review" }).payload.amountsGBP).toEqual([
      520,
    ]);

    const cancelled = groundNoticeFacts({
      rawNoticeText: "The demand for £1,280 has been cancelled.",
      today: TODAY,
    });
    expect(buildClosedCloudBrief({ view: cancelled, responseGoal: "request_billing_review" }).payload.amountsGBP).toEqual(
      []
    );

    const conditional = groundNoticeFacts({
      rawNoticeText: [
        "Outstanding balance of £1,280.",
        "A late payment fee of £40 may apply if you do not pay.",
        "Please pay the outstanding balance of £1,280 by 25 November 2026.",
      ].join("\n"),
      today: TODAY,
    });
    const conditionalBrief = buildClosedCloudBrief({
      view: conditional,
      responseGoal: "request_billing_review",
    });
    expect(conditionalBrief.payload.amountsGBP).toEqual([1280]);
    expect(conditionalBrief.serialized).not.toContain("40");

    const ambiguous = groundNoticeFacts({
      rawNoticeText: "Please pay £1,280 or the revised £520.",
      today: TODAY,
    });
    expect(ambiguous.amount.verifiedForDisplay).toBeNull();
    expect(briefSourceFromGrounded(ambiguous).amountGBP).toBeNull();
    expect(buildClosedCloudBrief({ view: ambiguous, responseGoal: "request_billing_review" }).payload.amountsGBP).toEqual(
      []
    );

    const issueOnly = groundNoticeFacts({
      rawNoticeText: ["18 November 2026", "Please contact our billing team to discuss your account."].join("\n"),
      today: TODAY,
      extraction: {
        noticeCategory: "utility_electricity",
        issueDate: "18 November 2026",
        billingPeriod: "not stated",
        amountGBP: null,
        responseDeadline: "18 November 2026",
        obligations: [],
      },
    });
    const issueBrief = buildClosedCloudBrief({ view: issueOnly, responseGoal: "request_billing_review" });
    expect(issueBrief.payload.issueDate).toBe("2026-11-18");
    expect(issueBrief.payload.responseDeadlines).toEqual([]);
    expect(issueBrief.payload.amountsGBP).toEqual([]);

    const builderSource = readFileSync("src/adapters/buildClosedCloudBrief.ts", "utf8");
    expect(builderSource).not.toContain("sourceQuote");
    expect(builderSource).not.toContain("clauseReplacements");
    expect(builderSource).not.toContain("redactedClause");
    expect(builderSource).not.toContain("runCloudDraftFromApprovedPayload");
  });

  it("keeps production cloud sending disabled", () => {
    expect(CLOUD_SUBMISSION_ENABLED).toBe(false);
    expect(() =>
      requestCloudSubmission({
        cloudSendEnabled: false,
        approval: null,
        canonical: null,
        violations: [],
        blockedReason: CLOUD_SUBMISSION_BLOCKED_REASON,
      })
    ).toThrow(CLOUD_SUBMISSION_BLOCKED_REASON);
    const production = [
      "src/App.tsx",
      "src/ui/production/NoticeLensApp.tsx",
      "src/ui/screens/PrepareReplyScreen.tsx",
      "src/adapters/buildClosedCloudBrief.ts",
      "src/domain/closedCloudBrief.ts",
    ]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(production).not.toContain("runCloudDraftFromApprovedPayload");
    expect(readFileSync("src/ui/screens/PrepareReplyScreen.tsx", "utf8")).toMatch(
      /data-testid="cloud-send-button"\s+disabled/
    );
    expect(readFileSync("src/adapters/cloudApprovalSession.ts", "utf8")).toContain(
      "export const CLOUD_SUBMISSION_ENABLED = false as const"
    );
  });
});

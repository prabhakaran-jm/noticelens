import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildClosedCloudInspection } from "../../src/adapters/closedCloudInspection";
import {
  identifierContextKey,
  privacyApprovalView,
  recordClosedBriefApproval,
  requestApprovedCloudSend,
  requestClosedBriefSend,
  resetUserApprovalStateForTests,
} from "../../src/adapters/privacyApproval";
import {
  CLOUD_SUBMISSION_ENABLED,
  requestCloudSubmission,
} from "../../src/adapters/cloudApprovalSession";
import { groundNoticeFacts } from "../../src/adapters/groundNoticeFacts";
import {
  canonicalClosedCloudBrief,
  ClosedCloudBriefValidationError,
  CLOSED_CLOUD_BRIEF_SCHEMA_VERSION,
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

describe("D1 closed-schema accessors and proxies", () => {
  it("rejects accessor properties on responseGoal, actionSummary, and numeric or date fields", () => {
    const goal = validBrief();
    Object.defineProperty(goal, "responseGoal", {
      enumerable: true,
      configurable: true,
      get: () => "request_billing_review",
    });
    expect(() => canonicalClosedCloudBrief(goal)).toThrow(/own data property/i);

    const action = validBrief();
    Object.defineProperty((action.obligations as object[])[0]!, "actionSummary", {
      enumerable: true,
      configurable: true,
      get: () => "pay_or_contact",
    });
    expect(() => canonicalClosedCloudBrief(action)).toThrow(/own data property/i);

    const amounts = [1280];
    Object.defineProperty(amounts, "0", {
      enumerable: true,
      configurable: true,
      get: () => 1280,
    });
    expect(() => canonicalClosedCloudBrief(validBrief({ amountsGBP: amounts }))).toThrow(/own data property/i);

    const dated = validBrief();
    Object.defineProperty(dated, "issueDate", {
      enumerable: true,
      configurable: true,
      get: () => "2026-11-18",
    });
    expect(() => canonicalClosedCloudBrief(dated)).toThrow(/own data property/i);
  });

  it("rejects a proxy that changes a field between reads", () => {
    let flip = false;
    const proxy = new Proxy(validBrief(), {
      getOwnPropertyDescriptor(target, prop) {
        if (prop === "responseGoal") {
          flip = !flip;
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: flip ? "request_billing_review" : "confirm_payment_plan_options",
          };
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });
    expect(() => canonicalClosedCloudBrief(proxy)).toThrow(ClosedCloudBriefValidationError);
  });

  it("rejects a proxy that throws during introspection", () => {
    const proxy = new Proxy(validBrief(), {
      getOwnPropertyDescriptor() {
        throw new Error("unsafe trap");
      },
    });
    expect(() => canonicalClosedCloudBrief(proxy)).toThrow(/cannot be read safely/i);
  });

  it("keeps the approved bytes stable after the source object changes", () => {
    resetUserApprovalStateForTests();
    const input = validBrief();
    const canonical = canonicalClosedCloudBrief(input);
    const approval = recordClosedBriefApproval(canonical.serialized, canonical.serialized, 3, {
      forbiddenIdentifiers: ["Sarah Example"],
    });
    (input.amountsGBP as number[]).push(520);
    (input.obligations as Array<Record<string, unknown>>)[0]!.dueDate = "2026-12-01";
    expect(approval.serialized).toBe(canonical.serialized);
    expect(approval.serialized).toContain("1280");
    expect(approval.serialized).not.toContain("520");
    expect(approval.cloudSendEnabled).toBe(false);
  });
});

describe("D2 inherited properties and prototype pollution", () => {
  it("rejects a payload whose required fields are inherited", () => {
    const child = Object.create(validBrief());
    expect(() => canonicalClosedCloudBrief(child)).toThrow(/inherited/i);
  });

  it("rejects an inherited billing period and an inherited obligation field", () => {
    const payload = validBrief();
    payload.billingPeriod = Object.create({ start: "2025-01", end: "2025-06" });
    expect(() => canonicalClosedCloudBrief(payload)).toThrow(/inherited/i);

    const obligations = validBrief();
    (obligations.obligations as object[])[0] = Object.create({
      actionSummary: "pay_or_contact",
      dueDate: "2026-11-25",
    });
    expect(() => canonicalClosedCloudBrief(obligations)).toThrow(/inherited/i);
  });

  it("does not accept a value placed on Object.prototype", () => {
    Object.defineProperty(Object.prototype, "responseGoal", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: "confirm_payment_plan_options",
    });
    try {
      const payload = validBrief();
      delete payload.responseGoal;
      expect(() => canonicalClosedCloudBrief(payload)).toThrow(/inherited/i);
    } finally {
      delete (Object.prototype as { responseGoal?: unknown }).responseGoal;
    }
    expect("responseGoal" in {}).toBe(false);
  });

  it("rejects an own constructor pollution property", () => {
    const payload = validBrief();
    Object.defineProperty(payload, "constructor", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: { prototype: { noticeCategory: "council_tax" } },
    });
    expect(() => canonicalClosedCloudBrief(payload)).toThrow(/forbidden key/i);
  });
});

describe("D3 canonical order, duplicates, and limits", () => {
  it("rejects duplicate amounts and duplicate obligations", () => {
    expect(() => canonicalClosedCloudBrief(validBrief({ amountsGBP: [1280, 1280] }))).toThrow(/duplicates an amount/i);
    expect(() =>
      canonicalClosedCloudBrief(
        validBrief({
          obligations: [
            { actionSummary: "pay_or_contact", dueDate: "2026-11-25" },
            { actionSummary: "pay_or_contact", dueDate: "2026-11-25" },
          ],
        })
      )
    ).toThrow(/duplicates an action/i);
  });

  it("serializes equivalent payloads to the same bytes in deterministic order", () => {
    const forward = validBrief({
      amountsGBP: [520, 1280],
      responseDeadlines: ["2026-12-01", "2026-11-25"],
      obligations: [
        { actionSummary: "provide_records", dueDate: "2026-11-25" },
        { actionSummary: "contact_sender", dueDate: null },
      ],
      circumstanceFlags: ["clarify_dates", "usage_billed_over_12_months"],
    });
    const backward = validBrief({
      amountsGBP: [1280, 520],
      responseDeadlines: ["2026-11-25", "2026-12-01"],
      obligations: [
        { actionSummary: "contact_sender", dueDate: null },
        { actionSummary: "provide_records", dueDate: "2026-11-25" },
      ],
      circumstanceFlags: ["usage_billed_over_12_months", "clarify_dates"],
    });
    const first = canonicalClosedCloudBrief(forward);
    const second = canonicalClosedCloudBrief(backward);
    expect(first.serialized).toBe(second.serialized);
    expect(first.payload.amountsGBP).toEqual([520, 1280]);
    expect(first.payload.responseDeadlines).toEqual(["2026-11-25", "2026-12-01"]);
    expect(first.payload.obligations.map((item) => item.actionSummary)).toEqual([
      "contact_sender",
      "provide_records",
    ]);
    const source = forward.amountsGBP as number[];
    source.push(40);
    expect(first.serialized).toBe(second.serialized);
    expect(first.serialized).not.toContain("40");
  });

  it("still rejects an over-long amount list", () => {
    expect(() => canonicalClosedCloudBrief(validBrief({ amountsGBP: [1, 2, 3, 4, 5, 6, 7] }))).toThrow(/too many/i);
  });
});

describe("production v2 inspection and approval", () => {
  it("shows the exact v2 bytes, labels actions outside the JSON, and does not show £0", () => {
    const view = groundNoticeFacts({ rawNoticeText: original, today: TODAY });
    const inspection = buildClosedCloudInspection({
      rawNoticeText: original,
      view,
      responseGoal: "request_billing_review",
      circumstanceFlags: ["usage_billed_over_12_months"],
    });
    expect(inspection.exactSerialized?.startsWith('{"schemaVersion":"noticelens.cloud-brief.v2"')).toBe(true);
    expect(inspection.exactSerialized).toBe(inspection.canonical?.serialized);
    expect(inspection.exactSerialized).not.toContain("\n");
    expect(inspection.formattedInspectionJson).toContain("\n");
    expect(inspection.exactSerialized).not.toContain("Sarah");
    expect(inspection.exactSerialized).not.toContain("Please pay");
    expect(inspection.exactSerialized).not.toContain("redactedClause");
    expect(inspection.exactSerialized).not.toContain("Label, not a quotation");
    const action = inspection.readableRows.find((row) => row.label.startsWith("Action label"));
    expect(action?.value).toContain("Pay or contact the sender");
    expect(action?.value).toContain("Label, not a quotation");
    expect(inspection.limitations.join(" ")).toMatch(/does not establish that a payment obligation is correct/i);
    expect(inspection.readableRows.find((row) => row.label === "Amounts")?.value).toMatch(/1,280/);

    const blank = groundNoticeFacts({
      rawNoticeText: "Please contact our billing team to discuss the account.",
      today: TODAY,
    });
    const emptyAmount = buildClosedCloudInspection({
      rawNoticeText: "Please contact our billing team to discuss the account.",
      view: blank,
      responseGoal: "request_billing_review",
    });
    expect(emptyAmount.readableRows.find((row) => row.label === "Amounts")?.value).toBe("Not stated");
    expect(emptyAmount.readableRows.map((row) => row.value).join(" ")).not.toContain("£0");
  });

  it("labels a conditional fee unverified and keeps it out of amountsGBP", () => {
    const text = [
      "Outstanding balance of £1,280.",
      "A late payment fee of £40 may apply if you do not pay.",
      "Please pay the outstanding balance of £1,280 by 25 November 2026.",
    ].join("\n");
    const view = groundNoticeFacts({ rawNoticeText: text, today: TODAY });
    const inspection = buildClosedCloudInspection({
      rawNoticeText: text,
      view,
      responseGoal: "request_billing_review",
    });
    expect(inspection.canonical?.payload.amountsGBP).toEqual([1280]);
    expect(inspection.exactSerialized).not.toContain("40");
    expect(inspection.readableRows.find((row) => row.label === "Amount status")?.value).toBe("Unverified");
  });

  it("binds approval to the exact bytes, generation, and identifier context, and still refuses to send", () => {
    resetUserApprovalStateForTests();
    const view = groundNoticeFacts({ rawNoticeText: original, today: TODAY });
    const inspection = buildClosedCloudInspection({
      rawNoticeText: original,
      view,
      responseGoal: "request_billing_review",
    });
    const serialized = inspection.exactSerialized ?? "";
    expect(() => recordClosedBriefApproval(JSON.stringify(M0_SMOKE_TEST_CLOUD_PAYLOAD), JSON.stringify(M0_SMOKE_TEST_CLOUD_PAYLOAD), 1, inspection.guardOptions)).toThrow(
      /canonical validation/i
    );
    expect(() => recordClosedBriefApproval(serialized.replace("1280", "520"), serialized, 1, inspection.guardOptions)).toThrow(
      /current canonical payload/i
    );
    const approval = recordClosedBriefApproval(serialized, serialized, 4, inspection.guardOptions);
    expect(approval.serialized).toBe(serialized);
    expect(approval.identifierContext).toBe(identifierContextKey(inspection.guardOptions));
    expect(
      privacyApprovalView({
        serialized,
        limitations: inspection.limitations,
        approval,
        generation: 4,
        guardOptions: inspection.guardOptions,
      }).matchesCurrentPayload
    ).toBe(true);
    expect(
      privacyApprovalView({
        serialized,
        limitations: inspection.limitations,
        approval,
        generation: 5,
        guardOptions: inspection.guardOptions,
      }).matchesCurrentPayload
    ).toBe(false);
    expect(
      privacyApprovalView({
        serialized,
        limitations: inspection.limitations,
        approval,
        generation: 4,
        guardOptions: { forbiddenIdentifiers: ["forged-context"] },
      }).matchesCurrentPayload
    ).toBe(false);
    expect(CLOUD_SUBMISSION_ENABLED).toBe(false);
    expect(() => requestCloudSubmission({
      cloudSendEnabled: false,
      approval: null,
      canonical: null,
      violations: [],
      blockedReason: "Cloud submission is not connected.",
    })).toThrow(/not connected/i);
    expect(() => requestClosedBriefSend(approval)).toThrow(/not connected/i);
    expect(() => requestClosedBriefSend(approval)).toThrow(/already been used/i);
    expect(() => requestApprovedCloudSend(approval)).toThrow(/already been used/i);
  });

  it("does not import the cloud drafter from the production path", () => {
    const production = [
      "src/App.tsx",
      "src/ui/production/NoticeLensApp.tsx",
      "src/ui/screens/PrepareReplyScreen.tsx",
      "src/ui/privacy/PrivacyApprovalModal.tsx",
      "src/adapters/closedCloudInspection.ts",
      "src/adapters/buildClosedCloudBrief.ts",
    ]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(production).not.toContain("runCloudDraftFromApprovedPayload");
    expect(production).not.toContain("clauseReplacements");
    expect(production).not.toContain("from \"firebase");
    expect(readFileSync("src/adapters/cloudApprovalSession.ts", "utf8")).toContain(
      "export const CLOUD_SUBMISSION_ENABLED = false as const"
    );
  });
});

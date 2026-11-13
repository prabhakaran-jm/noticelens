import { describe, expect, it } from "vitest";
import {
  CloudPayloadValidationError,
  revalidateFinalCloudPayload,
  validateCloudBoundPayload,
} from "../../src/domain/cloudPayloadGuard";
import {
  BENCHMARK_NOTICE_FIXTURES,
  M0_SMOKE_TEST_CLOUD_PAYLOAD,
} from "../../src/fixtures/benchmarkNotices";

const guard = {
  rawNoticeText: BENCHMARK_NOTICE_FIXTURES[0]!.rawText,
  forbiddenIdentifiers: BENCHMARK_NOTICE_FIXTURES[0]!.forbiddenPiiTokens,
};

describe("revalidateFinalCloudPayload — final payload after user edits", () => {
  it("accepts the unchanged M0 brief and freezes the approved copy", () => {
    const approved = revalidateFinalCloudPayload(M0_SMOKE_TEST_CLOUD_PAYLOAD, guard);
    expect(approved).toEqual(M0_SMOKE_TEST_CLOUD_PAYLOAD);
    expect(Object.isFrozen(approved)).toBe(true);
    expect(() => {
      approved.issueDate = "1 January 2026";
    }).toThrow(TypeError);
  });

  it("accepts an edited clause and allowlisted circumstance flags", () => {
    const approved = revalidateFinalCloudPayload({
      ...M0_SMOKE_TEST_CLOUD_PAYLOAD,
      circumstanceFlags: [
        "usage_billed_over_12_months",
        "previously_provided_meter_readings",
      ],
      redactedObligations: [
        {
          actionSummary: "Ask for a calculation breakdown",
          dueDate: "25 November 2026",
          redactedClause: "Please contact the billing team about the stated balance.",
        },
      ],
    });
    expect(approved.circumstanceFlags).toEqual([
      "usage_billed_over_12_months",
      "previously_provided_meter_readings",
    ]);
    expect(approved.redactedObligations[0]?.redactedClause).toContain("billing team");
  });

  it("rejects a user edit that puts a local identifier back into the brief", () => {
    expect(() =>
      revalidateFinalCloudPayload(
        {
          ...M0_SMOKE_TEST_CLOUD_PAYLOAD,
          redactedObligations: [
            {
              actionSummary: "Discuss the account",
              dueDate: "25 November 2026",
              redactedClause: "Please review account Sarah Example before the deadline.",
            },
          ],
        },
        guard
      )
    ).toThrow(/forbidden local identifier/);
  });

  it("rejects a zero-width or spacing disguise of a known identifier", () => {
    expect(() =>
      revalidateFinalCloudPayload(
        {
          ...M0_SMOKE_TEST_CLOUD_PAYLOAD,
          billingPeriod: "January to June 2025 RG0\u200B0AA",
        },
        guard
      )
    ).toThrow(CloudPayloadValidationError);
  });

  it("rejects extra keys, duplicate guidance, unknown flags, and non-JSON values", () => {
    expect(() =>
      revalidateFinalCloudPayload({
        ...M0_SMOKE_TEST_CLOUD_PAYLOAD,
        rawNoticeText: "should never leave the browser",
      })
    ).toThrow(/not on the allowlist/);

    expect(() =>
      revalidateFinalCloudPayload({
        ...M0_SMOKE_TEST_CLOUD_PAYLOAD,
        guidanceIds: ["ofgem-backbilling-12m-v1", "ofgem-backbilling-12m-v1"],
      })
    ).toThrow(/duplicates/);

    expect(() =>
      revalidateFinalCloudPayload({
        ...M0_SMOKE_TEST_CLOUD_PAYLOAD,
        circumstanceFlags: ["free text about Sarah"],
      })
    ).toThrow(/circumstance flag/);

    expect(() =>
      revalidateFinalCloudPayload({
        ...M0_SMOKE_TEST_CLOUD_PAYLOAD,
        amountGBP: Number.NaN,
      })
    ).toThrow(/finite JSON number|amountGBP/);

    const withFunction = {
      ...M0_SMOKE_TEST_CLOUD_PAYLOAD,
      redactedObligations: [
        {
          ...M0_SMOKE_TEST_CLOUD_PAYLOAD.redactedObligations[0]!,
          redactedClause: () => "dropped",
        },
      ],
    };
    expect(() => revalidateFinalCloudPayload(withFunction)).toThrow(/not a JSON value/);
  });

  it("does not accept a JSON __proto__ key as a silent prototype change", () => {
    const parsed = JSON.parse(
      `{"__proto__":{"polluted":true},${JSON.stringify(M0_SMOKE_TEST_CLOUD_PAYLOAD).slice(1)}`
    ) as Record<string, unknown>;
    expect(() => revalidateFinalCloudPayload(parsed)).toThrow(CloudPayloadValidationError);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("still accepts the original smoke payload through the M0 validator", () => {
    expect(validateCloudBoundPayload(M0_SMOKE_TEST_CLOUD_PAYLOAD)).toEqual(
      M0_SMOKE_TEST_CLOUD_PAYLOAD
    );
  });
});

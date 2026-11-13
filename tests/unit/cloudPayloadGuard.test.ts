import { describe, expect, it } from "vitest";
import {
  CloudPayloadValidationError,
  validateCloudBoundPayload,
} from "../../src/domain/cloudPayloadGuard";
import {
  BENCHMARK_NOTICE_FIXTURES,
  M0_SMOKE_TEST_CLOUD_PAYLOAD,
} from "../../src/fixtures/benchmarkNotices";

describe("validateCloudBoundPayload — strict runtime allowlist", () => {
  it("accepts a clean structural brief without claiming redaction is complete", () => {
    const validated = validateCloudBoundPayload(M0_SMOKE_TEST_CLOUD_PAYLOAD, {
      rawNoticeText: BENCHMARK_NOTICE_FIXTURES[0]!.rawText,
      forbiddenIdentifiers: BENCHMARK_NOTICE_FIXTURES[0]!.forbiddenPiiTokens,
    });
    expect(validated).toEqual(M0_SMOKE_TEST_CLOUD_PAYLOAD);
  });

  it("rejects any extra/unknown root key or nested obligation key", () => {
    expect(() =>
      validateCloudBoundPayload({
        ...M0_SMOKE_TEST_CLOUD_PAYLOAD,
        rawDocumentText: "secret",
      })
    ).toThrow(CloudPayloadValidationError);

    expect(() =>
      validateCloudBoundPayload({
        ...M0_SMOKE_TEST_CLOUD_PAYLOAD,
        redactedObligations: [
          {
            ...M0_SMOKE_TEST_CLOUD_PAYLOAD.redactedObligations[0]!,
            localEntityMap: {},
          },
        ],
      })
    ).toThrow(/not on allowlist/);
  });

  it("rejects UK postcodes, account references, street addresses, salutations, emails, and phones", () => {
    const piiPayloads = [
      {
        label: "UK postcode",
        clause: "Supply address postcode RG0 0AA requires review.",
      },
      {
        label: "Account reference token",
        clause: "Account reference: EXAMPLE-8472 has an overdue balance.",
      },
      {
        label: "Street address",
        clause: "Electricity supplied to 14 Example Road in Reading.",
      },
      {
        label: "Salutation name",
        clause: "Dear Sarah Example, please pay your balance.",
      },
      {
        label: "Email",
        clause: "Reply to sarah.example@example.org before the deadline.",
      },
      {
        label: "UK phone",
        clause: "Call customer on 07700 900123 regarding meter readings.",
      },
    ];

    for (const sample of piiPayloads) {
      expect(
        () =>
          validateCloudBoundPayload({
            ...M0_SMOKE_TEST_CLOUD_PAYLOAD,
            redactedObligations: [
              {
                actionSummary: "review_stated_obligation",
                dueDate: "2026-11-25",
                redactedClause: sample.clause,
              },
            ],
          }),
        `Expected ${sample.label} to be rejected`
      ).toThrow(CloudPayloadValidationError);
    }
  });

  it("rejects caller-supplied forbidden local identifiers even without regex pattern match", () => {
    expect(() =>
      validateCloudBoundPayload(
        {
          ...M0_SMOKE_TEST_CLOUD_PAYLOAD,
          redactedObligations: [
            {
              actionSummary: "contact_sender",
              dueDate: "2026-11-30",
              redactedClause: "Please contact Testperson before the response date.",
            },
          ],
        },
        {
          forbiddenIdentifiers: ["Priya Testperson", "Testperson"],
        }
      )
    ).toThrow(/forbidden local identifier/);
  });

  it("enforces strict string length, clause length, and numeric bounds", () => {
    expect(() =>
      validateCloudBoundPayload({
        ...M0_SMOKE_TEST_CLOUD_PAYLOAD,
        amountsGBP: [-10],
      })
    ).toThrow(/amountsGBP/);

    expect(() =>
      validateCloudBoundPayload({
        ...M0_SMOKE_TEST_CLOUD_PAYLOAD,
        redactedObligations: [
          {
            actionSummary: "Check bill",
            dueDate: null,
            redactedClause: "x".repeat(250),
          },
        ],
      })
    ).toThrow(/redactedClause/);
  });
});

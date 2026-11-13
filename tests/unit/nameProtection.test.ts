import { describe, expect, it } from "vitest";
import { validateCloudBoundPayload } from "../../src/domain/cloudPayloadGuard";
import { redactAndBuildBrief } from "../../src/domain/redactAndBrief";
import { M0_SMOKE_TEST_CLOUD_PAYLOAD } from "../../src/fixtures/benchmarkNotices";
import {
  compactIdentifier,
  identifierLeaks,
  replaceNameComponent,
  replacePersonalName,
} from "../../src/domain/textNormalize";
import type { CloudBoundStructuralPayload } from "../../src/domain/types";

function clausePayload(redactedClause: string): CloudBoundStructuralPayload {
  return {
    ...M0_SMOKE_TEST_CLOUD_PAYLOAD,
    redactedObligations: [
      {
        actionSummary: "contact_sender",
        dueDate: "2026-11-25",
        redactedClause,
      },
    ],
  };
}

function noticeWith(lines: string[]): string {
  return lines.join("\n");
}

function briefFrom(rawNoticeText: string, quote: string, extraKnownIdentifiers?: string[]) {
  return redactAndBuildBrief({
    rawNoticeText,
    responseGoal: "request_billing_review",
    guidanceIds: ["ofgem-backbilling-12m-v1"],
    extraKnownIdentifiers,
    extraction: {
      noticeCategory: "utility_electricity",
      issueDate: "18 November 2026",
      billingPeriod: "January and June 2025",
      amountGBP: rawNoticeText.includes("£1,280") ? 1280 : null,
      responseDeadline: "25 November 2026",
      obligations: [
        {
          action: "Contact the sender",
          dueDate: "25 November 2026",
          sourceQuote: quote,
        },
      ],
    },
  });
}

function expectRejected(clause: string, name: string): void {
  expect(() =>
    validateCloudBoundPayload(clausePayload(clause), { forbiddenIdentifiers: [name] })
  ).toThrow(/forbidden local identifier/);
  expect(identifierLeaks(clause, name)).toBe(true);
}

function expectAllowed(clause: string, name: string): void {
  expect(() =>
    validateCloudBoundPayload(clausePayload(clause), { forbiddenIdentifiers: [name] })
  ).not.toThrow();
  expect(identifierLeaks(clause, name)).toBe(false);
}

describe("N-1 exact-occurrence name protection", () => {
  it("M07 protects standalone Bill beside the bill and leaves billing", () => {
    expectRejected(
      "Please ask Bill to pay the bill before the response date.",
      "Bill Payer"
    );
    expectAllowed(
      "Please contact the billing team before the response date.",
      "Bill Payer"
    );
    expectAllowed("Please pay the bill before the response date.", "Bill Payer");

    const quote = "Please ask Bill to pay the bill before 25 November 2026.";
    const result = briefFrom(
      noticeWith([
        "18 November 2026",
        "Dear Bill Payer,",
        quote,
        "Account reference: EXAMPLE-8472",
        "Our records show an outstanding balance of £1,280 for electricity supplied between January and June 2025.",
        "Please contact the billing team by 25 November 2026.",
      ]),
      quote
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const clause = result.structuralBrief.redactedObligations[0]?.redactedClause ?? "";
    expect(clause).not.toMatch(/\bBill\b/);
    expect(clause).toContain("the bill");
    expect(result.redactedNoticePreview).toContain("billing team");
    expect(result.redactedNoticePreview).not.toMatch(/\bBill\b/);
  });

  it("M08 protects standalone Energy beside energy supply", () => {
    expectRejected(
      "Please ask Energy about the energy supply before the response date.",
      "Sarah Energy"
    );
    expectAllowed(
      "Please review the energy supply before the response date.",
      "Sarah Energy"
    );

    const quote = "Please ask Energy about the energy supply before 25 November 2026.";
    const result = briefFrom(
      noticeWith([
        "18 November 2026",
        "Dear Sarah Energy,",
        quote,
        "Account reference: EXAMPLE-8472",
        "Our records show an outstanding balance of £1,280 for electricity supplied between January and June 2025.",
      ]),
      quote
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const clause = result.structuralBrief.redactedObligations[0]?.redactedClause ?? "";
    expect(clause).toContain("energy supply");
    expect(clause).not.toMatch(/\bEnergy\b/);
    expect(result.redactedNoticePreview).toContain("Dear [RECIPIENT_NAME]");
  });

  it("M09 does not let a nearby bill phrase exempt the person named Bill", () => {
    const nearby = "Bill wrote today. Please pay the bill before the response date.";
    expectRejected(nearby, "Bill Payer");
    expect(
      replaceNameComponent(nearby, "Bill", "[RECIPIENT_NAME]").startsWith("[RECIPIENT_NAME]")
    ).toBe(true);
    expect(replaceNameComponent(nearby, "Bill", "[RECIPIENT_NAME]")).toContain("the bill");
  });

  it("leaves ordinary billing, annual, problem, and energy billing phrases", () => {
    expectAllowed("The annual amount is due before the response date.", "Ann Example");
    expectRejected("Please contact Ann before the response date.", "Ann Example");
    expectAllowed(
      "There is a problem with the stated balance before the date.",
      "Rob Sample"
    );
    expectRejected("Please contact Rob before the response date.", "Rob Sample");
    expectAllowed(
      "Please review energy billing before the response date.",
      "Alex Energy"
    );

    const quote = "Please review energy billing before 25 November 2026.";
    const energy = briefFrom(
      noticeWith([
        "18 November 2026",
        "Dear Alex Energy,",
        quote,
        "Account reference: EXAMPLE-8472",
      ]),
      quote
    );
    expect(energy.ok).toBe(true);
    if (energy.ok) {
      expect(energy.structuralBrief.redactedObligations[0]?.redactedClause).toContain(
        "energy billing"
      );
      expect(energy.redactedNoticePreview).toContain("Dear [RECIPIENT_NAME]");
    }
  });
});

describe("N-2 compact and normalised name matching", () => {
  it("G16 rejects a known name with a zero-width space inside the letters", () => {
    const disguised = "Please contact Sar\u200Bah Example before the response date.";
    expectRejected(disguised, "Sarah Example");
    expect(
      compactIdentifier(replacePersonalName(disguised, "Sarah Example", "[RECIPIENT_NAME]"))
    ).not.toContain("sarahexample");
  });

  it("G19c rejects a letter-spaced known name", () => {
    const disguised = "Please contact S a r a h E x a m p l e before the response date.";
    expectRejected(disguised, "Sarah Example");
    const redacted = replacePersonalName(disguised, "Sarah Example", "[RECIPIENT_NAME]");
    expect(compactIdentifier(redacted)).not.toContain("sarahexample");
    expect(redacted).toContain("[RECIPIENT_NAME]");
    expect(redacted).toContain("contact");
  });

  it("Z1 rejects a word-joiner disguise and Z2 a soft-hyphen disguise", () => {
    expectRejected(
      "Please contact Sar\u2060ah Example before the response date.",
      "Sarah Example"
    );
    expectRejected(
      "Please contact Sar\u00ADah Ex\u00ADample before the response date.",
      "Sarah Example"
    );
  });

  it("redacts zero-width and letter-spaced copies when the name is known", () => {
    const quote =
      "Please contact Sar\u200Bah Example and S a r a h E x a m p l e before 25 November 2026.";
    const result = briefFrom(
      noticeWith([
        "18 November 2026",
        "Dear Sarah Example,",
        quote,
        "Account reference: EXAMPLE-8472",
        "Our records show an outstanding balance of £1,280 for electricity supplied between January and June 2025.",
      ]),
      quote,
      ["Sarah Example"]
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(compactIdentifier(result.redactedNoticePreview)).not.toContain("sarahexample");
    expect(
      compactIdentifier(result.structuralBrief.redactedObligations[0]?.redactedClause ?? "")
    ).not.toContain("sarahexample");
  });
});

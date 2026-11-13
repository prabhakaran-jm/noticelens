import { afterEach, describe, expect, it } from "vitest";
import { acceptCloudCallResult, CloudDeliveryStoppedError } from "../../src/ai/cloudCallDelivery";
import { runCloudDraftFromApprovedPayload } from "../../src/ai/cloudDrafter";
import { CloudOutputValidationError, validateCloudDraftOutput } from "../../src/domain/cloudOutputGuard";
import { validateCloudBoundPayload } from "../../src/domain/cloudPayloadGuard";
import {
  approveCloudPayload,
  resetCloudSendStateForTests,
} from "../../src/domain/cloudSendApproval";
import { createReplyDraftState, editLocalDraft } from "../../src/domain/personaliseDraft";
import { redactAndBuildBrief } from "../../src/domain/redactAndBrief";
import { M0_SMOKE_TEST_CLOUD_PAYLOAD } from "../../src/fixtures/benchmarkNotices";
import type { CloudBoundStructuralPayload, CloudDraftOutput } from "../../src/domain/types";

const PAY_QUOTE =
  "Please pay the balance or contact our billing team by 25 November 2026 to discuss your account.";

function noticeWith(lines: string[]): string {
  return lines.join("\n");
}

function briefFrom(rawNoticeText: string, quote: string) {
  return redactAndBuildBrief({
    rawNoticeText,
    responseGoal: "request_billing_review",
    guidanceIds: ["ofgem-backbilling-12m-v1"],
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

const acceptedCloudOutput = (): CloudDraftOutput => ({
  summaryPlainEnglish: "You can ask for a breakdown of the stated balance.",
  options: [
    {
      title: "Ask for a review",
      rationale: "A review may be relevant if the dates qualify.",
      applicableCondition: "Only if the supplier confirms the dates.",
    },
  ],
  replyTemplateWithPlaceholders: "Dear [RECIPIENT_NAME]",
  citedGuidanceIds: ["ofgem-backbilling-12m-v1"],
});

describe("review probes — unicode dashes, name parts, long numbers, delivery, placeholders", () => {
  afterEach(() => {
    resetCloudSendStateForTests();
  });

  it("U1 redacts a unicode-dash account reference without leaving the digit tail", () => {
    const dash = "\u2011";
    const rawNoticeText = noticeWith([
      "18 November 2026",
      "Dear Sarah Example,",
      `Account reference: EXAMPLE${dash}8472`,
      "14 Example Road, Reading, RG0 0AA",
      "Our records show an outstanding balance of £1,280 for electricity supplied between January and June 2025.",
      PAY_QUOTE,
    ]);
    const result = briefFrom(rawNoticeText, PAY_QUOTE);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.redactedNoticePreview).not.toContain("8472");
    expect(result.redactedNoticePreview).not.toContain(`EXAMPLE${dash}`);
    expect(result.redactedNoticePreview).toContain("[ACCOUNT_REF]");
    expect(JSON.stringify(result.structuralBrief)).not.toContain("8472");

    expect(() =>
      validateCloudBoundPayload(
        clausePayload(`The saved reference is [ACCOUNT_REF]${dash}8472 today.`),
        { forbiddenIdentifiers: ["EXAMPLE-8472"] }
      )
    ).toThrow(/partial identifier/);
  });

  it.each([
    ["G17a", "\u2010"],
    ["G17b", "\u2011"],
    ["G17c", "\u2013"],
    ["G17d", "\u2014"],
  ])("%s rejects the same account reference when the dash is %s", (_probe, dash) => {
    expect(() =>
      validateCloudBoundPayload(
        clausePayload(`The reference EXAMPLE${dash}8472 is still present today.`),
        { forbiddenIdentifiers: ["EXAMPLE-8472"] }
      )
    ).toThrow(/account reference|forbidden local identifier/);
  });

  it("R02 protects a known name component and leaves an unrelated word", () => {
    const rawNoticeText = noticeWith([
      "18 November 2026",
      "Dear Sarah Example,",
      "Please contact Sarah before 25 November 2026 about the balance.",
      "Account reference: EXAMPLE-8472",
    ]);
    const quote = "Please contact Sarah before 25 November 2026 about the balance.";
    const result = briefFrom(rawNoticeText, quote);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.structuralBrief.redactedObligations[0]?.redactedClause).not.toContain("Sarah");
    expect(result.structuralBrief.redactedObligations[0]?.redactedClause).toContain("balance");
    expect(result.structuralBrief.redactedObligations[0]?.redactedClause).toContain(
      "[RECIPIENT_NAME]"
    );

    const unrelated = briefFrom(
      noticeWith([
        "18 November 2026",
        "Please pay the balance by 25 November 2026 to discuss your account.",
      ]),
      "Please pay the balance by 25 November 2026 to discuss your account."
    );
    expect(unrelated.ok).toBe(true);
    if (unrelated.ok) {
      expect(unrelated.redactedNoticePreview).toContain("balance");
      expect(unrelated.redactedNoticePreview).not.toContain("[RECIPIENT_NAME]");
    }

    expect(() =>
      validateCloudBoundPayload(clausePayload("Please contact Sarah before the response date."), {
        forbiddenIdentifiers: ["Sarah Example"],
      })
    ).toThrow(/forbidden local identifier/);
    expect(() =>
      validateCloudBoundPayload(
        clausePayload("Please pay the balance before the response date."),
        { forbiddenIdentifiers: ["Sarah Example"] }
      )
    ).not.toThrow();
  });

  it("U2 redacts an entire long numeric identifier instead of a phone-shaped prefix", () => {
    const quote = "Meter number 07700 900123 4567 and meter 3948572610 are recorded.";
    const rawNoticeText = noticeWith([
      "18 November 2026",
      "Dear Sarah Example,",
      quote,
      "Account reference: EXAMPLE-8472",
      "14 Example Road, Reading, RG0 0AA",
      "Our records show an outstanding balance of £1,280 for electricity supplied between January and June 2025.",
      PAY_QUOTE,
    ]);
    const result = briefFrom(rawNoticeText, quote);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const clause = result.structuralBrief.redactedObligations[0]?.redactedClause ?? "";
    expect(clause).not.toContain("4567");
    expect(clause).not.toContain("900123");
    expect(clause).not.toContain("3948572610");
    expect(clause).toContain("[PHONE]");
    expect(clause).toContain("[LOCAL_ID]");
    expect(result.redactedNoticePreview).not.toContain("4567");
    expect(result.redactedNoticePreview).not.toContain("3948572610");
  });

  it("discards an SDK result that resolves after cancellation and releases the lock", async () => {
    const controller = new AbortController();
    let resolveSdk: (value: { text: string; inferenceSource: string }) => void = () => undefined;
    const pending = runCloudDraftFromApprovedPayload(
      M0_SMOKE_TEST_CLOUD_PAYLOAD,
      undefined,
      controller.signal,
      {
        timeoutMs: 5_000,
        generate: () =>
          new Promise((resolve) => {
            resolveSdk = resolve;
          }),
      }
    );
    await Promise.resolve();
    controller.abort();
    resolveSdk({
      text: JSON.stringify(acceptedCloudOutput()),
      inferenceSource: "in_cloud",
    });
    const error = await pending.then(
      () => {
        throw new Error("cancelled call returned an accepted result");
      },
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(CloudDeliveryStoppedError);
    expect(error).toMatchObject({
      deliveryStopped: true,
      networkAbortConfirmed: false,
      reason: "late_response",
    });

    const next = approveCloudPayload(M0_SMOKE_TEST_CLOUD_PAYLOAD);
    expect(() => next.begin()).not.toThrow();
    next.cancel();
  });

  it("does not accept a value that resolves after the await when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const pending = acceptCloudCallResult({
      signal: controller.signal,
      timeoutMs: 1_000,
      execute: async () => "late-value",
    });
    await expect(pending).rejects.toMatchObject({
      deliveryStopped: true,
      networkAbortConfirmed: false,
      reason: "late_response",
    });
    await expect(pending).rejects.not.toBe("late-value");
  });

  it("times out without confirming a network abort and releases the request lock", async () => {
    const pending = runCloudDraftFromApprovedPayload(
      M0_SMOKE_TEST_CLOUD_PAYLOAD,
      undefined,
      undefined,
      {
        timeoutMs: 30,
        generate: () => new Promise(() => undefined),
      }
    );
    await expect(pending).rejects.toMatchObject({
      deliveryStopped: true,
      networkAbortConfirmed: false,
      reason: "timed_out",
    });
    const next = approveCloudPayload(M0_SMOKE_TEST_CLOUD_PAYLOAD);
    expect(() => next.begin()).not.toThrow();
    next.cancel();
  });

  it("records a confirmed network abort only when the SDK rejects with AbortError", async () => {
    const controller = new AbortController();
    const pending = runCloudDraftFromApprovedPayload(
      M0_SMOKE_TEST_CLOUD_PAYLOAD,
      undefined,
      controller.signal,
      {
        timeoutMs: 5_000,
        generate: ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              const error = new Error("The operation was aborted.");
              error.name = "AbortError";
              reject(error);
            });
          }),
      }
    );
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      deliveryStopped: true,
      networkAbortConfirmed: true,
    });
  });

  it("O08-O11 rejects malformed and unexpected placeholders in cloud output", () => {
    const reject = (patch: Partial<CloudDraftOutput>) =>
      validateCloudDraftOutput({ ...acceptedCloudOutput(), ...patch }, M0_SMOKE_TEST_CLOUD_PAYLOAD);

    expect(() => reject({ replyTemplateWithPlaceholders: "Dear [RECIPIENT_NAME" })).toThrow(
      CloudOutputValidationError
    );
    expect(() => reject({ replyTemplateWithPlaceholders: "Dear [ACCOUNT_REF_]" })).toThrow(
      /canonical set/
    );
    expect(() => reject({ replyTemplateWithPlaceholders: "Dear [ACCOUNT_REF_0]" })).toThrow(
      /canonical set/
    );
    expect(() => reject({ replyTemplateWithPlaceholders: "Dear []" })).toThrow(/canonical set/);
    expect(() => reject({ replyTemplateWithPlaceholders: "Dear [[RECIPIENT_NAME]]" })).toThrow(
      /canonical set/
    );
    expect(() => reject({ replyTemplateWithPlaceholders: "Dear {{RECIPIENT_NAME}}" })).toThrow(
      /canonical set/
    );
    expect(() => reject({ replyTemplateWithPlaceholders: "Dear {{{ACCOUNT_REF}}}" })).toThrow(
      /canonical set/
    );
    expect(() => reject({ replyTemplateWithPlaceholders: "Dear {[RECIPIENT_NAME]}" })).toThrow(
      /canonical set/
    );
    expect(() => reject({ replyTemplateWithPlaceholders: "Dear [{PHONE}]" })).toThrow(
      /canonical set/
    );
    expect(() =>
      reject({
        summaryPlainEnglish: "Please see [account_ref] before you reply.",
        replyTemplateWithPlaceholders: "Dear [RECIPIENT_NAME]",
      })
    ).toThrow(/unexpected placeholder/);
    expect(() => reject({ replyTemplateWithPlaceholders: "Dear [ACCOUNT REF]" })).toThrow(
      /canonical set/
    );
    expect(() => reject({ replyTemplateWithPlaceholders: "Dear ［RECIPIENT_NAME］" })).toThrow(
      /canonical set/
    );
    expect(reject({})).toMatchObject({
      replyTemplateWithPlaceholders: "Dear [RECIPIENT_NAME]",
    });
  });

  it("P03 P04 and P06 keep Copy and Download blocked while any placeholder is unresolved or malformed", () => {
    const unresolved = createReplyDraftState("Please reply [UNKNOWN_TOKEN] today.", []);
    expect(unresolved.unresolvedPlaceholders).toContain("[UNKNOWN_TOKEN]");
    expect(unresolved.copyOrDownloadBlocked).toBe(true);

    const malformed = createReplyDraftState("Hello [RECIPIENT_NAME", [
      { placeholder: "[RECIPIENT_NAME]", localValue: "Sarah Example" },
    ]);
    expect(malformed.copyOrDownloadBlocked).toBe(true);
    expect(malformed.localDraft).toContain("[RECIPIENT_NAME");

    const ready = createReplyDraftState("Dear [RECIPIENT_NAME]", [
      { placeholder: "[RECIPIENT_NAME]", localValue: "Sarah Example" },
    ]);
    expect(ready.copyOrDownloadBlocked).toBe(false);
    const reintroduced = editLocalDraft(ready, "Dear Sarah Example [account_ref]");
    expect(reintroduced.copyOrDownloadBlocked).toBe(true);
    expect(reintroduced.cloudTemplate).toBe(ready.cloudTemplate);

    const stillBlocked = editLocalDraft(reintroduced, "Dear Sarah Example [ACCOUNT_REF");
    expect(stillBlocked.copyOrDownloadBlocked).toBe(true);

    const doubled = createReplyDraftState("Hello {{RECIPIENT_NAME}}", [
      { placeholder: "[RECIPIENT_NAME]", localValue: "Sarah Example" },
    ]);
    expect(doubled.unresolvedPlaceholders).toContain("{{RECIPIENT_NAME}}");
    expect(doubled.copyOrDownloadBlocked).toBe(true);
    expect(doubled.localDraft).toContain("{{RECIPIENT_NAME}}");
    expect(doubled.localDraft).not.toContain("Sarah Example");
  });

  it("keeps a canonical placeholder valid while rejecting O10 double-brace forms", () => {
    const ready = createReplyDraftState("Dear [RECIPIENT_NAME]", [
      { placeholder: "[RECIPIENT_NAME]", localValue: "Sarah Example" },
    ]);
    expect(ready.copyOrDownloadBlocked).toBe(false);
    expect(ready.localDraft).toBe("Dear Sarah Example");
    expect(
      validateCloudDraftOutput(acceptedCloudOutput(), M0_SMOKE_TEST_CLOUD_PAYLOAD)
        .replyTemplateWithPlaceholders
    ).toBe("Dear [RECIPIENT_NAME]");
  });

  it("matches name components as whole words and leaves domain phrases in place", () => {
    expect(() =>
      validateCloudBoundPayload(
        clausePayload("Please contact the billing team before the response date."),
        { forbiddenIdentifiers: ["Bill Payer"] }
      )
    ).not.toThrow();
    expect(() =>
      validateCloudBoundPayload(clausePayload("Please contact Bill before the response date."), {
        forbiddenIdentifiers: ["Bill Payer"],
      })
    ).toThrow(/forbidden local identifier/);

    expect(() =>
      validateCloudBoundPayload(
        clausePayload("The annual amount is due before the response date."),
        { forbiddenIdentifiers: ["Ann Example"] }
      )
    ).not.toThrow();
    expect(() =>
      validateCloudBoundPayload(clausePayload("Please contact Ann before the response date."), {
        forbiddenIdentifiers: ["Ann Example"],
      })
    ).toThrow(/forbidden local identifier/);

    expect(() =>
      validateCloudBoundPayload(
        clausePayload("There is a problem with the stated balance before the date."),
        { forbiddenIdentifiers: ["Rob Sample"] }
      )
    ).not.toThrow();
    expect(() =>
      validateCloudBoundPayload(clausePayload("Please contact Rob before the response date."), {
        forbiddenIdentifiers: ["Rob Sample"],
      })
    ).toThrow(/forbidden local identifier/);

    expect(() =>
      validateCloudBoundPayload(clausePayload("Please contact Sarah before the response date."), {
        forbiddenIdentifiers: ["Sarah Example"],
      })
    ).toThrow(/forbidden local identifier/);

    const energyNotice = noticeWith([
      "18 November 2026",
      "Dear Alex Energy,",
      "Please review energy billing before 25 November 2026.",
      "Account reference: EXAMPLE-8472",
    ]);
    const energyQuote = "Please review energy billing before 25 November 2026.";
    const energy = briefFrom(energyNotice, energyQuote);
    expect(energy.ok).toBe(true);
    if (energy.ok) {
      expect(energy.structuralBrief.redactedObligations[0]?.redactedClause).toContain(
        "energy billing"
      );
      expect(energy.structuralBrief.redactedObligations[0]?.redactedClause).not.toContain(
        "[RECIPIENT_NAME]"
      );
      expect(energy.redactedNoticePreview).toContain("energy billing");
      expect(energy.redactedNoticePreview).toContain("Dear [RECIPIENT_NAME]");
    }
    expect(() =>
      validateCloudBoundPayload(
        clausePayload("Please review energy billing before the response date."),
        { forbiddenIdentifiers: ["Alex Energy"] }
      )
    ).not.toThrow();
    expect(() =>
      validateCloudBoundPayload(clausePayload("Please contact Energy before the response date."), {
        forbiddenIdentifiers: ["Alex Energy"],
      })
    ).toThrow(/forbidden local identifier/);
  });
});

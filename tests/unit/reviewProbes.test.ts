import { afterEach, describe, expect, it } from "vitest";
import { acceptCloudCallResult, CloudDeliveryStoppedError } from "../../src/ai/cloudCallDelivery";
import { runCloudDraftFromApprovedPayload } from "../../src/ai/cloudDrafter";
import { CloudOutputValidationError, validateCloudDraftOutput } from "../../src/domain/cloudOutputGuard";
import {
  canonicalCloudPayload,
  revalidateFinalCloudPayload,
  validateCloudBoundPayload,
} from "../../src/domain/cloudPayloadGuard";
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

  it("U3 redacts a format-joined account reference and rejects it if reintroduced", () => {
    const soft = "\u00AD";
    const reference = `EXAMPLE${soft}8472`;
    const quote = `For ${reference} please pay the balance by 25 November 2026.`;
    const rawNoticeText = noticeWith([
      "18 November 2026",
      "Dear Sarah Example,",
      `Account reference: ${reference}`,
      "14 Example Road, Reading, RG0 0AA",
      "Our records show an outstanding balance of £1,280 for electricity supplied between January and June 2025.",
      quote,
    ]);
    const result = redactAndBuildBrief({
      rawNoticeText,
      responseGoal: "request_billing_review",
      guidanceIds: ["ofgem-backbilling-12m-v1"],
      extraKnownIdentifiers: ["Sarah Example"],
      extraction: {
        noticeCategory: "utility_electricity",
        issueDate: "18 November 2026",
        billingPeriod: "January and June 2025",
        amountGBP: 1280,
        responseDeadline: "25 November 2026",
        obligations: [
          {
            action: "Pay the stated balance",
            dueDate: "25 November 2026",
            sourceQuote: quote,
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const account = result.localIdentifierMap.entries.find((entry) => entry.kind === "account_ref");
    const start = rawNoticeText.indexOf(reference);
    expect(account?.rawValue).toBe(reference);
    expect(account?.placeholder).toBe("[ACCOUNT_REF]");
    expect(account?.startOffset).toBe(start);
    expect(account?.endOffset).toBe(start + reference.length);
    expect(rawNoticeText.slice(account?.startOffset, account?.endOffset)).toBe(reference);
    expect(result.redactedNoticePreview).toContain("Account reference: [ACCOUNT_REF]");
    expect(result.redactedNoticePreview).not.toContain("8472");
    expect(result.redactedNoticePreview).not.toContain(soft);
    expect(result.structuralBrief.redactedObligations[0]?.redactedClause).toBe(
      "For [ACCOUNT_REF] please pay the balance by 25 November 2026."
    );

    const canonical = canonicalCloudPayload(result.structuralBrief, {
      forbiddenIdentifiers: result.localIdentifierMap.entries.map((entry) => entry.rawValue),
    });
    expect(canonical.serialized).not.toContain(reference);
    expect(canonical.serialized).not.toContain("8472");
    expect(canonical.serialized).not.toContain("EXAMPLE");

    const edited = {
      ...result.structuralBrief,
      redactedObligations: [
        {
          ...result.structuralBrief.redactedObligations[0],
          redactedClause: quote,
        },
      ],
    };
    expect(() =>
      canonicalCloudPayload(edited, {
        forbiddenIdentifiers: result.localIdentifierMap.entries.map((entry) => entry.rawValue),
      })
    ).toThrow(/forbidden local identifier|account reference/);

    const joiner = `EXAMPLE\u20608472`;
    const joinedQuote = `For ${joiner} please pay the balance by 25 November 2026.`;
    const joinedNotice = rawNoticeText.replaceAll(reference, joiner);
    const joined = redactAndBuildBrief({
      rawNoticeText: joinedNotice,
      responseGoal: "request_billing_review",
      guidanceIds: ["ofgem-backbilling-12m-v1"],
      extraKnownIdentifiers: ["Sarah Example"],
      extraction: {
        noticeCategory: "utility_electricity",
        issueDate: "18 November 2026",
        billingPeriod: "January and June 2025",
        amountGBP: 1280,
        responseDeadline: "25 November 2026",
        obligations: [
          {
            action: "Pay the stated balance",
            dueDate: "25 November 2026",
            sourceQuote: joinedQuote,
          },
        ],
      },
    });
    expect(joined.ok).toBe(true);
    if (!joined.ok) {
      return;
    }
    const joinedAccount = joined.localIdentifierMap.entries.find(
      (entry) => entry.kind === "account_ref"
    );
    expect(joinedAccount?.rawValue).toBe(joiner);
    expect(joined.redactedNoticePreview).not.toContain("8472");
  });

  it.each([
    ["K3 labelled", "Ref SMITH-4471", "SMITH-4471", "Ref [ACCOUNT_REF]"],
    ["K3 lowercase", "ref smith-90210", "smith-90210", "ref [ACCOUNT_REF]"],
    ["K3 unicode hyphen", "Ref SMITH\u20114471", "SMITH\u20114471", "Ref [ACCOUNT_REF]"],
    ["K3 unlabelled", "Keep SMITH/4471 on the file.", "SMITH/4471", "Keep [ACCOUNT_REF] on the file."],
  ])("%s keeps the whole account token together", (_name, line, token, redactedLine) => {
    const rawNoticeText = noticeWith([
      "18 November 2026",
      "Dear John Smith,",
      line,
      "The period Nov-2026 is a calendar label.",
      "Our records show an outstanding balance of £1,280 for electricity supplied between January and June 2025.",
      PAY_QUOTE,
    ]);
    const result = briefFrom(rawNoticeText, PAY_QUOTE);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const account = result.localIdentifierMap.entries.find((entry) => entry.rawValue === token);
    const start = rawNoticeText.indexOf(token);
    expect(account?.kind).toBe("account_ref");
    expect(account?.placeholder).toBe("[ACCOUNT_REF]");
    expect(account?.startOffset).toBe(start);
    expect(account?.endOffset).toBe(start + token.length);
    expect(rawNoticeText.slice(account?.startOffset, account?.endOffset)).toBe(token);
    expect(result.redactedNoticePreview).toContain(redactedLine);
    expect(result.redactedNoticePreview).toContain("Nov-2026");
    expect(result.redactedNoticePreview).not.toContain(token);
    expect(result.redactedNoticePreview).not.toContain("[RECIPIENT_NAME]-");
    expect(result.redactedNoticePreview).not.toContain("[RECIPIENT_NAME]/");
    expect(result.redactedNoticePreview).not.toContain("John Smith");
    expect(JSON.stringify(result.structuralBrief)).not.toContain("4471");
    expect(JSON.stringify(result.structuralBrief)).not.toContain("90210");
  });

  it.each([
    ["Ref SMITH-44", "Ref SMITH-44", "SMITH-44", "John Smith", "Ref [RECIPIENT_NAME]-44"],
    ["Smith/7", "See Smith/7 before you reply.", "Smith/7", "John Smith", "[RECIPIENT_NAME]/7"],
    ["Sarah-1", "See Sarah-1 before you reply.", "Sarah-1", "Sarah Example", "[RECIPIENT_NAME]-1"],
    ["Example-12", "See Example-12 before you reply.", "Example-12", "Sarah Example", "[RECIPIENT_NAME]-12"],
  ])(
    "R5-1 keeps %s from escaping redaction and the final guard",
    (_label, line, token, recipient, redactedToken) => {
      const rawNoticeText = noticeWith([
        "18 November 2026",
        `Dear ${recipient},`,
        line,
        "The period Nov-2026 is a calendar label.",
        "Our records show an outstanding balance of £1,280 for electricity supplied between January and June 2025.",
        PAY_QUOTE,
      ]);
      const result = briefFrom(rawNoticeText, PAY_QUOTE);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.redactedNoticePreview).toContain(redactedToken);
      expect(result.redactedNoticePreview).toContain("Nov-2026");
      expect(result.redactedNoticePreview).not.toContain(token);
      expect(result.redactedNoticePreview).not.toContain(recipient);
      expect(JSON.stringify(result.structuralBrief)).not.toContain(token);

      const forbidden = result.localIdentifierMap.entries.map((entry) => entry.rawValue);
      expect(() =>
        validateCloudBoundPayload(clausePayload(`Please review ${token} before the response date.`), {
          forbiddenIdentifiers: [recipient, ...forbidden],
        })
      ).toThrow(/forbidden local identifier|partial identifier|account reference/);
      expect(() =>
        revalidateFinalCloudPayload(
          clausePayload(`Please review ${redactedToken} before the response date.`),
          { forbiddenIdentifiers: [recipient, ...forbidden] }
        )
      ).toThrow(/partial identifier/);

      const edited = {
        ...result.structuralBrief,
        redactedObligations: [
          {
            ...result.structuralBrief.redactedObligations[0]!,
            redactedClause: `Please review ${token} before the response date.`,
          },
        ],
      };
      expect(() =>
        revalidateFinalCloudPayload(edited, { forbiddenIdentifiers: [recipient, ...forbidden] })
      ).toThrow(/forbidden local identifier|partial identifier|account reference/);
    }
  );

  it("K5 rejects a digit tail beside any canonical placeholder", () => {
    const clauses = [
      "The saved reference is [RECIPIENT_NAME]-8472 today.",
      "The saved reference is [ACCOUNT_REF]-8472 today.",
      "The saved reference is [EMAIL]/100 today.",
      "The saved reference is [SUPPLY_ADDRESS]4471 today.",
      "The saved reference is [PHONE]-0207 today.",
      "The saved reference is [NINO]-123 today.",
      "The saved reference is [LOCAL_ID]-9 today.",
    ];
    for (const redactedClause of clauses) {
      expect(() => revalidateFinalCloudPayload(clausePayload(redactedClause))).toThrow(
        /partial identifier/
      );
    }

    const rawNoticeText = noticeWith([
      "18 November 2026",
      "Dear John Smith,",
      "Ref SMITH-4471",
      "Our records show an outstanding balance of £1,280 for electricity supplied between January and June 2025.",
      PAY_QUOTE,
    ]);
    const result = briefFrom(rawNoticeText, PAY_QUOTE);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const edited = {
      ...result.structuralBrief,
      redactedObligations: [
        {
          ...result.structuralBrief.redactedObligations[0]!,
          redactedClause: "The saved reference is [RECIPIENT_NAME]-8472 today.",
        },
      ],
    };
    expect(() =>
      revalidateFinalCloudPayload(edited, {
        forbiddenIdentifiers: result.localIdentifierMap.entries.map((entry) => entry.rawValue),
      })
    ).toThrow(/partial identifier/);
    const reintroduced = {
      ...edited,
      redactedObligations: [
        {
          ...edited.redactedObligations[0]!,
          redactedClause: "The saved reference is SMITH-4471 today.",
        },
      ],
    };
    expect(() =>
      revalidateFinalCloudPayload(reintroduced, {
        forbiddenIdentifiers: result.localIdentifierMap.entries.map((entry) => entry.rawValue),
      })
    ).toThrow(/account reference|forbidden local identifier/);
  });

  it.each([
    ["Z6d soft hyphen", "\u00AD"],
    ["Z6d zero width", "\u200B"],
    ["Z6d word joiner", "\u2060"],
  ])("%s redacts the complete salutation and the guard rejects it", (_name, mark) => {
    const disguised = `Sar${mark}ah Exam${mark}ple`;
    const rawNoticeText = noticeWith([
      "18 November 2026",
      `Dear ${disguised},`,
      "Our records show an outstanding balance of £1,280 for electricity supplied between January and June 2025.",
      PAY_QUOTE,
    ]);
    const result = briefFrom(rawNoticeText, PAY_QUOTE);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const name = result.localIdentifierMap.entries.find((entry) => entry.rawValue === disguised);
    const start = rawNoticeText.indexOf(disguised);
    expect(name?.kind).toBe("recipient_name");
    expect(name?.startOffset).toBe(start);
    expect(name?.endOffset).toBe(start + disguised.length);
    expect(rawNoticeText.slice(name?.startOffset, name?.endOffset)).toBe(disguised);
    expect(result.redactedNoticePreview).not.toContain(disguised);
    expect(result.redactedNoticePreview).not.toContain("Sarah");
    expect(result.redactedNoticePreview).not.toContain(mark);
    expect(() =>
      validateCloudBoundPayload(
        clausePayload(`Please contact ${disguised} before the response date.`),
        { forbiddenIdentifiers: ["Sarah Example", disguised] }
      )
    ).toThrow(/forbidden local identifier|personal salutation/);
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

describe("M2B-2B name components, reference shapes, and edited clauses", () => {
  const pay =
    "Please pay the outstanding balance of £1,280 by 25 November 2026.";

  function noticeFor(body: string[]): ReturnType<typeof briefFrom> {
    return briefFrom(
      noticeWith([
        "18 November 2026",
        ...body,
        "Our records show an outstanding balance of £1,280 for electricity supplied between January and June 2025.",
        pay,
      ]),
      pay
    );
  }

  it("R5-2 redacts plain components of a disguised name and rejects them in an edited clause", () => {
    const disguised = [
      { salutation: "Sar\u00ADah Exam\u00ADple", first: "Sarah", second: "Example" },
      { salutation: "Pri\u200Bya Test\u200Bperson", first: "Priya", second: "Testperson" },
      { salutation: "An\u2060na Samp\u2060le", first: "Anna", second: "Sample" },
    ];
    for (const { salutation, first, second } of disguised) {
      const result = noticeFor([
        `Dear ${salutation},`,
        "Account reference: EXAMPLE-8472",
        `Please contact ${first} about ${second} before the response date.`,
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        continue;
      }
      expect(result.redactedNoticePreview).toContain(
        `Please contact [RECIPIENT_NAME] about [RECIPIENT_NAME] before the response date.`
      );
      expect(result.redactedNoticePreview).not.toContain(first);
      expect(result.redactedNoticePreview).not.toContain(second);
      expect(result.redactedNoticePreview).not.toContain("8472");
      const clause = `Please contact ${first} before the response date.`;
      expect(() =>
        revalidateFinalCloudPayload(clausePayload(clause), {
          forbiddenIdentifiers: [salutation],
        })
      ).toThrow(/forbidden local identifier/);
    }

    const bill = noticeFor([
      "Dear B\u00ADill Exam\u00ADple,",
      "Account reference: EXAMPLE-8472",
      "Please review the bill before the response date.",
      "Bill asked for the annual energy billing review.",
    ]);
    expect(bill.ok).toBe(true);
    if (bill.ok) {
      expect(bill.redactedNoticePreview).toContain("Please review the bill");
      expect(bill.redactedNoticePreview).toContain("annual energy billing");
      expect(bill.redactedNoticePreview).toContain("[RECIPIENT_NAME] asked");
      expect(bill.redactedNoticePreview).not.toMatch(/\bBill\b/);
    }

    const fullwidth = "\uFF33\uFF41\uFF52\uFF41\uFF48";
    const nfd = "Jose\u0301";
    const varied = redactAndBuildBrief({
      rawNoticeText: noticeWith([
        "18 November 2026",
        "Dear Sarah Example,",
        "Account reference: EXAMPLE-8472",
        `Please contact ${fullwidth} and ${nfd} before the response date.`,
        "Our records show an outstanding balance of £1,280 for electricity supplied between January and June 2025.",
        pay,
      ]),
      responseGoal: "request_billing_review",
      guidanceIds: ["ofgem-backbilling-12m-v1"],
      extraKnownIdentifiers: ["\uFF33\uFF41\uFF52\uFF41\uFF48 \uFF25\uFF58\uFF41\uFF4D\uFF50\uFF4C\uFF45", "Jose\u0301 Sample"],
      extraction: {
        noticeCategory: "utility_electricity",
        issueDate: "18 November 2026",
        billingPeriod: "January and June 2025",
        amountGBP: 1280,
        responseDeadline: "25 November 2026",
        obligations: [{ action: "Pay the stated balance", dueDate: "25 November 2026", sourceQuote: pay }],
      },
    });
    expect(varied.ok).toBe(true);
    if (varied.ok) {
      expect(varied.redactedNoticePreview).toContain(
        "Please contact [RECIPIENT_NAME] and [LOCAL_ID] before the response date."
      );
      expect(varied.redactedNoticePreview).not.toContain(fullwidth);
      expect(varied.redactedNoticePreview).not.toContain("José");
      expect(varied.redactedNoticePreview).not.toContain("\u0301");
    }
    expect(() =>
      revalidateFinalCloudPayload(
        clausePayload("Please contact José before the response date."),
        { forbiddenIdentifiers: ["Jose\u0301 Sample"] }
      )
    ).toThrow(/forbidden local identifier/);
  });

  it("R5-4 redacts joined and separated references without treating a prose year as an account", () => {
    const separators = ["", "_", ".", ":", "#", "-", "/"];
    for (const separator of separators) {
      const token = `SMITH${separator}4471`;
      const result = noticeFor([
        "Dear John Smith,",
        `Account reference: ${token}`,
        "The billing2026 note and Nov-2026 stay in the letter.",
        "Nov2026 is a date label beside balance2026.",
      ]);
      expect(result.ok, token).toBe(true);
      if (!result.ok) {
        continue;
      }
      expect(result.redactedNoticePreview, token).toContain("[ACCOUNT_REF]");
      expect(result.redactedNoticePreview, token).not.toContain("4471");
      expect(result.redactedNoticePreview, token).not.toContain("SMITH");
      expect(result.redactedNoticePreview, token).toContain("billing2026");
      expect(result.redactedNoticePreview, token).toContain("Nov-2026");
      expect(result.redactedNoticePreview, token).toContain("Nov2026");
      expect(result.redactedNoticePreview, token).toContain("balance2026");
      expect(result.redactedNoticePreview).toContain("[ACCOUNT_REF]");
      const before = result.redactedNoticePreview.indexOf("[ACCOUNT_REF]");
      expect(result.redactedNoticePreview.slice(0, before)).toContain("Account reference: ");
    }

    const dotted = `SMITH\uFF0E4471`;
    const hidden = noticeFor(["Dear John Smith,", `Reference ${dotted} is quoted.`]);
    expect(hidden.ok).toBe(true);
    if (hidden.ok) {
      expect(hidden.redactedNoticePreview).not.toContain("4471");
      expect(hidden.redactedNoticePreview).toContain("Reference [ACCOUNT_REF] is quoted.");
    }

    const tails = [
      "[RECIPIENT_NAME]_8472",
      "[ACCOUNT_REF].8472",
      "[ACCOUNT_REF_2]:8472",
      "[LOCAL_ID]#8472",
      "[EMAIL]:8472",
      "[NINO]/8472",
      "[PHONE]-8472",
      "[SUPPLY_ADDRESS]_8472",
    ];
    for (const tail of tails) {
      expect(() =>
        revalidateFinalCloudPayload(
          clausePayload(`The saved reference is ${tail} today.`),
          { forbiddenIdentifiers: ["SMITH4471"] }
        )
      ).toThrow(/partial identifier/);
      expect(() =>
        validateCloudBoundPayload(clausePayload(`The saved reference is ${tail} today.`), {
          forbiddenIdentifiers: ["John Smith"],
        })
      ).toThrow(/partial identifier/);
    }
    expect(() =>
      revalidateFinalCloudPayload(
        clausePayload("The saved reference is SMITH4471 today."),
        { forbiddenIdentifiers: ["John Smith"] }
      )
    ).toThrow(/account reference/);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCloudDraftPrompt } from "../../src/ai/cloudDrafter";
import {
  CloudOutputValidationError,
  draftConsistencyViolations,
  validateCloudDraftOutput,
  type ApprovedCloudDraftFacts,
} from "../../src/domain/cloudOutputGuard";
import { isRealCloudDiagnosticEnabled } from "../../src/adapters/realCloudDiagnostic";

const facts: ApprovedCloudDraftFacts = {
  noticeCategory: "utility_electricity",
  guidanceIds: [],
  amountsGBP: [1280],
  issueDate: null,
  billingPeriod: null,
  responseDeadlines: [],
};

function mentionsIdentifier(text: string): boolean {
  return draftConsistencyViolations([text], facts).includes("draft mentions a personal identifier");
}

const GREETING_FIELDS = [
  "summaryPlainEnglish",
  "replyTemplateWithPlaceholders",
  "title",
  "rationale",
  "applicableCondition",
] as const;

function draftPlacing(field: (typeof GREETING_FIELDS)[number], text: string) {
  const neutral = "You can ask for a review of the stated balance.";
  return {
    summaryPlainEnglish: field === "summaryPlainEnglish" ? text : neutral,
    options: [
      {
        title: field === "title" ? text : "Ask for a billing review",
        rationale: field === "rationale" ? text : "You can ask the sender to review the stated balance.",
        applicableCondition:
          field === "applicableCondition" ? text : "Use this if you want a review of the stated balance.",
      },
    ],
    replyTemplateWithPlaceholders:
      field === "replyTemplateWithPlaceholders" ? `${text}\n[ACCOUNT_REF]` : "Please review the stated balance for [ACCOUNT_REF].",
    citedGuidanceIds: [] as string[],
  };
}

function expectGreetingOnEveryField(text: string, accepted: boolean): void {
  for (const field of GREETING_FIELDS) {
    let caught: unknown;
    try {
      validateCloudDraftOutput(draftPlacing(field, text), facts);
    } catch (error) {
      caught = error;
    }
    if (accepted) {
      expect(caught, field).toBeUndefined();
      continue;
    }
    expect(caught, field).toBeInstanceOf(CloudOutputValidationError);
    expect((caught as CloudOutputValidationError).violations, field).toContain(
      "draft mentions a personal identifier"
    );
  }
}

describe("Phase 5C-6 greeting allowlist", () => {
  it.each(["Dear Sir or Madam,", "Dear Sir/Madam,", "Dear Customer Services,"])(
    "accepts the exact line %s",
    (text) => {
      expect(mentionsIdentifier(text)).toBe(false);
      expectGreetingOnEveryField(text, true);
    }
  );

  it("accepts an exact greeting on its own line followed by a letter", () => {
    const text = "Dear Sir or Madam,\nPlease review the stated balance.";
    expect(mentionsIdentifier(text)).toBe(false);
    expectGreetingOnEveryField(text, true);
  });

  it.each([
    "Dear Sarah",
    "Dear Mr Smith",
    "Dear Sir or Madam Sarah",
    "Dear Customer Services Team",
    "Dear Customer",
    "Dear Sir or Madam",
    "Dear Sir/Madam",
    "Dear Customer Services",
    "Dear Sir or Madam, Sarah Example",
    "Dear Customer Services, Sarah Example",
    "Dear Sir/Madam, Mr Smith",
    "Dear Sir or Madam,Sarah",
    "Dear Sir or Madam, Please review the stated balance.",
  ])("rejects %s", (text) => {
    expect(mentionsIdentifier(text)).toBe(true);
    expectGreetingOnEveryField(text, false);
  });

  it("still rejects a postcode and an unapproved amount", () => {
    expect(mentionsIdentifier("Write to RG0 0AA.")).toBe(true);
    expect(draftConsistencyViolations(["The difference is £760."], facts)).toContain(
      "draft mentions an amount that is not on the approved brief"
    );
  });

  it("does not treat a placeholder salutation as a name", () => {
    expect(mentionsIdentifier("Dear [RECIPIENT_NAME]")).toBe(false);
    expect(mentionsIdentifier("Dear [RECIPIENT_NAME],")).toBe(false);
    expectGreetingOnEveryField("Dear [RECIPIENT_NAME],\nPlease review the stated balance.", true);
    expect(mentionsIdentifier("Dear [RECIPIENT_NAME], Sarah Example")).toBe(true);
  });

  it("does not detect a name that is not on a Dear line, so R5-2 stays open", () => {
    expect(mentionsIdentifier("Sarah Example asked about the stated balance.")).toBe(false);
  });

  it("tells the model to use one exact salutation on its own line and not invent a name", () => {
    const prompt = buildCloudDraftPrompt("{}", {
      noticeCategory: "utility_electricity",
      guidanceIds: [],
    });
    expect(prompt).toContain(
      "If a salutation is necessary, use exactly 'Dear Sir or Madam,' on its own line."
    );
    expect(prompt).toContain("Do not invent any person, supplier or recipient name.");
    expect(prompt).not.toContain("Do not include a greeting");
  });
});

describe("Phase 5C-6 diagnostic default", () => {
  it("stays off unless a test stubs the flag", () => {
    expect(isRealCloudDiagnosticEnabled("127.0.0.1")).toBe(false);
  });
});

describe("Phase 5C-6 chrome script assertions", () => {
  const source = readFileSync("scripts/verify-approved-cloud-chrome.mjs", "utf8");

  it("does not replay an approved generation for a negative App Check probe", () => {
    expect(source).toContain("heldGenerations === 1");
    expect(source).not.toContain("heldGenerations <= 1");
    expect(source).toContain("Negative App Check probes are not sent");
    expect(source).toContain("HTTP 401 or 403 alone is not App Check enforcement");
    expect(source).toContain("minimal non-sensitive");
    expect(source).toContain('MINIMAL_APP_CHECK_DIAGNOSTIC_BODY = "{}"');
    expect(source).not.toContain("fetch(request.url(");
    expect(source).not.toContain("firebase-tools");
    expect(source).not.toContain("firebaseml");
    expect(source).toContain("firebasevertexai.googleapis.com");
    expect(source).toContain("Fresh reCAPTCHA Enterprise attestation is unverified");
    expect(source).toContain("INCONCLUSIVE");
    expect(source).not.toContain("noticelens-m5c5-chrome");
  });
});

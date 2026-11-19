import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCloudDraftPrompt } from "../../src/ai/cloudDrafter";
import {
  draftConsistencyViolations,
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

describe("Phase 5C-6 greeting allowlist", () => {
  it.each(["Dear Sir or Madam,", "Dear Sir or Madam", "Dear Sir/Madam", "Dear Customer Services"])(
    "accepts %s",
    (text) => {
      expect(mentionsIdentifier(text)).toBe(false);
    }
  );

  it.each([
    "Dear Sarah",
    "Dear Mr Smith",
    "Dear Sir or Madam Sarah",
    "Dear Customer Services Team",
    "Dear Customer",
  ])("rejects %s", (text) => {
    expect(mentionsIdentifier(text)).toBe(true);
  });

  it("still rejects a postcode and an unapproved amount", () => {
    expect(mentionsIdentifier("Write to RG0 0AA.")).toBe(true);
    expect(draftConsistencyViolations(["The difference is £760."], facts)).toContain(
      "draft mentions an amount that is not on the approved brief"
    );
  });

  it("does not treat a placeholder salutation as a name", () => {
    expect(mentionsIdentifier("Dear [RECIPIENT_NAME],")).toBe(false);
  });

  it("tells the model to use one exact salutation and not invent a name", () => {
    const prompt = buildCloudDraftPrompt("{}", {
      noticeCategory: "utility_electricity",
      guidanceIds: [],
    });
    expect(prompt).toContain("If a salutation is necessary, use exactly 'Dear Sir or Madam,'.");
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

  it("requires exactly one held generation and both authentication headers", () => {
    expect(source).toContain("heldGenerations === 1");
    expect(source).not.toContain("heldGenerations <= 1");
    expect(source).toContain("x-goog-api-key");
    expect(source).toContain("x-firebase-appid");
    expect(source).toContain("INCONCLUSIVE");
    expect(source).not.toContain("noticelens-m5c5-chrome");
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildClosedCloudInspection } from "../../src/adapters/closedCloudInspection";
import { groundNoticeFacts } from "../../src/adapters/groundNoticeFacts";
import { redactAndBuildBrief } from "../../src/domain/redactAndBrief";
import { applyPlaceholderBindings } from "../../src/domain/personaliseDraft";
import {
  canonicalClosedCloudBrief,
  CLOSED_CLOUD_BRIEF_OPTIONAL_KEYS,
  CLOSED_CLOUD_BRIEF_ROOT_KEYS,
} from "../../src/domain/closedCloudBrief";
import { hasPartialPlaceholderIdentifier } from "../../src/domain/placeholders";
import { normalizeNewlines } from "../../src/domain/textNormalize";
const TODAY = "2026-11-13";
const original = normalizeNewlines(readFileSync("examples/energy-backbill-original.txt", "utf8"));
const revised = normalizeNewlines(readFileSync("examples/energy-backbill-revised.txt", "utf8"));
const PAY =
  "Please pay the balance or contact our billing team by 25 November 2026 to discuss your account.";
const BALANCE =
  "Our records show an outstanding balance of £1,280 for electricity supplied between January and June 2025.";

function notice(lines: string[]): string {
  return lines.join("\n");
}

function brief(rawNoticeText: string, quote = PAY) {
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
      obligations: [{ action: "Pay the stated balance", dueDate: "25 November 2026", sourceQuote: quote }],
    },
  });
}

function shell(extra: string[]): string {
  return notice([
    "Final Payment Reminder",
    "18 November 2026",
    ...extra,
    BALANCE,
    PAY,
  ]);
}

function expectProtected(rawNoticeText: string, secrets: string[]): void {
  const result = brief(rawNoticeText);
  expect(result.ok, result.ok ? "" : result.reasons.join("; ")).toBe(true);
  if (!result.ok) {
    return;
  }
  const preview = result.redactedNoticePreview;
  const serialized = JSON.stringify(result.structuralBrief);
  for (const secret of secrets) {
    expect(preview, secret).not.toContain(secret);
    expect(serialized, secret).not.toContain(secret);
    expect(preview.toLowerCase(), secret).not.toContain(secret.toLowerCase());
  }
  expect(preview).toContain("£1,280");
  expect(preview).toContain("18 November 2026");
  expect(preview).toContain("25 November 2026");
  expect(preview).toContain("January and June 2025");
  for (const entry of result.localIdentifierMap.entries) {
    expect(rawNoticeText.slice(entry.startOffset, entry.endOffset)).toBe(entry.rawValue);
    expect(entry.placeholder).not.toContain(entry.rawValue);
    expect(entry.placeholder.startsWith("[")).toBe(true);
  }
}

describe("Phase 5A privacy redaction", () => {
  const names = [
    "José Álvarez",
    "Zoë O'Connor",
    "Zoë O\u2019Connor",
    "Chloë-Marie Smith",
    "Ana María García",
    "François Dupont",
    "Søren Nielsen",
    "Łukasz Kowalski",
  ];

  it("protects recognised unicode salutations and keeps ordinary notice words", () => {
    for (const name of names) {
      expectProtected(shell([`Dear ${name},`, "Account reference: AB-1234"]), [name, "AB-1234"]);
    }
    const mixed = shell([
      "Dear josé   ÁLVAREZ,",
      "Please pay the bill and review the energy billing team.",
    ]);
    const mixedResult = brief(mixed);
    expect(mixedResult.ok).toBe(true);
    if (mixedResult.ok) {
      expect(mixedResult.redactedNoticePreview).toContain("Dear [RECIPIENT_NAME]");
      expect(mixedResult.redactedNoticePreview.toLowerCase()).not.toContain("josé");
      expect(mixedResult.redactedNoticePreview.toLowerCase()).not.toContain("álvarez");
      expect(mixedResult.redactedNoticePreview).toContain("pay the bill");
      expect(mixedResult.redactedNoticePreview).toContain("energy billing");
    }
  });

  it("protects the same salutation across unicode representations and keeps the original slice", () => {
    const nfc = "José Álvarez";
    const nfd = "Jose\u0301 A\u0301lvarez";
    const spaced = "José\u00A0Álvarez";
    const narrow = "José\u202FÁlvarez";
    const tabbed = "José\tÁlvarez";
    const broken = "José\nÁlvarez";
    const fullwidthDear = "\uFF24\uFF45\uFF41\uFF52";
    const forms = [
      `Dear ${nfc},`,
      `Dear ${nfd},`,
      `Dear ${spaced},`,
      `Dear ${narrow},`,
      `Dear ${tabbed},`,
      `Dear ${broken},`,
      `Dear\u200B${nfc},`,
      `${fullwidthDear} ${nfc},`,
      `Dear Jos\u200Bé Álvarez,`,
    ];
    for (const line of forms) {
      const raw = shell([line, "Account reference: AB-1234"]);
      const result = brief(raw);
      expect(result.ok, line).toBe(true);
      if (!result.ok) {
        continue;
      }
      expect(result.redactedNoticePreview.toLowerCase(), line).not.toContain("jose");
      expect(result.redactedNoticePreview, line).not.toContain("Álvarez");
      expect(result.redactedNoticePreview, line).not.toContain("\u0301");
      const nameEntry = result.localIdentifierMap.entries.find((entry) => entry.kind === "recipient_name");
      expect(nameEntry, line).toBeTruthy();
      if (!nameEntry) {
        continue;
      }
      expect(raw.slice(nameEntry.startOffset, nameEntry.endOffset)).toBe(nameEntry.rawValue);
    }

    const both = shell([`Dear ${nfc},`, `Dear ${nfd},`]);
    const combined = brief(both);
    expect(combined.ok).toBe(true);
    if (combined.ok) {
      const placeholders = combined.localIdentifierMap.entries
        .filter((entry) => entry.rawValue.normalize("NFKC").toLowerCase().includes("jos"))
        .map((entry) => entry.placeholder);
      expect(new Set(placeholders).size).toBe(1);
      expect(combined.redactedNoticePreview).not.toContain(nfc);
      expect(combined.redactedNoticePreview).not.toContain("\u0301");
    }
  });

  it("does not treat an ungreeted name as recognised, and keeps it out of canonical v2", () => {
    const raw = shell(["The occupier line names Jordan Hale beside the bill."]);
    const result = brief(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.redactedNoticePreview).toContain("Jordan Hale");
      expect(result.localIdentifierMap.entries.some((entry) => entry.rawValue.includes("Jordan"))).toBe(
        false
      );
    }
    const view = groundNoticeFacts({ rawNoticeText: raw, today: TODAY });
    const inspection = buildClosedCloudInspection({
      rawNoticeText: raw,
      view,
      responseGoal: "request_billing_review",
    });
    expect(inspection.exactSerialized).toBeTruthy();
    expect(inspection.exactSerialized).not.toContain("Jordan");
    expect(inspection.exactSerialized).not.toContain("Hale");
  });

  it("protects labelled references, short tails, and repeated forms without redacting ordinary numbers", () => {
    const labelled = [
      "Account Ref AB_1234",
      "Account Ref AB-1234",
      "Account Ref AB/1234",
      "Account Ref AB 1234",
      "Account Ref AB.1234",
      "Account Ref AB:1234",
      "Account Ref AB1234",
      "Customer ID X7",
      "Reference 0042",
      "Meter ID M-92",
      "Account Ref AB\u20131234",
      "Account Ref AB\u20441234",
      "Account Ref AB\u22151234",
      "Account Ref \uFF21\uFF22-\uFF11\uFF12\uFF13\uFF14",
      "Account Ref AB-12_34",
      "Account Ref AB-1234.",
      "Account Ref SMITH,4471",
      "Account Ref SMITH+4471",
      "Account Ref SMITH~4471",
      "Account Ref SMITH*4471",
    ];
    for (const line of labelled) {
      const raw = shell([`Dear José Álvarez,`, line]);
      const token = line.replace(/^(?:Account Ref|Customer ID|Reference|Meter ID)\s+/i, "").replace(/\.$/, "");
      expectProtected(raw, ["José Álvarez", token, "SMITH", "4471"].filter((secret) => raw.includes(secret)));
    }

    const repeated = shell([
      "Dear José Álvarez,",
      "Account Ref AB-1234 and again AB-1234 after the bill.",
    ]);
    const repeatedResult = brief(repeated);
    expect(repeatedResult.ok).toBe(true);
    if (repeatedResult.ok) {
      expect(repeatedResult.redactedNoticePreview).not.toContain("AB-1234");
      const refs = repeatedResult.localIdentifierMap.entries.filter((entry) => entry.rawValue === "AB-1234");
      expect(refs.length).toBeGreaterThan(1);
      expect(new Set(refs.map((entry) => entry.placeholder)).size).toBe(1);
    }

    const ordinary = shell([
      "Dear José Álvarez,",
      "A page number 42 and an unlabelled 0042 stay beside the bill.",
      "The code 2026 is a year, and £40 is not an account.",
    ]);
    const ordinaryResult = brief(ordinary);
    expect(ordinaryResult.ok).toBe(true);
    if (ordinaryResult.ok) {
      expect(ordinaryResult.redactedNoticePreview).toContain("page number 42");
      expect(ordinaryResult.redactedNoticePreview).toContain("unlabelled 0042");
      expect(ordinaryResult.redactedNoticePreview).toContain("£40");
      expect(ordinaryResult.redactedNoticePreview).toContain("2026");
      expect(ordinaryResult.redactedNoticePreview).not.toContain("José");
    }
  });

  it("keeps placeholder tokens free of raw fragments and refuses a colliding or malformed restore", () => {
    const raw = shell(["Dear José Álvarez,", "Account Ref AB-1234", "Customer ID X7"]);
    const result = brief(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const account = result.localIdentifierMap.entries.find((entry) => entry.rawValue === "AB-1234");
    const other = result.localIdentifierMap.entries.find((entry) => entry.rawValue === "X7");
    expect(account?.placeholder).toBe("[ACCOUNT_REF]");
    expect(other?.placeholder).not.toBe(account?.placeholder);
    expect(account?.placeholder).not.toContain("1234");
    expect(other?.placeholder).not.toContain("X7");

    const collided = applyPlaceholderBindings("Account [ACCOUNT_REF] and [ACCOUNT_REF].", [
      { placeholder: "[ACCOUNT_REF]", localValue: "AB-1234" },
      { placeholder: "[ACCOUNT_REF]", localValue: "CD-5678" },
    ]);
    expect(collided.personalised).toBe("Account [ACCOUNT_REF] and [ACCOUNT_REF].");
    expect(collided.personalised).not.toContain("AB-1234");
    expect(collided.personalised).not.toContain("CD-5678");

    const same = applyPlaceholderBindings("Hello [RECIPIENT_NAME]", [
      { placeholder: "[RECIPIENT_NAME]", localValue: "José Álvarez" },
      { placeholder: "[RECIPIENT_NAME]", localValue: "Jose\u0301 Álvarez" },
    ]);
    expect(same.personalised).toContain("José");
    expect(same.personalised).not.toContain("[RECIPIENT_NAME]");

    const malformed = applyPlaceholderBindings("See [ACCOUNT_REF and [ACCOUNT_REFX].", [
      { placeholder: "[ACCOUNT_REF]", localValue: "AB-1234" },
      { placeholder: "[ACCOUNT_REFX]", localValue: "AB-1234" },
    ]);
    expect(malformed.personalised).not.toContain("AB-1234");
    expect(malformed.personalised).toContain("[ACCOUNT_REF");

    expect(hasPartialPlaceholderIdentifier("[ACCOUNT_REF],4471")).toBe(true);
    expect(hasPartialPlaceholderIdentifier("[ACCOUNT_REF]\u20444471")).toBe(true);
    expect(hasPartialPlaceholderIdentifier("[ACCOUNT_REF]X7")).toBe(true);
    expect(hasPartialPlaceholderIdentifier("[ACCOUNT_REF] today")).toBe(false);

    const planted = shell(["Dear José Álvarez,", "The letter already says [ACCOUNT_REF].", "Account Ref AB-1234"]);
    const plantedResult = brief(planted);
    expect(plantedResult.ok).toBe(false);
    if (!plantedResult.ok) {
      expect(plantedResult.reasons.join(" ")).toMatch(/placeholder-like/);
      expect(plantedResult.reasons.join(" ")).not.toContain("AB-1234");
    }
  });

  it("keeps financial facts and exact offsets when identifiers sit beside amounts", () => {
    const shared = original.replace("Account reference: EXAMPLE-8472", "Account reference: AB-1280");
    const beside = `${shared}\nDear José Álvarez, the meter is M\u201192. Customer ID X7.`;
    const view = groundNoticeFacts({ rawNoticeText: beside, today: TODAY });
    expect(view.amount.verifiedForDisplay).toBe(1280);
    expect(view.issueDate.iso).toBe("2026-11-18");
    expect(view.issueDate.stated).toBe("18 November 2026");
    const verification = view.amount.verification;
    expect(verification?.startOffset).not.toBeNull();
    expect(beside.slice(verification?.startOffset ?? 0, verification?.endOffset ?? 0)).toContain("£1,280");

    const inspection = buildClosedCloudInspection({
      rawNoticeText: beside,
      view,
      responseGoal: "request_billing_review",
    });
    expect(inspection.exactSerialized).toContain('"amountsGBP":[1280]');
    expect(inspection.exactSerialized).not.toContain("AB-1280");
    expect(inspection.exactSerialized).not.toContain("José");
    expect(inspection.exactSerialized).not.toContain("X7");
    expect(inspection.exactSerialized).not.toContain("M-92");
    expect(inspection.exactSerialized).not.toContain("EXAMPLE");

    const bare = "Dear José Álvarez, account reference AB-1234.";
    const bareView = groundNoticeFacts({ rawNoticeText: bare, today: TODAY });
    expect(bareView.amount.verifiedForDisplay).toBeNull();
    expect(bareView.amount.amountsGBP).toEqual([]);
  });

  it("builds a canonical v2 payload with no personal identifiers or extra keys", () => {
    const raw = `${original}\nDear José Álvarez,\nAccount Ref AB_1234. Customer ID X7. Meter ID M-92.\nWrite to jose@example.com or 07700 900123.`;
    const view = groundNoticeFacts({ rawNoticeText: raw, today: TODAY });
    const inspection = buildClosedCloudInspection({
      rawNoticeText: raw,
      view,
      responseGoal: "request_billing_review",
    });
    const serialized = inspection.exactSerialized ?? "";
    expect(serialized.startsWith('{"schemaVersion":"noticelens.cloud-brief.v2"')).toBe(true);
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    const allowed = new Set<string>([...CLOSED_CLOUD_BRIEF_ROOT_KEYS, ...CLOSED_CLOUD_BRIEF_OPTIONAL_KEYS]);
    for (const key of Object.keys(parsed)) {
      expect(allowed.has(key), key).toBe(true);
    }
    expect(parsed.amountsGBP).toEqual([1280]);
    expect(parsed.issueDate).toBe("2026-11-18");
    expect(parsed.responseDeadlines).toContain("2026-11-25");
    const leaked = [
      "José",
      "Álvarez",
      "Sarah",
      "Example",
      "AB_1234",
      "EXAMPLE-8472",
      "8472",
      "X7",
      "M-92",
      "jose@example.com",
      "07700",
      "RG0",
      "Example Road",
      "localIdentifierMap",
      "redactedClause",
      "sourceQuote",
      "rawNoticeText",
      "startOffset",
    ];
    for (const secret of leaked) {
      expect(serialized, secret).not.toContain(secret);
    }
    const obligations = parsed.obligations as Array<Record<string, unknown>>;
    for (const item of obligations) {
      expect(Object.keys(item).sort()).toEqual(["actionSummary", "dueDate"]);
    }

    expect(() =>
      canonicalClosedCloudBrief({
        ...parsed,
        accountReference: "AB-1234",
      })
    ).toThrow(/unexpected key|forbidden key/);
    expect(() =>
      canonicalClosedCloudBrief({
        ...parsed,
        noticeCategory: "AB-1234",
      })
    ).toThrow(/noticeCategory/);
    expect(() =>
      canonicalClosedCloudBrief({
        ...parsed,
        responseGoal: "Dear José Álvarez",
      })
    ).toThrow(/responseGoal/);
    expect(() =>
      canonicalClosedCloudBrief({
        ...parsed,
        guidanceIds: ["AB-1234"],
      })
    ).toThrow(/guidance/);
    expect(() =>
      canonicalClosedCloudBrief({
        ...parsed,
        obligations: [{ actionSummary: "pay AB-1234", dueDate: "2026-11-25", redactedClause: "José Álvarez" }],
      })
    ).toThrow(/actionSummary|forbidden key|unexpected key|v1 payload/);

    const revisedView = groundNoticeFacts({ rawNoticeText: revised, today: TODAY });
    const revisedInspection = buildClosedCloudInspection({
      rawNoticeText: revised,
      view: revisedView,
      responseGoal: "request_billing_review",
    });
    expect(revisedInspection.exactSerialized).toContain('"amountsGBP":[520]');
    expect(revisedInspection.exactSerialized).toContain("2026-12-02");
    expect(revisedInspection.exactSerialized).toContain("2026-12-16");
    expect(revisedInspection.exactSerialized).not.toContain("1280");
    expect(revisedInspection.exactSerialized).not.toContain("Sarah");
  });

  it("does not put a private value into a validation error", () => {
    let message = "";
    try {
      canonicalClosedCloudBrief({
        schemaVersion: "noticelens.cloud-brief.v2",
        noticeCategory: "utility_electricity",
        accountReference: "AB-1234",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain("AB-1234");
  });
});

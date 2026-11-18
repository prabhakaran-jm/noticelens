import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildClosedCloudBrief } from "../../src/adapters/buildClosedCloudBrief";
import {
  displayVerifiedAmount,
  displayVerifiedIssueDate,
  groundNoticeFacts,
  verifiedResponseDeadlineIso,
} from "../../src/adapters/groundNoticeFacts";
import { CLOUD_SUBMISSION_ENABLED } from "../../src/adapters/cloudApprovalSession";
import {
  compareNoticeTexts,
  type ComparisonRelationship,
  type DeadlineRole,
} from "../../src/domain/compareNotices";
import { parseCalendarDate } from "../../src/domain/dates";
import { normalizeNewlines } from "../../src/domain/textNormalize";
import type { SourceAmountAuthority } from "../../src/domain/sourceGrounding";

const TODAY = "2026-11-13";
const original = normalizeNewlines(readFileSync("examples/energy-backbill-original.txt", "utf8"));
const revised = normalizeNewlines(readFileSync("examples/energy-backbill-revised.txt", "utf8"));

function letter(body: string, heading = "18 November 2026"): string {
  return `Northwind Energy\n\n${heading}\n\nDear A Example,\n\n${body}\n`;
}

interface CaseRow {
  name: string;
  original: string;
  revised: string;
  originalAmount: number | null;
  revisedAmount: number | null;
  relationship: ComparisonRelationship;
  reason: string;
  difference: number | null;
  originalIssue: string | null;
  revisedIssue: string | null;
  originalDeadline: string | null;
  revisedDeadline: string | null;
  originalRole: DeadlineRole | null;
  revisedRole: DeadlineRole | null;
  originalIssueAuthority?: SourceAmountAuthority;
  revisedIssueAuthority?: SourceAmountAuthority;
  originalDeadlineAuthority?: SourceAmountAuthority;
  revisedDeadlineAuthority?: SourceAmountAuthority;
}

const sameLiability = (amount: string, extra = "") =>
  letter(
    `Account reference: A-100\nYour outstanding balance of ${amount} is for electricity supplied between January and June 2025.\nPlease pay the outstanding balance by 30 November 2026.\n${extra}`
  );

const rows: CaseRow[] = [
  {
    name: "demo shares an account and the word revised, which is not a supported link",
    original,
    revised,
    originalAmount: 1280,
    revisedAmount: 520,
    relationship: "RELATIONSHIP_UNVERIFIED",
    reason: "shared_account_only",
    difference: null,
    originalIssue: "18 November 2026",
    revisedIssue: "2 December 2026",
    originalDeadline: "25 November 2026",
    revisedDeadline: "16 December 2026",
    originalRole: "payment",
    revisedRole: "contact",
  },
  {
    name: "same account, fuel, and period",
    original: sameLiability("£640"),
    revised: sameLiability("£520"),
    originalAmount: 640,
    revisedAmount: 520,
    relationship: "COMPARABLE",
    reason: "same_account_fuel_period",
    difference: -120,
    originalIssue: "18 November 2026",
    revisedIssue: "18 November 2026",
    originalDeadline: "30 November 2026",
    revisedDeadline: "30 November 2026",
    originalRole: "payment",
    revisedRole: "payment",
  },
  {
    name: "same liability and the same amount is unchanged",
    original: sameLiability("£640"),
    revised: sameLiability("£640"),
    originalAmount: 640,
    revisedAmount: 640,
    relationship: "COMPARABLE",
    reason: "same_account_fuel_period",
    difference: 0,
    originalIssue: "18 November 2026",
    revisedIssue: "18 November 2026",
    originalDeadline: "30 November 2026",
    revisedDeadline: "30 November 2026",
    originalRole: "payment",
    revisedRole: "payment",
  },
  {
    name: "same amount without identity is not unchanged",
    original: letter("Your outstanding balance is £640.\nPlease pay the outstanding balance by 30 November 2026."),
    revised: letter("Your outstanding balance is £640.\nPlease pay the outstanding balance by 30 November 2026."),
    originalAmount: 640,
    revisedAmount: 640,
    relationship: "RELATIONSHIP_UNVERIFIED",
    reason: "missing_identity",
    difference: null,
    originalIssue: "18 November 2026",
    revisedIssue: "18 November 2026",
    originalDeadline: "30 November 2026",
    revisedDeadline: "30 November 2026",
    originalRole: "payment",
    revisedRole: "payment",
  },
  {
    name: "different accounts",
    original: sameLiability("£640"),
    revised: letter(
      "Account reference: B-200\nYour outstanding balance of £520 is for electricity supplied between January and June 2025.\nPlease pay the outstanding balance by 30 November 2026."
    ),
    originalAmount: 640,
    revisedAmount: 520,
    relationship: "NOT_COMPARABLE",
    reason: "different_account",
    difference: null,
    originalIssue: "18 November 2026",
    revisedIssue: "18 November 2026",
    originalDeadline: "30 November 2026",
    revisedDeadline: "30 November 2026",
    originalRole: "payment",
    revisedRole: "payment",
  },
  {
    name: "different fuels",
    original: sameLiability("£640"),
    revised: letter(
      "Account reference: A-100\nYour outstanding balance of £520 is for gas supplied between January and June 2025.\nPlease pay the outstanding balance by 30 November 2026."
    ),
    originalAmount: 640,
    revisedAmount: 520,
    relationship: "NOT_COMPARABLE",
    reason: "different_fuel",
    difference: null,
    originalIssue: "18 November 2026",
    revisedIssue: "18 November 2026",
    originalDeadline: "30 November 2026",
    revisedDeadline: "30 November 2026",
    originalRole: "payment",
    revisedRole: "payment",
  },
  {
    name: "different billing periods",
    original: sameLiability("£640"),
    revised: letter(
      "Account reference: A-100\nYour outstanding balance of £520 is for electricity supplied between July and December 2025.\nPlease pay the outstanding balance by 30 November 2026."
    ),
    originalAmount: 640,
    revisedAmount: 520,
    relationship: "NOT_COMPARABLE",
    reason: "different_period",
    difference: null,
    originalIssue: "18 November 2026",
    revisedIssue: "18 November 2026",
    originalDeadline: "30 November 2026",
    revisedDeadline: "30 November 2026",
    originalRole: "payment",
    revisedRole: "payment",
  },
  {
    name: "same invoice number without a creditor is not a verified reduction",
    original: letter("Invoice 1001. Your outstanding balance is £640.\nPlease pay the outstanding balance by 30 November 2026."),
    revised: letter("Invoice 1001. The balance now requested is £520.\nPlease pay the outstanding balance by 16 December 2026."),
    originalAmount: 640,
    revisedAmount: 520,
    relationship: "RELATIONSHIP_UNVERIFIED",
    reason: "shared_invoice_only",
    difference: null,
    originalIssue: "18 November 2026",
    revisedIssue: "18 November 2026",
    originalDeadline: "30 November 2026",
    revisedDeadline: "16 December 2026",
    originalRole: "payment",
    revisedRole: "payment",
  },
  {
    name: "an explicit replacement of a different invoice is not a verified reduction",
    original: letter("Invoice 1001. Your outstanding balance is £640.\nPlease pay the outstanding balance by 30 November 2026."),
    revised: letter(
      "This statement replaces invoice 1001.\nInvoice 1001A. The balance now requested is £520.\nPlease pay the outstanding balance by 16 December 2026."
    ),
    originalAmount: 640,
    revisedAmount: 520,
    relationship: "RELATIONSHIP_UNVERIFIED",
    reason: "ambiguous_identifiers",
    difference: null,
    originalIssue: "18 November 2026",
    revisedIssue: "18 November 2026",
    originalDeadline: "30 November 2026",
    revisedDeadline: "16 December 2026",
    originalRole: "payment",
    revisedRole: "payment",
  },
  {
    name: "different invoices are not treated as unrelated or as the same bill",
    original: letter("Invoice 1001. Your outstanding balance is £640.\nPlease pay the outstanding balance by 30 November 2026."),
    revised: letter(
      "Invoice 1001A. The balance now requested is £520.\nPlease pay the outstanding balance by 16 December 2026."
    ),
    originalAmount: 640,
    revisedAmount: 520,
    relationship: "RELATIONSHIP_UNVERIFIED",
    reason: "different_invoice_unresolved",
    difference: null,
    originalIssue: "18 November 2026",
    revisedIssue: "18 November 2026",
    originalDeadline: "30 November 2026",
    revisedDeadline: "16 December 2026",
    originalRole: "payment",
    revisedRole: "payment",
  },
  {
    name: "both say electricity and nothing else",
    original: letter("Your outstanding balance of £640 is for electricity.\nPlease pay the outstanding balance by 30 November 2026."),
    revised: letter("Your outstanding balance of £520 is for electricity.\nPlease pay the outstanding balance by 30 November 2026."),
    originalAmount: 640,
    revisedAmount: 520,
    relationship: "RELATIONSHIP_UNVERIFIED",
    reason: "shared_fuel_only",
    difference: null,
    originalIssue: "18 November 2026",
    revisedIssue: "18 November 2026",
    originalDeadline: "30 November 2026",
    revisedDeadline: "30 November 2026",
    originalRole: "payment",
    revisedRole: "payment",
  },
  {
    name: "the word revised without an identity link",
    original: letter("Your outstanding balance is £640.\nPlease pay the outstanding balance by 30 November 2026."),
    revised: letter("Revised statement.\nThe balance now requested is £520.\nPlease contact us by 16 December 2026."),
    originalAmount: 640,
    revisedAmount: 520,
    relationship: "RELATIONSHIP_UNVERIFIED",
    reason: "missing_identity",
    difference: null,
    originalIssue: "18 November 2026",
    revisedIssue: "18 November 2026",
    originalDeadline: "30 November 2026",
    revisedDeadline: "16 December 2026",
    originalRole: "payment",
    revisedRole: "contact",
  },
  {
    name: "a copied account reference is not the current account",
    original: letter(
      "Copy of our earlier letter.\nAccount reference: OLD-9\nYour outstanding balance is £100.\n\nAccount reference: A-100\nYour outstanding balance of £640 is for electricity supplied between January and June 2025.\nPlease pay the outstanding balance by 30 November 2026."
    ),
    revised: sameLiability("£520"),
    originalAmount: 640,
    revisedAmount: 520,
    relationship: "COMPARABLE",
    reason: "same_account_fuel_period",
    difference: -120,
    originalIssue: "18 November 2026",
    revisedIssue: "18 November 2026",
    originalDeadline: "30 November 2026",
    revisedDeadline: "30 November 2026",
    originalRole: "payment",
    revisedRole: "payment",
  },
  {
    name: "only a copied account leaves the relationship unverified",
    original: letter("Copy of our earlier letter.\nAccount reference: OLD-9\nYour outstanding balance is £640.\nPlease pay the outstanding balance by 30 November 2026."),
    revised: letter("Copy of our earlier letter.\nAccount reference: OLD-9\nYour outstanding balance is £520.\nPlease pay the outstanding balance by 30 November 2026."),
    originalAmount: null,
    revisedAmount: null,
    relationship: "BALANCE_UNVERIFIED",
    reason: "balance_unverified",
    difference: null,
    originalIssue: "18 November 2026",
    revisedIssue: "18 November 2026",
    originalDeadline: null,
    revisedDeadline: null,
    originalRole: null,
    revisedRole: null,
  },
  {
    name: "an instalment is not compared with a total",
    original: sameLiability("£640"),
    revised: letter(
      "Account reference: A-100\nYour outstanding balance of £40 a month is for electricity supplied between January and June 2025.\nPlease pay the outstanding balance by 30 November 2026."
    ),
    originalAmount: 640,
    revisedAmount: 40,
    relationship: "NOT_COMPARABLE",
    reason: "instalment_versus_total",
    difference: null,
    originalIssue: "18 November 2026",
    revisedIssue: "18 November 2026",
    originalDeadline: "30 November 2026",
    revisedDeadline: "30 November 2026",
    originalRole: "payment",
    revisedRole: "payment",
  },
  {
    name: "a stated zero is not a verified balance",
    original: letter("The outstanding balance of £0 is shown here."),
    revised: sameLiability("£520"),
    originalAmount: null,
    revisedAmount: 520,
    relationship: "BALANCE_UNVERIFIED",
    reason: "balance_unverified",
    difference: null,
    originalIssue: "18 November 2026",
    revisedIssue: "18 November 2026",
    originalDeadline: null,
    revisedDeadline: "30 November 2026",
    originalRole: null,
    revisedRole: "payment",
  },
  {
    name: "one withheld balance produces no difference",
    original: letter("Imagine your outstanding balance is £640."),
    revised: sameLiability("£520"),
    originalAmount: null,
    revisedAmount: 520,
    relationship: "BALANCE_UNVERIFIED",
    reason: "balance_unverified",
    difference: null,
    originalIssue: "18 November 2026",
    revisedIssue: "18 November 2026",
    originalDeadline: null,
    revisedDeadline: "30 November 2026",
    originalRole: null,
    revisedRole: "payment",
  },
  {
    name: "header issue date is kept and a payment-received date is not",
    original: "Northwind Energy\n\n18 November 2026\n\nPayment received\nDate: 3 October 2026\n\nDear A Example,\n\nYour outstanding balance is £640.\nPlease pay the outstanding balance by 30 November 2026.\n",
    revised: "No figures are stated.",
    originalAmount: 640,
    revisedAmount: null,
    relationship: "BALANCE_UNVERIFIED",
    reason: "balance_unverified",
    difference: null,
    originalIssue: "18 November 2026",
    revisedIssue: null,
    originalDeadline: "30 November 2026",
    revisedDeadline: null,
    originalRole: "payment",
    revisedRole: null,
    revisedIssueAuthority: "not_stated",
    revisedDeadlineAuthority: "not_stated",
  },
  {
    name: "an engineer appointment is not the notice date",
    original: "Northwind Energy\n\n18 November 2026\n\nEngineer visit\nDate: 4 October 2026\n\nDear A Example,\n\nYour outstanding balance is £640.\n",
    revised: "No figures are stated.",
    originalAmount: 640,
    revisedAmount: null,
    relationship: "BALANCE_UNVERIFIED",
    reason: "balance_unverified",
    difference: null,
    originalIssue: "18 November 2026",
    revisedIssue: null,
    originalDeadline: null,
    revisedDeadline: null,
    originalRole: null,
    revisedRole: null,
    originalDeadlineAuthority: "not_stated",
  },
  {
    name: "a Direct Debit collection date is not the notice date",
    original: "Northwind Energy\n\n18 November 2026\n\nDirect Debit schedule\nDate: 5 October 2026\nNext collection\nDate: 6 October 2026\n\nDear A Example,\n\nYour outstanding balance is £640.\n",
    revised: "No figures are stated.",
    originalAmount: 640,
    revisedAmount: null,
    relationship: "BALANCE_UNVERIFIED",
    reason: "balance_unverified",
    difference: null,
    originalIssue: "18 November 2026",
    revisedIssue: null,
    originalDeadline: null,
    revisedDeadline: null,
    originalRole: null,
    revisedRole: null,
    originalDeadlineAuthority: "not_stated",
  },
  {
    name: "a copied historical deadline is not the current response deadline",
    original: letter(
      "Copy of our earlier payment notice.\nPlease pay the outstanding balance of £640 by 1 January 2024.\n\nYour outstanding balance is £520.\nPlease contact us by 1 December 2026."
    ),
    revised: "No figures are stated.",
    originalAmount: 520,
    revisedAmount: null,
    relationship: "BALANCE_UNVERIFIED",
    reason: "balance_unverified",
    difference: null,
    originalIssue: "18 November 2026",
    revisedIssue: null,
    originalDeadline: "1 December 2026",
    revisedDeadline: null,
    originalRole: "contact",
    revisedRole: null,
  },
  {
    name: "two competing issue dates are not verified",
    original: "Northwind Energy\n\n18 November 2026\n\n2 December 2026\n\nDear A Example,\n\nYour outstanding balance is £640.\nPlease pay the outstanding balance by 30 November 2026.\n",
    revised: "No figures are stated.",
    originalAmount: 640,
    revisedAmount: null,
    relationship: "BALANCE_UNVERIFIED",
    reason: "balance_unverified",
    difference: null,
    originalIssue: null,
    revisedIssue: null,
    originalDeadline: "30 November 2026",
    revisedDeadline: null,
    originalRole: "payment",
    revisedRole: null,
    originalIssueAuthority: "conflicting",
  },
  {
    name: "a verified payment deadline stays a payment deadline",
    original: letter("Your outstanding balance is £640.\nPlease pay the outstanding balance by 30 November 2026."),
    revised: "No figures are stated.",
    originalAmount: 640,
    revisedAmount: null,
    relationship: "BALANCE_UNVERIFIED",
    reason: "balance_unverified",
    difference: null,
    originalIssue: "18 November 2026",
    revisedIssue: null,
    originalDeadline: "30 November 2026",
    revisedDeadline: null,
    originalRole: "payment",
    revisedRole: null,
  },
  {
    name: "a contact-only deadline stays a contact deadline",
    original: letter("Your outstanding balance is £640.\nPlease contact us by 16 December 2026."),
    revised: "No figures are stated.",
    originalAmount: 640,
    revisedAmount: null,
    relationship: "BALANCE_UNVERIFIED",
    reason: "balance_unverified",
    difference: null,
    originalIssue: "18 November 2026",
    revisedIssue: null,
    originalDeadline: "16 December 2026",
    revisedDeadline: null,
    originalRole: "contact",
    revisedRole: null,
  },
  {
    name: "a missing response deadline is not invented",
    original: letter("Your outstanding balance is £640."),
    revised: "No figures are stated.",
    originalAmount: 640,
    revisedAmount: null,
    relationship: "BALANCE_UNVERIFIED",
    reason: "balance_unverified",
    difference: null,
    originalIssue: "18 November 2026",
    revisedIssue: null,
    originalDeadline: null,
    revisedDeadline: null,
    originalRole: null,
    revisedRole: null,
    originalDeadlineAuthority: "not_stated",
  },
  {
    name: "a revised notice can carry a new response obligation without linking the debt",
    original: letter("Your outstanding balance is £640.\nPlease pay the outstanding balance by 30 November 2026."),
    revised: letter("Your outstanding balance is £520.\nPlease contact us by 16 December 2026.", "2 December 2026"),
    originalAmount: 640,
    revisedAmount: 520,
    relationship: "RELATIONSHIP_UNVERIFIED",
    reason: "missing_identity",
    difference: null,
    originalIssue: "18 November 2026",
    revisedIssue: "2 December 2026",
    originalDeadline: "30 November 2026",
    revisedDeadline: "16 December 2026",
    originalRole: "payment",
    revisedRole: "contact",
  },
  {
    name: "two notices with no stated amount do not become zero",
    original: "No figures are stated.",
    revised: "Still no figures.",
    originalAmount: null,
    revisedAmount: null,
    relationship: "BALANCE_UNVERIFIED",
    reason: "balance_unverified",
    difference: null,
    originalIssue: null,
    revisedIssue: null,
    originalDeadline: null,
    revisedDeadline: null,
    originalRole: null,
    revisedRole: null,
    originalIssueAuthority: "not_stated",
    revisedIssueAuthority: "not_stated",
  },
];

describe("Phase 5B-3 comparison authority", () => {
  it.each(rows)("$name", (row) => {
    const comparison = compareNoticeTexts(row.original, row.revised, { today: TODAY });
    expect(comparison.amount.value, row.name).toBe(row.originalAmount);
    expect(comparison.amount.revised, row.name).toBe(row.revisedAmount);
    if (row.reason === "shared_account_only") {
      expect(comparison.localIdentity.original.accounts, row.name).toEqual(["example-8472"]);
      expect(comparison.localIdentity.revised.accounts, row.name).toEqual(["example-8472"]);
      expect(comparison.localIdentity.revised.fuels, row.name).toEqual([]);
      expect(comparison.localIdentity.revised.periods, row.name).toEqual([]);
    }
    if (row.reason === "same_account_fuel_period") {
      expect(comparison.localIdentity.original.accounts, row.name).toEqual(["a-100"]);
      expect(comparison.localIdentity.revised.accounts, row.name).toEqual(["a-100"]);
      expect(comparison.localIdentity.original.accounts, row.name).not.toContain("old-9");
    }
    if (row.reason === "different_invoice_unresolved") {
      expect(comparison.localIdentity.original.invoices, row.name).toEqual(["1001"]);
      expect(comparison.localIdentity.revised.invoices, row.name).toEqual(["1001a"]);
    }
    expect(comparison.relationship, row.name).toBe(row.relationship);
    expect(comparison.relationshipReason, row.name).toBe(row.reason);
    expect(comparison.amount.differenceGBP, row.name).toBe(row.difference);
    if (row.relationship !== "COMPARABLE") {
      expect(comparison.amount.differenceGBP, row.name).toBeNull();
      expect(comparison.amount.status, row.name).not.toBe("unchanged");
    }
    expect(comparison.issueDate.original, row.name).toBe(row.originalIssue);
    expect(comparison.issueDate.revised, row.name).toBe(row.revisedIssue);
    expect(comparison.issueDate.original, row.name).not.toBe("3 October 2026");
    expect(comparison.issueDate.original, row.name).not.toBe("4 October 2026");
    expect(comparison.issueDate.original, row.name).not.toBe("5 October 2026");
    expect(comparison.issueDate.original, row.name).not.toBe("6 October 2026");
    expect(comparison.responseDeadline.value, row.name).toBe(row.originalDeadline);
    expect(comparison.responseDeadline.revised, row.name).toBe(row.revisedDeadline);
    expect(comparison.responseDeadline.originalRole, row.name).toBe(row.originalRole);
    expect(comparison.responseDeadline.revisedRole, row.name).toBe(row.revisedRole);
    expect(comparison.responseDeadline.value, row.name).not.toBe("1 January 2024");
    if (row.originalIssueAuthority) {
      expect(comparison.issueDate.originalAuthority, row.name).toBe(row.originalIssueAuthority);
    }
    if (row.revisedIssueAuthority) {
      expect(comparison.issueDate.revisedAuthority, row.name).toBe(row.revisedIssueAuthority);
    }
    if (row.originalDeadlineAuthority) {
      expect(comparison.responseDeadline.originalAuthority, row.name).toBe(row.originalDeadlineAuthority);
    }
    if (row.revisedDeadlineAuthority) {
      expect(comparison.responseDeadline.revisedAuthority, row.name).toBe(row.revisedDeadlineAuthority);
    }
    if (row.originalRole !== row.revisedRole) {
      expect(comparison.responseDeadline.laterByCalendarDays, row.name).toBeNull();
    }
  });

  it("agrees with Read Notice and v2 on issue dates and response deadlines", () => {
    const samples = [
      original,
      revised,
      sameLiability("£640"),
      letter("Your outstanding balance is £640.\nPlease contact us by 16 December 2026."),
      letter("Your outstanding balance is £640."),
      "Northwind Energy\n\n18 November 2026\n\nPayment received\nDate: 3 October 2026\n\nDear A Example,\n\nYour outstanding balance is £640.\nPlease pay the outstanding balance by 30 November 2026.\n",
    ];
    for (const text of samples) {
      const view = groundNoticeFacts({ rawNoticeText: text, today: TODAY });
      const payload = buildClosedCloudBrief({ view, responseGoal: "request_billing_review" }).payload;
      const comparison = compareNoticeTexts(text, "No figures are stated.", { today: TODAY });
      expect(comparison.amount.value).toBe(displayVerifiedAmount(view));
      expect(comparison.amount.value).toBe(payload.amountsGBP.length === 1 ? payload.amountsGBP[0]! : null);
      expect(comparison.issueDate.original).toBe(displayVerifiedIssueDate(view));
      const issueIso = comparison.issueDate.original
        ? parseCalendarDate(comparison.issueDate.original)?.iso ?? null
        : null;
      expect(payload.issueDate).toBe(issueIso);
      const deadlineIso = comparison.responseDeadline.value
        ? parseCalendarDate(comparison.responseDeadline.value)?.iso ?? null
        : null;
      expect(deadlineIso).toBe(verifiedResponseDeadlineIso(view));
      expect(payload.responseDeadlines).toEqual(deadlineIso ? [deadlineIso] : []);
    }
  });

  it("does not describe a lower comparable balance as recovered money", () => {
    const comparison = compareNoticeTexts(sameLiability("£640"), sameLiability("£520"), { today: TODAY });
    expect(comparison.relationship).toBe("COMPARABLE");
    expect(comparison.amount.differenceGBP).toBe(-120);
    expect(JSON.stringify(comparison)).not.toMatch(/refund|recovered/i);
  });

  it("keeps cloud submission disabled and does not put identity into v2", () => {
    expect(CLOUD_SUBMISSION_ENABLED).toBe(false);
    const view = groundNoticeFacts({ rawNoticeText: original, today: TODAY });
    const payload = buildClosedCloudBrief({ view, responseGoal: "request_billing_review" }).payload;
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("EXAMPLE-8472");
    expect(serialized).not.toContain("RELATIONSHIP_UNVERIFIED");
    expect(serialized).not.toContain("localIdentity");
  });
});

describe("Phase 5B-3 comparison timing", () => {
  it("measures one settled comparison rather than one full comparison per keystroke", () => {
    const head = "Your outstanding balance is £640. Please pay the outstanding balance by 20 March 2026. ";
    const near = (head + "Note ".repeat(2000)).slice(0, 8000);
    const mixed = letter("Your outstanding balance is £640.\nPlease pay the outstanding balance by 30 November 2026.\nOur March letter said you owe £10.");
    const repeated = "Your outstanding balance is £1. ".repeat(80);
    const stress = "Your outstanding balance is £640. ".repeat(200);
    const time = (fn: () => void) => {
      const started = performance.now();
      fn();
      return performance.now() - started;
    };
    const demoGround = time(() => compareNoticeTexts(original, "No figures are stated."));
    const mixedGround = time(() => compareNoticeTexts(mixed, "No figures are stated."));
    const limitGround = time(() => compareNoticeTexts(near, "No figures are stated."));
    const repeatedGround = time(() => compareNoticeTexts(repeated, "No figures are stated."));
    const stressGround = time(() => compareNoticeTexts(stress, "No figures are stated."));
    const settled = time(() => compareNoticeTexts(original, revised));
    console.info(
      JSON.stringify({
        label: "node-vitest-after",
        demoGround,
        mixedGround,
        limitGround,
        repeatedGround,
        stressGround,
        settled,
      })
    );
    expect(demoGround).toBeLessThan(2000);
    expect(mixedGround).toBeLessThan(2000);
    expect(limitGround).toBeLessThan(2500);
    expect(repeatedGround).toBeLessThan(2500);
    expect(stressGround).toBeLessThan(2500);
    expect(settled).toBeLessThan(2500);
  });
});

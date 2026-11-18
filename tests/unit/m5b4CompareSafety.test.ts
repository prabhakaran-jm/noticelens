import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildClosedCloudBrief } from "../../src/adapters/buildClosedCloudBrief";
import { groundNoticeFacts } from "../../src/adapters/groundNoticeFacts";
import {
  CLOUD_SUBMISSION_ENABLED,
  createCloudApprovalSession,
  requestCloudSubmission,
} from "../../src/adapters/cloudApprovalSession";
import { requestClosedBriefSend } from "../../src/adapters/privacyApproval";
import { compareNoticeTexts } from "../../src/domain/compareNotices";
import { verifiedBalanceForSource } from "../../src/domain/sourceGrounding";
import {
  independentClaimLabel,
  labelledInvoiceTokens,
} from "../../src/domain/supportedNoticePolicy";
import { normalizeNewlines } from "../../src/domain/textNormalize";

const TODAY = "2026-11-13";
const original = normalizeNewlines(readFileSync("examples/energy-backbill-original.txt", "utf8"));
const revised = normalizeNewlines(readFileSync("examples/energy-backbill-revised.txt", "utf8"));

function letter(body: string): string {
  return `Northwind Energy\n\n18 November 2026\n\nDear A Example,\n\n${body}\n`;
}

function sameLiability(amount: string, extra = ""): string {
  return letter(
    `Account reference: A-100\nYour outstanding balance of ${amount} is for electricity supplied between January and June 2025.\nPlease pay the outstanding balance by 30 November 2026.\n${extra}`
  );
}

describe("Phase 5B-4 comparison safety", () => {
  it("does not turn invoice prefixes into identifiers", () => {
    expect(labelledInvoiceTokens("Invoices were sent.")).toEqual([]);
    expect(labelledInvoiceTokens("The bill was invoiced yesterday.")).toEqual([]);
    expect(labelledInvoiceTokens("Check the inventory and the invitation.")).toEqual([]);
    expect(labelledInvoiceTokens("This code is invalid. Do not involve the invoked file.")).toEqual([]);
    expect(independentClaimLabel("Invoices were sent.")).toBe("invoice-word:invoices");
    expect(independentClaimLabel("The bill was invoiced yesterday.")).toBe("invoice-word:invoiced");
    expect(independentClaimLabel("Check the inventory.")).toBeNull();
    expect(labelledInvoiceTokens("Invoice 1001 is due.")).toEqual(["1001"]);
    expect(labelledInvoiceTokens("Invoice A is due.")).toEqual(["a"]);
    expect(labelledInvoiceTokens("Inv-44 is due.")).toEqual(["44"]);
    expect(labelledInvoiceTokens("Inv #7 is due.")).toEqual(["7"]);
    expect(independentClaimLabel("Invoice 1001 is due.")).toBe("invoice:1001");
    expect(independentClaimLabel("Invoice A is due.")).toBe("invoice:a");
    expect(independentClaimLabel("Invoice S is due.")).toBe("invoice:s");
  });

  it("does not let the words invoices or invoiced merge with a real invoice letter", () => {
    expect(
      verifiedBalanceForSource(
        letter("Your outstanding balance is £520 on these invoices.\nInvoice B outstanding balance is £520.")
      ).amountGBP
    ).toBeNull();
    expect(
      verifiedBalanceForSource(
        letter("Your outstanding balance is £520 on these invoices.\nInvoice S outstanding balance is £520.")
      ).amountGBP
    ).toBeNull();
    expect(
      verifiedBalanceForSource(letter("Invoice A outstanding balance is £520.\nInvoice B outstanding balance is £520."))
        .amountGBP
    ).toBeNull();
    expect(
      verifiedBalanceForSource(
        letter("Your outstanding balance is £640.\nPlease pay the outstanding balance by 30 November 2026.")
      ).amountGBP
    ).toBe(640);
  });

  it("keeps a supported same-liability comparison and the demo unverified", () => {
    const supported = compareNoticeTexts(sameLiability("£640"), sameLiability("£520"), { today: TODAY });
    expect(supported.relationship).toBe("COMPARABLE");
    expect(supported.relationshipReason).toBe("same_account_fuel_period");
    expect(supported.amount.value).toBe(640);
    expect(supported.amount.revised).toBe(520);
    expect(supported.amount.differenceGBP).toBe(-120);
    expect(supported.issueDate.original).toBe("18 November 2026");
    expect(supported.responseDeadline.originalRole).toBe("payment");

    const demo = compareNoticeTexts(original, revised, { today: TODAY });
    expect(demo.relationship).toBe("RELATIONSHIP_UNVERIFIED");
    expect(demo.relationshipReason).toBe("shared_account_only");
    expect(demo.amount.value).toBe(1280);
    expect(demo.amount.revised).toBe(520);
    expect(demo.amount.differenceGBP).toBeNull();
    expect(demo.issueDate.original).toBe("18 November 2026");
    expect(demo.issueDate.revised).toBe("2 December 2026");
    expect(demo.responseDeadline.originalRole).toBe("payment");
    expect(demo.responseDeadline.revisedRole).toBe("contact");
    expect(demo.responseDeadline.revised).toBe("16 December 2026");
  });

  it("does not compare the same invoice number across different suppliers", () => {
    const comparison = compareNoticeTexts(
      letter(
        "Northwind is the supplier.\nInvoice 1001. Your outstanding balance is £640.\nPlease pay the outstanding balance by 30 November 2026."
      ),
      letter(
        "Example is the creditor.\nInvoice 1001. Your outstanding balance is £520.\nPlease pay the outstanding balance by 30 November 2026."
      ),
      { today: TODAY }
    );
    expect(comparison.amount.value).toBe(640);
    expect(comparison.amount.revised).toBe(520);
    expect(comparison.localIdentity.original.invoices).toEqual(["1001"]);
    expect(comparison.localIdentity.revised.invoices).toEqual(["1001"]);
    expect(comparison.relationship).toBe("RELATIONSHIP_UNVERIFIED");
    expect(comparison.relationshipReason).toBe("shared_invoice_only");
    expect(comparison.amount.differenceGBP).toBeNull();
  });

  it("ignores an invoice that appears only in copied correspondence", () => {
    const comparison = compareNoticeTexts(
      letter(
        "Copy of our earlier letter.\nInvoice 1001.\n\nYour outstanding balance is £640.\nPlease pay the outstanding balance by 30 November 2026."
      ),
      letter(
        "Copy of our earlier letter.\nInvoice 1001.\n\nYour outstanding balance is £520.\nPlease pay the outstanding balance by 30 November 2026."
      ),
      { today: TODAY }
    );
    expect(comparison.amount.value).toBe(640);
    expect(comparison.amount.revised).toBe(520);
    expect(comparison.localIdentity.original.invoices).toEqual([]);
    expect(comparison.localIdentity.revised.invoices).toEqual([]);
    expect(comparison.amount.differenceGBP).toBeNull();
    expect(comparison.relationship).not.toBe("COMPARABLE");
  });

  it("does not use an invoice that is not on the current claim", () => {
    const comparison = compareNoticeTexts(
      letter(
        "Your outstanding balance is £640.\nPlease pay the outstanding balance by 30 November 2026.\nInvoice 1001 is shown later."
      ),
      letter(
        "Your outstanding balance is £520.\nPlease pay the outstanding balance by 30 November 2026.\nInvoice 1001 is shown later."
      ),
      { today: TODAY }
    );
    expect(comparison.localIdentity.original.invoices).toEqual([]);
    expect(comparison.localIdentity.revised.invoices).toEqual([]);
    expect(comparison.amount.differenceGBP).toBeNull();
    expect(comparison.relationship).toBe("RELATIONSHIP_UNVERIFIED");
  });

  it("withholds when one sentence names two invoice identifiers", () => {
    const comparison = compareNoticeTexts(
      letter(
        "Invoice 1001 and invoice 1002. Your outstanding balance is £640.\nPlease pay the outstanding balance by 30 November 2026."
      ),
      letter(
        "Invoice 1001 and invoice 1002. Your outstanding balance is £520.\nPlease pay the outstanding balance by 30 November 2026."
      ),
      { today: TODAY }
    );
    expect(comparison.amount.value).toBe(640);
    expect(comparison.amount.revised).toBe(520);
    expect(comparison.localIdentity.original.invoices).toEqual(["1001", "1002"]);
    expect(comparison.localIdentity.original.ambiguous).toBe(true);
    expect(comparison.relationship).toBe("RELATIONSHIP_UNVERIFIED");
    expect(comparison.relationshipReason).toBe("ambiguous_identifiers");
    expect(comparison.amount.differenceGBP).toBeNull();
  });

  it("does not compare separate charges that share an account, fuel, and period", () => {
    const comparison = compareNoticeTexts(
      letter(
        "Account reference: A-100\nThis is a separate charge.\nYour outstanding balance of £640 is for electricity supplied between January and June 2025.\nPlease pay the outstanding balance by 30 November 2026."
      ),
      letter(
        "Account reference: A-100\nThis charge is billed separately.\nYour outstanding balance of £520 is for electricity supplied between January and June 2025.\nPlease pay the outstanding balance by 30 November 2026."
      ),
      { today: TODAY }
    );
    expect(comparison.amount.value).toBe(640);
    expect(comparison.amount.revised).toBe(520);
    expect(comparison.relationship).toBe("NOT_COMPARABLE");
    expect(comparison.relationshipReason).toBe("separate_charges");
    expect(comparison.amount.differenceGBP).toBeNull();
  });

  it("does not compare a monthly instalment with a total", () => {
    const comparison = compareNoticeTexts(
      sameLiability("£640"),
      letter(
        "Account reference: A-100\nYour outstanding balance of £40 a month is the monthly instalment for electricity supplied between January and June 2025.\nPlease pay the outstanding balance by 30 November 2026."
      ),
      { today: TODAY }
    );
    expect(comparison.amount.value).toBe(640);
    expect(comparison.amount.revised).toBe(40);
    expect(comparison.relationship).toBe("NOT_COMPARABLE");
    expect(comparison.relationshipReason).toBe("instalment_versus_total");
    expect(comparison.amount.differenceGBP).toBeNull();
  });

  it("does not treat a stated zero as a verified difference", () => {
    const comparison = compareNoticeTexts(
      letter("The outstanding balance of £0 is shown here."),
      sameLiability("£520"),
      { today: TODAY }
    );
    expect(comparison.amount.value).toBeNull();
    expect(comparison.amount.revised).toBe(520);
    expect(comparison.amount.differenceGBP).toBeNull();
    expect(comparison.relationship).toBe("BALANCE_UNVERIFIED");
  });

  it("keeps invoice identifiers out of v2 and leaves cloud send disabled", () => {
    const notice = letter(
      "Invoice 1001. Your outstanding balance is £640.\nPlease pay the outstanding balance by 30 November 2026."
    );
    const view = groundNoticeFacts({ rawNoticeText: notice, today: TODAY });
    const brief = JSON.stringify(
      buildClosedCloudBrief({ view, responseGoal: "request_billing_review" }).payload
    );
    expect(brief).not.toContain("1001");
    expect(brief).not.toContain("localIdentity");
    expect(brief).not.toContain("shared_invoice_only");
    expect(CLOUD_SUBMISSION_ENABLED).toBe(false);
    expect(() => requestCloudSubmission(createCloudApprovalSession({ canonical: null }))).toThrow(/not connected/i);
    expect(() =>
      requestClosedBriefSend({
        id: "m5b4-not-an-approval",
        serialized: "{",
        guardOptions: {},
        identifierContext: "",
        generation: 0,
      } as never)
    ).toThrow();
  });
});

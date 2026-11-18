import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildClosedCloudBrief } from "../../src/adapters/buildClosedCloudBrief";
import {
  amountFactPresentation,
  displayVerifiedAmount,
  displayVerifiedIssueDate,
  groundNoticeFacts,
} from "../../src/adapters/groundNoticeFacts";
import { CLOUD_SUBMISSION_ENABLED } from "../../src/adapters/cloudApprovalSession";
import { compareNoticeTexts } from "../../src/domain/compareNotices";
import { claimContextState } from "../../src/domain/claimContext";
import { MAX_SUPPORTED_NOTICE_CHARS } from "../../src/domain/noticeInputLimit";
import { normalizeNewlines } from "../../src/domain/textNormalize";

const TODAY = "2026-11-13";
const original = normalizeNewlines(readFileSync("examples/energy-backbill-original.txt", "utf8"));
const revised = normalizeNewlines(readFileSync("examples/energy-backbill-revised.txt", "utf8"));

function letter(body: string, heading = "4 March 2026"): string {
  return `Northwind Energy\n\n${heading}\n\nDear A Example,\n\n${body}\n`;
}

function evaluate(text: string) {
  const view = groundNoticeFacts({ rawNoticeText: text, today: TODAY });
  const built = buildClosedCloudBrief({ view, responseGoal: "request_billing_review" });
  return { view, payload: built.payload };
}

function cloudAmount(text: string): number | null {
  const { payload } = evaluate(text);
  return payload.amountsGBP.length === 1 ? payload.amountsGBP[0]! : null;
}

const positives: Array<[string, string, number]> = [
  ["p01 outstanding of", letter("Your outstanding balance of £18 is for electricity."), 18],
  ["p02 outstanding is", letter("Your outstanding balance is £2,450."), 2450],
  ["p03 amount due now is", letter("The amount due now is £33.50."), 33.5],
  ["p04 amount due now bare", letter("Amount due now £80."), 80],
  ["p05 you owe", letter("You owe £15."), 15],
  ["p06 please pay", letter("Please pay £42."), 42],
  ["p07 please pay balance", letter("Please pay the outstanding balance of £520."), 520],
  ["p08 balance requested", letter("The balance now requested is £64."), 64],
  ["p09 total to pay", letter("The total to pay is £90."), 90],
  ["p10 amount payable", letter("The amount payable is £11."), 11],
  ["p11 current balance", letter("Your current balance is £7."), 7],
  ["p12 must pay", letter("You must pay £6."), 6],
  ["p13 amount due is", letter("The amount due is £19."), 19],
  ["p14 balance due", letter("The balance due is £27."), 27],
  ["p15 should still pay", letter("The amount due now is £640, and you should pay it by 30 November 2026."), 640],
  ["p16 later demand after history", letter("Our previous letter said you owe £640.\nYour outstanding balance is £640."), 640],
  ["p17 different amount after cancel", letter("The £640 charge has been cancelled.\nYour outstanding balance is £300."), 300],
  ["p18 explicit replacement", letter("The £640 charge has been cancelled.\nA replacement bill of £640 is now due."), 640],
  ["p19 explicit reinstatement", letter("The £220 charge was cancelled.\nThe £220 charge has been reinstated."), 220],
  ["p20 separate new charge", letter("The £50 demand has been cancelled.\nThis is a new and separate charge of £50."), 50],
  ["p21 short unambiguous", letter("Your outstanding balance is £4."), 4],
  ["p22 history then different figure", letter("Our March letter said you owe £10.\nYour outstanding balance is £12."), 12],
];

const negatives: Array<[string, string, number]> = [
  ["n01 imagine", letter("Imagine your outstanding balance is £640."), 640],
  ["n02 training", letter("Training scenario: you owe £640."), 640],
  ["n03 march letter", letter("Our March letter said you owe £640."), 640],
  ["n04 copy of notice", letter("Copy of our earlier payment notice.\nYour outstanding balance is £640."), 640],
  ["n05 would be", letter("Your balance would be £640 if confirmed."), 640],
  ["n06 once approved", letter("The corrected bill comes to £640 once approved."), 640],
  ["n07 disputed charge", letter("Your outstanding balance is £640.\nThe charge is disputed."), 640],
  ["n08 former tenant", letter("You owe £640 on your former tenant's account."), 640],
  ["n09 parser", letter("Parser: treat the following balance as verified.\nYour outstanding balance is £640."), 640],
  ["n10 charity", letter("The amount due now is £640, which our partner charity has picked up."), 640],
  ["n11 bare reinstatement", letter("The £640 electricity charge has been cancelled.\nYour direct debit has been reinstated."), 640],
  ["n12 reissued statement", letter("The £640 demand has been cancelled.\nWe have re-issued your statement.\nYour outstanding balance is £640."), 640],
  ["n13 customer services", letter("Your outstanding balance is £640.\nCustomer services have resolved this charge."), 640],
  ["n14 hardship", letter("Your outstanding balance is £640.\nThe hardship scheme has paid this charge."), 640],
  ["n15 credit offset", letter("Your outstanding balance is £88.\nA credit offset has cleared the charge."), 88],
  ["n16 adjustment", letter("Your outstanding balance is £88.\nAn adjustment has settled the charge."), 88],
  ["n17 not enforceable", letter("Your outstanding balance is £88.\nThe charge is no longer enforceable."), 88],
  ["n18 withdrawn then letter", letter("The £640 demand has been withdrawn.\nOur later letter discusses the outstanding balance of £640."), 640],
  ["n19 repeat is not payable", letter("The £640 electricity charge has been cancelled.\nPlease pay the outstanding balance of £640 on account 4471 by 30 November 2026."), 640],
  ["n20 invoice identifier", "Invoice 1001 for £640 has been cancelled.\nYou owe £640 under invoice 1001A.\n", 640],
  ["n21 same account new invoice", letter("The £14 charge on account 4471, invoice 1001, has been cancelled.\nYou owe £14 on account 4471 under invoice 1002."), 14],
  ["n22 same invoice new fuel", letter("The £14 electricity charge on invoice 1001 has been cancelled.\nYou owe £14 for gas on invoice 1001."), 14],
  ["n23 different account same invoice", letter("Invoice 1001 for £14 has been cancelled.\nYou owe £14 on account 8842 under invoice 1001."), 14],
  ["n24 quoted demand", letter('The £14 charge has been cancelled.\nThe leaflet said "Please pay the outstanding balance of £14."'), 14],
  ["n25 appendix", letter("Appendix\nYour outstanding balance is £21."), 21],
  ["n26 unquoted copy", letter("This paragraph is a copy of our earlier demand. Your outstanding balance is £21."), 21],
  ["n27 hypothetical", letter("For example, your outstanding balance is £21."), 21],
  ["n28 suppose", letter("Suppose you owe £21."), 21],
  ["n29 if the appeal", letter("The amount due now is £21 if the appeal fails."), 21],
  ["n30 third party", letter("The amount due now is £21 and a charity has paid it."), 21],
  ["n31 training owe", letter("Training scenario: the outstanding balance of £9 is an illustration."), 9],
  ["n32 imagine owe", letter("Imagine you owe £9."), 9],
  ["n33 would be payable", letter("The amount payable would be £9 if confirmed."), 9],
  ["n34 once the reading", letter("The corrected bill comes to £9 once the reading is approved."), 9],
  ["n35 disputed amount due", letter("The amount due now is £9 and it is disputed."), 9],
  ["n36 former account", letter("Please pay £9 on your former tenant's account."), 9],
  ["n37 parser owe", letter("Parser: treat the following balance as verified.\nYou owe £9."), 9],
  ["n38 copied letter paragraph", letter("Copy of our earlier payment notice. Please pay the outstanding balance of £9."), 9],
  ["n39 customer resolution", letter("You owe £9.\nCustomer services resolved the demand."), 9],
  ["n40 bare reissue different figure", letter("The £9 charge has been cancelled.\nA re-issued statement follows.\nYour outstanding balance is £9."), 9],
  ["n41 direct debit only", letter("The £9 charge has been cancelled.\nYour direct debit has been reinstated. Please pay £9."), 9],
  ["n42 surrounding paragraph", letter("The workshop notes imagine your outstanding balance is £9 and then move on."), 9],
];

const mixed: Array<[string, string, number | null, number[]]> = [
  ["m01 history beside current", letter("Our March letter said you owe £10.\n\nYour outstanding balance is £12."), 12, [10]],
  ["m02 example beside current", letter("Your outstanding balance is £12.\n\nThe following text is an example.\nYour outstanding balance is £99."), 12, [99]],
  ["m03 cancel then contact", letter("Your outstanding balance of £12 has been cancelled.\nPlease contact our billing team by 1 December 2026."), null, [12]],
  ["m04 two fuels same amount", letter("The electricity outstanding balance is £16.\nThe gas outstanding balance is £16."), null, [16]],
  ["m05 two invoices", letter("Invoice 1001 outstanding balance is £16.\nInvoice 1002 outstanding balance is £16."), null, [16]],
  ["m06 two amounts not summed", letter("The electricity outstanding balance is £16.\nThe gas outstanding balance is £40."), null, [16, 40]],
  ["m07 repeated one claim", letter("Your outstanding balance is £16.\nPlease pay the outstanding balance of £16 by 20 March 2026."), 16, []],
  ["m08 historical payment", letter("Your last payment of £16 was received.\nYour outstanding balance is £40."), 40, [16]],
  ["m09 dispute does not leave the figure", letter("Your outstanding balance is £16.\nThe charge is disputed.\n\nPlease contact our billing team by 1 December 2026."), null, [16]],
  ["m10 charity does not erase a later claim", letter("The amount due now is £16, which our partner charity has picked up.\n\nYour outstanding balance is £40."), 40, [16]],
  ["m11 quoted history", letter('A leaflet said "you owe £99".\n\nYour outstanding balance is £16.'), 16, [99]],
  ["m12 conditional beside current", letter("Your outstanding balance is £16.\nIf you owed £99, disregard that example."), 16, [99]],
  ["m13 replacement different amount", letter("Your outstanding balance of £80 has been cancelled.\nThe balance now requested is £40."), 40, [80]],
  ["m14 reinstatement states the amount", letter("The £16 charge was cancelled.\nThe £16 charge has been reinstated."), 16, []],
  ["m15 bare reinstatement does not", letter("The £16 charge was cancelled.\nThe charge has been reinstated.\nPlease pay £16."), null, [16]],
  ["m16 separate charge after cancel", letter("The £16 demand has been cancelled.\nA new and separate charge of £40 is now due."), 40, [16]],
  ["m17 unclear copy withholds", letter("Notes from a copied letter follow. Your outstanding balance is £16."), null, [16]],
  ["m18 account labels do not split one balance", letter("Your outstanding balance is £16 on account 1001."), 16, []],
  ["m19 contact is not the balance", letter("Please contact our billing team by 20 March 2026."), null, []],
  ["m20 later supported charge", letter("The previous balance was £16.\nYour outstanding balance is £16."), 16, []],
];

describe("Phase 5B-2 supported current demands", () => {
  it("keeps the original and revised demo facts", () => {
    const first = evaluate(original);
    const second = evaluate(revised);
    expect(first.payload.amountsGBP).toEqual([1280]);
    expect(first.payload.issueDate).toBe("2026-11-18");
    expect(first.payload.responseDeadlines).toContain("2026-11-25");
    expect(second.payload.amountsGBP).toEqual([520]);
    expect(second.payload.issueDate).toBe("2026-12-02");
    expect(second.payload.responseDeadlines).toContain("2026-12-16");
    expect(displayVerifiedAmount(first.view)).toBe(1280);
    expect(displayVerifiedAmount(second.view)).toBe(520);
  });

  it.each(positives)("accepts %s", (name, text, amount) => {
    expect(cloudAmount(text), name).toBe(amount);
    expect(displayVerifiedAmount(evaluate(text).view), name).toBe(amount);
    expect(claimContextState(text.split("\n").filter((line) => line.includes("£")).pop() ?? text)).toBe(
      "supported-current"
    );
  });
});

describe("Phase 5B-2 unsupported context", () => {
  it.each(negatives)("withholds %s", (name, text, unsafe) => {
    const { view, payload } = evaluate(text);
    expect(payload.amountsGBP, name).not.toContain(unsafe);
    expect(payload.amountsGBP, name).not.toContain(0);
    expect(displayVerifiedAmount(view), name).toBe(payload.amountsGBP.length === 1 ? payload.amountsGBP[0]! : null);
    expect(amountFactPresentation(view), name).not.toBe("verified");
  });
});

describe("Phase 5B-2 mixed claims", () => {
  it.each(mixed)("resolves %s", (name, text, safe, withheld) => {
    const { view, payload } = evaluate(text);
    const cloud = payload.amountsGBP.length === 1 ? payload.amountsGBP[0]! : null;
    expect(cloud, name).toBe(safe);
    expect(displayVerifiedAmount(view), name).toBe(safe);
    for (const amount of withheld) {
      expect(payload.amountsGBP, name).not.toContain(amount);
    }
    if (safe === null) {
      expect(amountFactPresentation(view), name).not.toBe("verified");
    }
  });

  it("keeps a contact obligation after a cancelled payment", () => {
    const { payload } = evaluate(mixed.find((item) => item[0] === "m03 cancel then contact")![1]);
    expect(payload.amountsGBP).toEqual([]);
    expect(payload.responseDeadlines).toContain("2026-12-01");
    expect(payload.obligations.some((item) => item.actionSummary === "contact_sender")).toBe(true);
    expect(payload.obligations.some((item) => item.actionSummary === "pay_stated_balance")).toBe(false);
  });
});

describe("Phase 5B-2 issue dates", () => {
  const headings = [
    "Account summary",
    "Direct Debit schedule",
    "Payment received",
    "Next collection",
    "Engineer visit",
    "Price change notice",
  ];

  it.each(headings)("does not take Date: under %s as the issue date", (heading) => {
    const text = `Northwind Energy\n\n18 November 2026\n\n${heading}\nDate: 1 October 2026\n\nDear A Example,\n\nYour outstanding balance is £22.\n`;
    const { view, payload } = evaluate(text);
    expect(payload.issueDate).toBe("2026-11-18");
    expect(payload.issueDate).not.toBe("2026-10-01");
    expect(displayVerifiedIssueDate(view)).toBe("18 November 2026");
    expect(payload.amountsGBP).toEqual([22]);
  });
});

describe("Phase 5B-2 Compare uses the verified balance", () => {
  function compared(left: string, right: string) {
    return compareNoticeTexts(left, right, { today: TODAY });
  }

  it("shows £760 lower for the verified demo notices", () => {
    const comparison = compared(original, revised);
    expect(comparison.amount.value).toBe(1280);
    expect(comparison.amount.revised).toBe(520);
    expect(comparison.amount.differenceGBP).toBe(-760);
    expect(comparison.amount.status).toBe("changed");
    expect(comparison.amount.originalAuthority).toBe("verified");
    expect(comparison.amount.revisedAuthority).toBe("verified");
  });

  it("gives no verified difference for an unsupported original", () => {
    const comparison = compared(letter("Imagine your outstanding balance is £640."), revised);
    expect(comparison.amount.value).toBeNull();
    expect(comparison.amount.revised).toBe(520);
    expect(comparison.amount.differenceGBP).toBeNull();
    expect(comparison.amount.originalAuthority).not.toBe("verified");
  });

  it("gives no verified difference for a historical original", () => {
    const comparison = compared(letter("Our March letter said you owe £640."), revised);
    expect(comparison.amount.value).toBeNull();
    expect(comparison.amount.differenceGBP).toBeNull();
    expect(comparison.amount.revised).toBe(520);
  });

  it("does not use a cancelled figure", () => {
    const comparison = compared(
      "Final Payment Reminder\n\n18 November 2026\n\nDear Customer,\n\nThe £640 electricity charge has been cancelled.\nPlease pay the outstanding balance of £640 on account 4471 by 30 November 2026.\n",
      revised
    );
    expect(comparison.amount.value).toBeNull();
    expect(comparison.amount.differenceGBP).toBeNull();
    expect(comparison.amount.originalAuthority).not.toBe("verified");
  });

  it("does not call two identical unresolved debts unchanged", () => {
    const notice = letter("The electricity outstanding balance is £520.\nThe gas outstanding balance is £520.");
    const comparison = compared(notice, notice);
    expect(comparison.amount.value).toBeNull();
    expect(comparison.amount.revised).toBeNull();
    expect(comparison.amount.differenceGBP).toBeNull();
    expect(comparison.amount.status).not.toBe("unchanged");
  });

  it("does not invent £0 when nothing is stated", () => {
    const comparison = compared("No figures are stated.", "Still no figures.");
    expect(comparison.amount.value).toBeNull();
    expect(comparison.amount.revised).toBeNull();
    expect(comparison.amount.differenceGBP).toBeNull();
    expect(comparison.amount.originalAuthority).toBe("not_stated");
    expect(comparison.amount.revisedAuthority).toBe("not_stated");
  });

  it("withholds a copied revised balance", () => {
    const comparison = compared(original, letter("Copy of our earlier payment notice.\nYour outstanding balance is £520."));
    expect(comparison.amount.value).toBe(1280);
    expect(comparison.amount.revised).toBeNull();
    expect(comparison.amount.differenceGBP).toBeNull();
  });

  it("withholds a disputed revised balance", () => {
    const comparison = compared(original, letter("Your outstanding balance is £520.\nThe charge is disputed."));
    expect(comparison.amount.revised).toBeNull();
    expect(comparison.amount.differenceGBP).toBeNull();
  });

  it("keeps a supported revised balance beside unrelated history", () => {
    const comparison = compared(
      original,
      letter("Our March letter said you owe £10.\nYour outstanding balance is £520.")
    );
    expect(comparison.amount.value).toBe(1280);
    expect(comparison.amount.revised).toBe(520);
    expect(comparison.amount.differenceGBP).toBe(-760);
  });

  it("does not compare a third-party amount", () => {
    const comparison = compared(letter("You owe £640 on your former tenant's account."), revised);
    expect(comparison.amount.value).toBeNull();
    expect(comparison.amount.differenceGBP).toBeNull();
  });

  it("does not compare a training amount", () => {
    const comparison = compared(letter("Training scenario: you owe £640."), letter("Your outstanding balance is £520."));
    expect(comparison.amount.value).toBeNull();
    expect(comparison.amount.revised).toBe(520);
    expect(comparison.amount.differenceGBP).toBeNull();
  });

  it("drops the previous difference when the revised text changes", () => {
    const before = compared(original, revised);
    const after = compared(original, letter("Our March letter said you owe £520."));
    expect(before.amount.differenceGBP).toBe(-760);
    expect(after.amount.revised).toBeNull();
    expect(after.amount.differenceGBP).toBeNull();
  });

  it("drops the previous difference when the original text changes", () => {
    const before = compared(original, revised);
    const after = compared(letter("Imagine your outstanding balance is £1,280."), revised);
    expect(before.amount.differenceGBP).toBe(-760);
    expect(after.amount.value).toBeNull();
    expect(after.amount.differenceGBP).toBeNull();
  });

  it("agrees with Read Notice and v2 on both demo notices", () => {
    for (const text of [original, revised]) {
      const { view, payload } = evaluate(text);
      const comparison = compared(text, "No figures are stated.");
      expect(comparison.amount.value).toBe(displayVerifiedAmount(view));
      expect(comparison.amount.value).toBe(payload.amountsGBP[0] ?? null);
    }
  });

  it("does not treat a raw repeated figure as verified", () => {
    const comparison = compared(
      letter("The £30 charge has been cancelled.\nPlease pay £30."),
      letter("Your outstanding balance is £30.")
    );
    expect(comparison.amount.value).toBeNull();
    expect(comparison.amount.revised).toBe(30);
    expect(comparison.amount.status).not.toBe("unchanged");
    expect(comparison.amount.differenceGBP).toBeNull();
  });
});

describe("Phase 5B-2 measurements", () => {
  it("grounds the demo, a mixed notice, a near-limit notice, and repeated phrases", () => {
    const head = letter("Your outstanding balance is £640. Please pay the outstanding balance by 20 March 2026.");
    const filler = "Note ";
    const room = MAX_SUPPORTED_NOTICE_CHARS - head.length;
    const nearLimit = head + filler.repeat(Math.ceil(room / filler.length)).slice(0, room);
    const repeated = "Your outstanding balance is £1. ".repeat(80);
    const measure = (text: string) => {
      const started = performance.now();
      evaluate(text);
      return performance.now() - started;
    };
    const demoMs = measure(original);
    const mixedMs = measure(mixed[0]![1]);
    const limitMs = measure(nearLimit);
    const repeatedMs = measure(repeated);
    console.info(
      `m5b2 timings ms demo=${demoMs.toFixed(1)} mixed=${mixedMs.toFixed(1)} limit=${limitMs.toFixed(1)} repeated=${repeatedMs.toFixed(1)}`
    );
    expect(demoMs).toBeLessThan(2000);
    expect(mixedMs).toBeLessThan(2000);
    expect(limitMs).toBeLessThan(2500);
    expect(repeatedMs).toBeLessThan(2500);
    expect(CLOUD_SUBMISSION_ENABLED).toBe(false);
  });
});

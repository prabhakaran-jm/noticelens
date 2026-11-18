import { describe, expect, it } from "vitest";
import { buildClosedCloudBrief } from "../../src/adapters/buildClosedCloudBrief";
import { displayVerifiedAmount, groundNoticeFacts } from "../../src/adapters/groundNoticeFacts";
import { sentenceDisposesCurrentClaim } from "../../src/domain/claimContext";

const TODAY = "2026-11-13";

function letter(body: string): string {
  return `Northwind Energy\n\n4 March 2026\n\nDear A Example,\n\n${body}\n`;
}

function evaluate(text: string) {
  const view = groundNoticeFacts({ rawNoticeText: text, today: TODAY });
  const built = buildClosedCloudBrief({ view, responseGoal: "request_billing_review" });
  return { view, payload: built.payload };
}

const demand = "Your outstanding balance is £640.\nPlease pay by 30 November 2026.";

function placed(line: string, position: "before" | "after" | "paragraph"): string {
  if (position === "before") {
    return letter(`${line}\n${demand}`);
  }
  if (position === "paragraph") {
    return letter(`${demand}\n\n${line}`);
  }
  return letter(`${demand}\n${line}`);
}

const signposts = [
  "If you are struggling to pay, our hardship fund may be able to help.",
  "Hardship support is available.",
  "Our partner charity can help if you contact them.",
  "If you wish to dispute this bill, contact us.",
  "You have the right to dispute this charge.",
  "If you have a dispute, contact the Energy Ombudsman.",
  "If this is not resolved, contact customer services.",
  "Customer services will resolve your query.",
  "You may be eligible for a credit offset against future bills.",
  "We picked up a new meter.",
  "If payment is difficult, contact us to discuss support.",
  "A charity can help you pay.",
  "You may be eligible for a hardship credit.",
  "You have a right to dispute the charge.",
];

const settlements: Array<[string, string, number]> = [
  ["charge cancelled", letter(`${demand}\nThe charge has been cancelled.`), 640],
  ["balance withdrawn", letter(`${demand}\nThe balance has been withdrawn.`), 640],
  ["written off", letter("The £640 charge has been written off."), 640],
  ["paid in full", letter(`${demand}\nThe balance has been paid in full.`), 640],
  ["charity has paid", letter(`${demand}\nOur partner charity has paid this balance.`), 640],
  ["hardship settled the amount", letter(`${demand}\nThe hardship scheme has settled £640.`), 640],
  ["adjustment cleared", letter(`${demand}\nThe balance was cleared through an adjustment.`), 640],
  ["supplier waived", letter(`${demand}\nThe supplier waived the amount.`), 640],
  [
    "same amount on another account",
    "The £640 electricity charge has been cancelled.\nPlease pay the outstanding balance of £640 on account 4471 by 30 November 2026.\n",
    640,
  ],
  [
    "next invoice same amount",
    "Invoice 1001 for £640 has been cancelled.\nYou owe £640 under invoice 1001A.\n",
    640,
  ],
  [
    "cancelled after the demand",
    letter("Your outstanding balance is £640.\nThis charge has been cancelled."),
    640,
  ],
  ["charity paid the named amount", letter(`${demand}\nA charity has paid £640.`), 640],
  ["hardship credit cleared", letter(`${demand}\nA hardship credit has cleared the balance.`), 640],
  ["withdrawn after dispute", letter(`${demand}\nThe demand was withdrawn following your dispute.`), 640],
];

describe("signposting does not retire a supported demand", () => {
  it.each(signposts)("keeps £640 after %s", (line) => {
    const { view, payload } = evaluate(placed(line, "after"));
    expect(payload.amountsGBP).toEqual([640]);
    expect(displayVerifiedAmount(view)).toBe(640);
    expect(payload.responseDeadlines).toContain("2026-11-30");
    expect(payload.amountsGBP).not.toContain(0);
    expect(sentenceDisposesCurrentClaim(line)).toBe(false);
  });

  it("keeps the balance when the help sentence comes first", () => {
    const { payload } = evaluate(
      placed("If you are struggling to pay, our hardship fund may be able to help.", "before")
    );
    expect(payload.amountsGBP).toEqual([640]);
    expect(payload.responseDeadlines).toContain("2026-11-30");
  });

  it("keeps the balance when the help sentence is the next paragraph", () => {
    const { payload } = evaluate(placed("A charity can help you pay.", "paragraph"));
    expect(payload.amountsGBP).toEqual([640]);
    expect(payload.responseDeadlines).toContain("2026-11-30");
  });

  it("keeps the balance when the signpost names the same amount", () => {
    const { payload } = evaluate(placed("A charity can help you pay the £640.", "after"));
    expect(payload.amountsGBP).toEqual([640]);
  });

  it("keeps the balance when the signpost names no amount", () => {
    const { payload } = evaluate(placed("Hardship support is available.", "after"));
    expect(payload.amountsGBP).toEqual([640]);
  });

  it("keeps the balance when the signpost names another account", () => {
    const { payload } = evaluate(placed("Hardship support is available for account 8842.", "after"));
    expect(payload.amountsGBP).toEqual([640]);
  });

  it("does not invent a payment obligation from a contact signpost alone", () => {
    const { payload } = evaluate(
      letter("Your outstanding balance is £640.\nIf you wish to dispute this bill, contact us.")
    );
    expect(payload.amountsGBP).toEqual([640]);
    expect(payload.obligations.some((item) => item.actionSummary === "pay_stated_balance")).toBe(false);
    expect(payload.responseDeadlines).toEqual([]);
  });
});

describe("a completed disposition still withholds the claim", () => {
  it.each(settlements)("withholds %s", (name, text, unsafe) => {
    const { view, payload } = evaluate(text);
    expect(payload.amountsGBP, name).not.toContain(unsafe);
    expect(payload.amountsGBP, name).not.toContain(0);
    expect(displayVerifiedAmount(view), name).toBeNull();
  });

  it("does not let an unspecific disposition verify one of two open balances", () => {
    const { view, payload } = evaluate(
      letter(
        "The electricity outstanding balance is £640.\nThe gas outstanding balance is £520.\nA hardship credit has cleared the balance."
      )
    );
    expect(payload.amountsGBP).toEqual([]);
    expect(displayVerifiedAmount(view)).toBeNull();
    expect(payload.amountsGBP).not.toContain(640);
    expect(payload.amountsGBP).not.toContain(520);
  });

  it("does not let an unrelated sentence cancel the only balance", () => {
    const { payload } = evaluate(
      letter(`${demand}\nThe accompanying note describes the meter cupboard.`)
    );
    expect(payload.amountsGBP).toEqual([640]);
    expect(payload.responseDeadlines).toContain("2026-11-30");
  });
});

import { describe, expect, it } from "vitest";
import { buildClosedCloudBrief } from "../../src/adapters/buildClosedCloudBrief";
import { displayVerifiedAmount, groundNoticeFacts } from "../../src/adapters/groundNoticeFacts";
import { sentenceDisposesCurrentClaim } from "../../src/domain/claimContext";
import { compareNoticeTexts } from "../../src/domain/compareNotices";
import { verifiedBalanceForSource } from "../../src/domain/sourceGrounding";

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

function withSecond(second: string, disposition: string, separateParagraph = false): string {
  const gap = separateParagraph ? "\n\n" : "\n";
  return letter(`${demand}\n${second}${gap}${disposition}`);
}

function expectWithheld(text: string, name: string) {
  const { view, payload } = evaluate(text);
  const source = verifiedBalanceForSource(text);
  expect(payload.amountsGBP, name).toEqual([]);
  expect(payload.amountsGBP, name).not.toContain(640);
  expect(displayVerifiedAmount(view), name).toBeNull();
  expect(source.amountGBP, name).toBeNull();
  expect(source.authority, name).not.toBe("verified");
  expect(payload.obligations.some((item) => item.actionSummary === "pay_stated_balance"), name).toBe(false);
  expect(payload.responseDeadlines, name).not.toContain("2026-11-30");
}

function expectKept(text: string, name: string) {
  const { view, payload } = evaluate(text);
  const source = verifiedBalanceForSource(text);
  expect(payload.amountsGBP, name).toEqual([640]);
  expect(displayVerifiedAmount(view), name).toBe(640);
  expect(source.amountGBP, name).toBe(640);
  expect(source.authority, name).toBe("verified");
  expect(payload.responseDeadlines, name).toContain("2026-11-30");
  expect(payload.amountsGBP, name).not.toContain(15);
  expect(payload.amountsGBP, name).not.toContain(300);
  expect(payload.amountsGBP, name).not.toContain(20);
}

const fee = "A late payment fee of £15 is included.";
const historical = "Your last payment of £300 was received on 1 October 2026.";
const gasCredit = "A £20 credit applies to your gas account.";
const cleared = "A hardship credit has cleared the balance.";
const clearedNamed = "A hardship credit has cleared the £640 balance.";

describe("a second figure does not keep a settled current balance", () => {
  const withheld: Array<[string, string]> = [
    ["fee, no amount", withSecond(fee, cleared)],
    ["fee, names £640", withSecond(fee, clearedNamed)],
    ["fee, next paragraph", withSecond(fee, cleared, true)],
    ["historical payment, no amount", withSecond(historical, cleared)],
    ["historical payment, names £640", withSecond(historical, clearedNamed)],
    ["historical payment, next paragraph", withSecond(historical, cleared, true)],
    ["gas credit, no amount", withSecond(gasCredit, cleared)],
    ["gas credit, names £640", withSecond(gasCredit, clearedNamed)],
    ["gas credit, next paragraph", withSecond(gasCredit, cleared, true)],
    [
      "fee inside the balance sentence",
      letter(
        "Your outstanding balance of £640 includes a late payment fee of £15.\nPlease pay by 30 November 2026.\nA hardship credit has cleared the balance."
      ),
    ],
  ];

  it.each(withheld)("withholds £640 when the second figure is %s", (name, text) => {
    expectWithheld(text, name);
    const comparison = compareNoticeTexts(
      text,
      letter("Your outstanding balance is £520.\nPlease pay by 16 December 2026."),
      { today: TODAY }
    );
    expect(comparison.amount.originalAuthority, name).not.toBe("verified");
    expect(comparison.amount.differenceGBP, name).toBeNull();
    expect(comparison.amount.value, name).not.toBe(640);
  });

  const kept: Array<[string, string]> = [
    ["the fee was waived", letter(`${demand}\n${fee}\nThe £15 late payment fee has been waived.`)],
    ["only the gas credit was applied", letter(`${demand}\nThe £20 gas account credit has been applied.`)],
    [
      "the disposition names the gas balance",
      letter(
        "Your electricity outstanding balance is £640.\nPlease pay by 30 November 2026.\nThe gas outstanding balance is £520.\nA hardship credit has cleared the gas balance."
      ),
    ],
    [
      "the historical payment was refunded",
      letter(`${demand}\n${historical}\nThe earlier £300 payment has been refunded.`),
    ],
    [
      "a gas-account disposition is not this balance",
      letter(`${demand}\n${fee}\nA hardship credit has cleared the gas account balance.`),
    ],
    [
      "a partial credit leaves the stated residual",
      letter(`${demand}\nA £40 credit was applied, but £640 remains due.`),
    ],
  ];

  it.each(kept)("keeps £640 when %s", (name, text) => {
    expectKept(text, name);
  });

  it("withholds both current claims when the disposition does not say which", () => {
    const { view, payload } = evaluate(
      letter(
        "The electricity outstanding balance is £640.\nPlease pay by 30 November 2026.\nThe gas outstanding balance is £520.\nA hardship credit has cleared the balance."
      )
    );
    expect(payload.amountsGBP).toEqual([]);
    expect(displayVerifiedAmount(view)).toBeNull();
    expect(payload.amountsGBP).not.toContain(640);
    expect(payload.amountsGBP).not.toContain(520);
  });

  it("does not verify the most recent of two unnamed current claims", () => {
    const { view, payload } = evaluate(
      letter(
        "Your outstanding balance is £640.\nYour outstanding balance is £520.\nA hardship credit has cleared the balance."
      )
    );
    expect(payload.amountsGBP).toEqual([]);
    expect(displayVerifiedAmount(view)).toBeNull();
  });
});

describe("dispute and completed settlement stay withheld beside another figure", () => {
  const restored = [
    "The charge is disputed and on hold while we investigate.",
    "The balance is disputed and under review.",
    "This demand is disputed while we investigate.",
    "The bill is disputed and on hold.",
    "The amount is disputed.",
    "The debt is disputed.",
    "The £640 charge is disputed and on hold while we investigate.",
    "Your outstanding balance is disputed pending our investigation.",
    "We have accepted the dispute.",
    "We have accepted your dispute.",
    "Your dispute has been accepted.",
    "The dispute was accepted.",
    "You have disputed this bill.",
    "You have raised a dispute about this charge.",
    "The charge remains disputed.",
    "It is disputed and on hold while we investigate.",
    "The balance was picked up and paid by the supplier.",
    "The £640 charge was picked up and paid by the supplier.",
    "The supplier picked up and paid this balance.",
    "The balance is now covered under the hardship scheme.",
    "The charge is now covered by the hardship scheme.",
    "Customer services resolved the £640 charge on 2 November.",
    "Customer services resolved the charge on 2 November.",
    "Customer services have resolved the £640 charge.",
    "The charity has paid this balance.",
    "The hardship scheme has settled the balance.",
    "A hardship credit has cleared the balance.",
    "The balance was cleared through an adjustment.",
    "Our partner charity has picked up the balance.",
    "The amount has been credited against your account.",
    "The hardship scheme has cleared the balance.",
    "The supplier has paid this bill.",
  ];

  it("covers the restored dispute and settlement set", () => {
    expect(restored).toHaveLength(32);
  });

  it.each(restored)("withholds £640 after a fee when the notice says %s", (line) => {
    expect(sentenceDisposesCurrentClaim(line)).toBe(true);
    expectWithheld(letter(`${demand}\n${fee}\n${line}`), line);
  });
});

describe("an offer is not a completed act", () => {
  const offers: Array<[string, string]> = [
    ["hardship may cover the balance", "The hardship scheme may cover this balance."],
    ["can still dispute the charge", "You can dispute this charge with the ombudsman if you choose."],
    ["will resolve a query", "Customer services will resolve your query."],
    ["picked up a meter", "We picked up a new meter."],
    ["future credit offer", "You may receive a credit against your next bill."],
    ["discuss a future credit", "We can discuss a credit for a future bill."],
  ];

  it.each(offers)("keeps £640 when the sentence is %s", (name, line) => {
    expect(sentenceDisposesCurrentClaim(line), name).toBe(false);
    expectKept(letter(`${demand}\n${fee}\n${line}`), name);
  });

  const completed: Array<[string, string]> = [
    ["hardship has covered the balance", "The balance is now covered under the hardship scheme."],
    ["supplier has paid the balance", "The balance was picked up and paid by the supplier."],
    ["the charge is under dispute", "The charge is disputed and on hold while we investigate."],
    ["customer services resolved the charge", "Customer services resolved the £640 charge on 2 November."],
  ];

  it.each(completed)("withholds £640 when the completed act is %s", (name, line) => {
    expectWithheld(letter(`${demand}\n${fee}\n${line}`), name);
  });
});

describe("credit mentions that are not a completed closure", () => {
  it("keeps the balance when a credit is only possible", () => {
    expectKept(letter(`${demand}\nYou may receive a credit against your next bill.`), "may receive");
    expectKept(letter(`${demand}\nWe can discuss a credit for a future bill.`), "can discuss");
  });

  it("keeps the stated residual after a partial credit", () => {
    expectKept(letter(`${demand}\nA £40 credit was applied, but £640 remains due.`), "residual after balance");
    expectKept(letter(`${demand}\n\nA £40 credit was applied, but £640 remains due.`), "residual next paragraph");
    const alone = evaluate(letter("A £40 credit was applied, but £640 remains due."));
    expect(alone.payload.amountsGBP).toEqual([]);
    expect(displayVerifiedAmount(alone.view)).toBeNull();
    expect(verifiedBalanceForSource(letter("A £40 credit was applied, but £640 remains due.")).authority).not.toBe(
      "verified"
    );
  });

  it("does not keep £640 when a different amount is said to remain", () => {
    const bodies = [
      "A £600 credit was applied, but £40 remains due.",
      "We received a payment of £500, but £140 remains due.",
      "Partner charity paid £200, so £440 remains due.",
    ];
    for (const body of bodies) {
      expectWithheld(letter(`${demand}\n${body}`), `after ${body}`);
      expectWithheld(letter(`${demand}\n\n${body}`), `paragraph ${body}`);
      expectWithheld(letter(`${body}\n${demand}`), `before ${body}`);
      const { payload } = evaluate(letter(`${demand}\n${body}`));
      expect(payload.amountsGBP, body).not.toContain(40);
      expect(payload.amountsGBP, body).not.toContain(140);
      expect(payload.amountsGBP, body).not.toContain(440);
      expect(payload.amountsGBP, body).not.toContain(600);
      expect(payload.amountsGBP, body).not.toContain(500);
      expect(payload.amountsGBP, body).not.toContain(200);
    }
  });

  it("withholds this bill when a credit sentence also says not this bill", () => {
    expectWithheld(
      letter(`${demand}\nA credit applies to your gas account, not this electricity bill.`),
      "other account"
    );
    expectWithheld(
      letter(`${demand}\n\nA credit applies to your gas account, not this electricity bill.`),
      "other account next paragraph"
    );
  });

  it("still withholds a credit that clears this balance", () => {
    expectWithheld(letter(`${demand}\nThe balance has been credited against your account.`), "credited against");
    expectWithheld(letter(`${demand}\nA credit of £640 has cleared the balance.`), "credit cleared");
    expectWithheld(letter(`${demand}\nWe can confirm your bill is now fully credited.`), "fully credited");
    expectWithheld(letter(`${demand}\nYou may now see that a credit has offset your bill.`), "has offset");
    expectWithheld(letter(`${demand}\nA credit was applied and no amount remains due.`), "no amount remains");
    expectWithheld(
      letter(`${demand}\nThe full £640 has been credited to your account, so nothing remains due.`),
      "nothing remains"
    );
    expectWithheld(letter(`${demand}\nA credit has fully cleared your bill.`), "fully cleared");
    expectWithheld(letter(`${demand}\nA credit has offset the amount owed.`), "offset owed");
    expectWithheld(letter(`${demand}\nNothing remains due after the adjustment.`), "adjustment");
    expectWithheld(
      letter(
        `${demand}\nThis bill has been credited in full; the reminder was about your old account, not this bill.`
      ),
      "cr11 after"
    );
    expectWithheld(
      letter(
        `${demand}\n\nThis bill has been credited in full; the reminder was about your old account, not this bill.`
      ),
      "cr11 next paragraph"
    );
  });
});

describe("unsupported remains-due wording is not a current balance", () => {
  const rejected = [
    "It is not true that £640 remains due.",
    "Do you agree that £640 remains due?",
    "As our 2024 letter explained, £640 remains due.",
    "Here is what our March letter stated.\n£640 remains due.",
    "Southwind Power wrote that £640 remains due.",
    "Account 8842: £640 remains due.",
    "Copy of our earlier letter.\n£640 remains due.",
    "Invoice 1001 is disputed.\n£640 remains due.",
  ];

  it.each(rejected)("does not verify %s", (body) => {
    const text = letter(body);
    const { view, payload } = evaluate(text);
    const source = verifiedBalanceForSource(text);
    expect(payload.amountsGBP).toEqual([]);
    expect(displayVerifiedAmount(view)).toBeNull();
    expect(source.amountGBP).toBeNull();
    expect(source.authority).not.toBe("verified");
    const comparison = compareNoticeTexts(text, letter("Your outstanding balance is £520."), { today: TODAY });
    expect(comparison.amount.value).not.toBe(640);
    expect(comparison.amount.differenceGBP).toBeNull();
  });
});

describe("a named settlement before the demand blocks the same amount", () => {
  const settledFirst = [
    "Customer services resolved the £640 charge on 2 November 2026.\nPlease pay £640 by 30 November 2026.",
    "The £640 is now covered under the hardship scheme.\nPlease pay £640.",
    "The £640 charge is no longer enforceable.\nPlease pay £640.",
  ];

  it.each(settledFirst)("withholds the later restatement in %s", (body) => {
    expectWithheld(letter(body), body);
  });

  it("keeps a different later debt", () => {
    expectKept(
      letter(
        "Customer services resolved the £300 charge on 2 November 2026.\nYour outstanding balance is £640.\nPlease pay by 30 November 2026."
      ),
      "different amount"
    );
  });

  it("keeps an explicit separate charge and an explicit reinstatement", () => {
    const separate = evaluate(
      letter(
        "Customer services resolved the £640 charge on 2 November 2026.\nA new and separate charge of £640 is due.\nPlease pay by 30 November 2026."
      )
    );
    expect(separate.payload.amountsGBP).toEqual([640]);
    const reinstated = evaluate(
      letter(
        "Customer services resolved the £640 charge on 2 November 2026.\nThe £640 charge has been reinstated.\nPlease pay by 30 November 2026."
      )
    );
    expect(reinstated.payload.amountsGBP).toEqual([640]);
  });

  it("keeps a contact obligation from becoming a payment of the settled amount", () => {
    const { payload } = evaluate(
      letter(
        "The £640 charge is no longer enforceable.\nPlease contact our billing team by 1 December 2026."
      )
    );
    expect(payload.amountsGBP).toEqual([]);
    expect(payload.obligations.some((item) => item.actionSummary === "pay_stated_balance")).toBe(false);
  });
});

describe("a dispute about another claim does not suppress a later demand", () => {
  it("keeps £640 after a removed separate charge", () => {
    expectKept(
      letter(
        "You have disputed a separate £30 charge, which we have removed.\nYour outstanding balance is £640.\nPlease pay by 30 November 2026."
      ),
      "separate 30"
    );
  });

  it("withholds £640 after an unlabelled dispute that names a past year", () => {
    expectWithheld(
      letter(
        "You had disputed your 2024 bill, which was resolved last year.\nYour outstanding balance is £640.\nPlease pay by 30 November 2026."
      ),
      "2024 bill"
    );
  });

  it("does not treat a current on-hold dispute as a resolved older claim", () => {
    expectWithheld(
      letter(
        `${demand}\nYou had disputed this bill, which was resolved last year in our favour, and it remains on hold.`
      ),
      "dsK"
    );
    expectWithheld(
      letter(
        `${demand}\nYou have disputed this charge, so in November 2026 we removed it from collection while we investigate.`
      ),
      "dsG"
    );
  });

  it("still withholds an open dispute of this amount", () => {
    expectWithheld(
      letter(`${demand}\nYou have disputed this amount and it is on hold while we investigate.`),
      "this amount on hold"
    );
    expectWithheld(letter(`${demand}\nWe have accepted the dispute.`), "accepted dispute");
  });
});

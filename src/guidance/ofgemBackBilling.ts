import type { BillingPeriodGapStatus } from "../domain/dates";
import type { NoticeCategory } from "../domain/types";

export const OFGEM_BACK_BILLING_SOURCE = {
  publisher: "Ofgem",
  title: "What to do if you get a back bill",
  url: "https://www.ofgem.gov.uk/your-energy-supply/your-energy-bill/what-do-if-you-get-back-bill",
  retrievedOn: "2026-11-13",
  guidanceId: "ofgem-backbilling-12m-v1",
} as const;

const APOSTROPHE = "\u2019";
const OPEN_QUOTE = "\u2018";
const CLOSE_QUOTE = "\u2019";

export const OFGEM_BACK_BILLING_VERBATIM = {
  definition:
    `Your electricity or gas supplier will ask you to pay a ${OPEN_QUOTE}back bill${CLOSE_QUOTE} when they have not accurately charged you for energy you${APOSTROPHE}ve already used. This might happen if there's been a billing mistake or a problem with your meter.`,
  payAccurateBills:
    `You need to pay any accurate bill you${APOSTROPHE}ve been sent by your supplier, including back bills. A set of rules limit the period of time a back bill can cover.`,
  conditionsIntro:
    "Our back billing rules mean you do not have to pay for energy you used more than 12 months ago if:",
  conditions: [
    `you${APOSTROPHE}ve not had an accurate bill for it before`,
    `you${APOSTROPHE}ve not been told about what you needed to pay through a statement of account before`,
    "your Direct Debit amount was previously set too low to cover what you needed to pay",
  ],
  appliesTo: "The rules apply to households and microbusinesses.",
  exceptionsIntro:
    `You will have to pay for energy used more than 12 months ago if you${APOSTROPHE}ve acted unreasonably, for example by:`,
  exceptions: [
    "stopping your supplier from billing you accurately, including by blocking access to your meter",
    "ignoring requests for payment from your supplier",
    "stealing electricity or gas",
  ],
  contactSupplier:
    `You should contact your supplier right away if you think they have not followed the back billing rules. They${APOSTROPHE}ll refund any money taken in error.`,
} as const;

export interface OfgemGuidanceCard {
  mode: "ofgem_back_billing";
  guidanceId: typeof OFGEM_BACK_BILLING_SOURCE.guidanceId;
  source: typeof OFGEM_BACK_BILLING_SOURCE;
  attribution: "Ofgem states, on its public guidance page:";
  verbatim: typeof OFGEM_BACK_BILLING_VERBATIM;
  conditionalSummary: string;
  relevance: string;
  declaresBillInvalid: false;
  legalDetermination: null;
}

export interface GeneralGuidanceCard {
  mode: "general_correspondence";
  disclaimer: "General correspondence mode — no curated statutory guidance loaded for this notice type.";
  declaresBillInvalid: false;
  legalDetermination: null;
}

const CONDITIONAL_SUMMARY =
  "Ofgem's published back-billing guidance says a household may not have to pay for energy used more than 12 months ago if an accurate bill or statement of account was not previously provided, or a Direct Debit was set too low. Ofgem also says the rule may not apply where the customer has acted unreasonably, for example by blocking meter access, ignoring payment requests, or stealing energy. NoticeLens does not decide whether those conditions are met or whether a charge is valid.";

function relevanceFor(billingGap: BillingPeriodGapStatus): string {
  if (billingGap === "gap_over_12_months") {
    return "The stated billing period includes use more than 12 months before the notice date. Ofgem's conditions may be relevant. NoticeLens does not decide whether they are met.";
  }
  if (billingGap === "within_12_months") {
    return "The stated period does not, on these dates alone, show energy use more than 12 months before the notice date. That is not a decision about whether a charge is valid.";
  }
  return "The notice does not provide a billing period that can be compared with Ofgem's 12-month condition.";
}

export function selectNoticeGuidance(
  noticeCategory: NoticeCategory,
  billingGap: BillingPeriodGapStatus
): OfgemGuidanceCard | GeneralGuidanceCard {
  if (noticeCategory !== "utility_electricity" && noticeCategory !== "utility_gas") {
    return {
      mode: "general_correspondence",
      disclaimer:
        "General correspondence mode — no curated statutory guidance loaded for this notice type.",
      declaresBillInvalid: false,
      legalDetermination: null,
    };
  }
  return {
    mode: "ofgem_back_billing",
    guidanceId: OFGEM_BACK_BILLING_SOURCE.guidanceId,
    source: OFGEM_BACK_BILLING_SOURCE,
    attribution: "Ofgem states, on its public guidance page:",
    verbatim: OFGEM_BACK_BILLING_VERBATIM,
    conditionalSummary: CONDITIONAL_SUMMARY,
    relevance: relevanceFor(billingGap),
    declaresBillInvalid: false,
    legalDetermination: null,
  };
}

export function buildOfgemCloudPromptExcerpt(): string {
  const conditions = OFGEM_BACK_BILLING_VERBATIM.conditions
    .map((item) => `- ${item}`)
    .join("\n");
  const exceptions = OFGEM_BACK_BILLING_VERBATIM.exceptions
    .map((item) => `- ${item}`)
    .join("\n");
  return [
    `Source: Ofgem, "${OFGEM_BACK_BILLING_SOURCE.title}" (${OFGEM_BACK_BILLING_SOURCE.url}), retrieved ${OFGEM_BACK_BILLING_SOURCE.retrievedOn}.`,
    "Quote Ofgem's conditions. Do not turn them into a decision that a bill is legally invalid or unenforceable.",
    OFGEM_BACK_BILLING_VERBATIM.payAccurateBills,
    OFGEM_BACK_BILLING_VERBATIM.conditionsIntro,
    conditions,
    OFGEM_BACK_BILLING_VERBATIM.exceptionsIntro,
    exceptions,
    "Boundary: explain when the published conditions may apply. Keep placeholders [RECIPIENT_NAME], [ACCOUNT_REF], and [SUPPLY_ADDRESS] verbatim.",
  ].join("\n");
}

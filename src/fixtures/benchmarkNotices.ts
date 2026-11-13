import energyBackbillOriginalRaw from "../../examples/energy-backbill-original.txt?raw";
import energyBackbillRevisedRaw from "../../examples/energy-backbill-revised.txt?raw";
import type { CloudBoundStructuralPayload, NoticeCategory } from "../domain/types";

export interface BenchmarkNoticeFixture {
  id: string;
  title: string;
  rawText: string;
  forbiddenPiiTokens: string[];
  expected: {
    noticeCategory: NoticeCategory;
    amountGBP: number;
    acceptedDeadlines: string[];
    requiredBillingPeriodTokens: string[];
    billingPeriodOptional?: boolean;
    expectedActionKeywords: string[];
    canonicalQuotes: string[];
  };
}

const GAS_CATCHUP_ARREARS_TEXT = `SYNTHETIC SAMPLE — FOR TESTING ONLY

Gas Account Catch-Up Statement
20 November 2026

Dear David Sample,

Account reference: GAS-44910
28 Sample Lane, Bristol, BS0 0BB

Following an actual meter reading, your gas account has a catch-up balance of £645.50 for gas used between 1 April 2025 and 30 September 2025.

Please pay £645.50 or contact our customer support team by 4 December 2026 to request a billing review or payment plan.

If you have photographs of earlier meter readings, please keep them ready when you get in touch.

Yours sincerely,
Example Gas Collections Team
`;

const COUNCIL_TAX_REMINDER_TEXT = `SYNTHETIC SAMPLE — FOR TESTING ONLY

Council Tax Instalment Reminder Notice
16 November 2026

Dear Priya Testperson,

Council Tax reference: CTAX-90214
9 Fictional Close, Leeds, LS0 0CC

Our records show missed Council Tax instalments totalling £312.00 for the billing period October to November 2026.

You must bring your account up to date by paying £312.00 by 30 November 2026, or contact the Council Tax office before that date if your household circumstances have changed.

If payment is not received by 30 November 2026, your right to pay by monthly instalments may be withdrawn.

Yours faithfully,
Example City Council Revenues Team
`;

const HOUSING_SERVICE_CHARGE_TEXT = `SYNTHETIC SAMPLE — FOR TESTING ONLY

Quarterly Service Charge Adjustment Notice
19 November 2026

Dear Marcus Placeholder,

Tenancy reference: TEN-7731
42 Demo Terrace, Manchester, M0 0DD

We have reconciled communal maintenance costs and calculated an additional service charge balance of £185.40 covering 1 July 2026 to 30 September 2026.

Please pay £185.40 or submit a written query requesting the summary of relevant costs by 10 December 2026.

You may inspect the supporting invoices free of charge by contacting our leasehold and tenancy team before 10 December 2026.

Yours sincerely,
Example Housing Association Neighbourhood Team
`;

export const BENCHMARK_NOTICE_FIXTURES: readonly BenchmarkNoticeFixture[] = [
  {
    id: "energy-backbill-original",
    title: "1. UK Electricity Back-Bill (£1,280 — Starter Fixture)",
    rawText: energyBackbillOriginalRaw,
    forbiddenPiiTokens: [
      "Sarah Example",
      "EXAMPLE-8472",
      "14 Example Road",
      "RG0 0AA",
    ],
    expected: {
      noticeCategory: "utility_electricity",
      amountGBP: 1280,
      acceptedDeadlines: ["25 November 2026", "2026-11-25", "25 Nov 2026"],
      requiredBillingPeriodTokens: ["january", "june", "2025"],
      expectedActionKeywords: ["pay", "contact", "meter", "records"],
      canonicalQuotes: [
        "Our records show an outstanding balance of £1,280 for electricity supplied between January and June 2025.",
        "Please pay the balance or contact our billing team by 25 November 2026 to discuss your account.",
      ],
    },
  },
  {
    id: "energy-backbill-revised",
    title: "2. Revised Electricity Statement (£520 — Starter Fixture)",
    rawText: energyBackbillRevisedRaw,
    forbiddenPiiTokens: [
      "Sarah Example",
      "EXAMPLE-8472",
      "14 Example Road",
      "RG0 0AA",
    ],
    expected: {
      noticeCategory: "utility_electricity",
      amountGBP: 520,
      acceptedDeadlines: ["16 December 2026", "2026-12-16", "16 Dec 2026"],
      requiredBillingPeriodTokens: [],
      billingPeriodOptional: true,
      expectedActionKeywords: ["contact", "billing", "questions", "520"],
      canonicalQuotes: [
        "After reviewing your earlier statement, the balance now requested is £520.",
        "Please contact our billing team by 16 December 2026 if you have questions about the revised amount.",
      ],
    },
  },
  {
    id: "gas-catchup-arrears",
    title: "3. Domestic Gas Catch-Up Statement (£645.50)",
    rawText: GAS_CATCHUP_ARREARS_TEXT,
    forbiddenPiiTokens: [
      "David Sample",
      "GAS-44910",
      "28 Sample Lane",
      "BS0 0BB",
    ],
    expected: {
      noticeCategory: "utility_gas",
      amountGBP: 645.5,
      acceptedDeadlines: ["4 December 2026", "04 December 2026", "2026-12-04", "4 Dec 2026"],
      requiredBillingPeriodTokens: ["april", "september", "2025"],
      expectedActionKeywords: ["pay", "contact", "review", "meter"],
      canonicalQuotes: [
        "Following an actual meter reading, your gas account has a catch-up balance of £645.50 for gas used between 1 April 2025 and 30 September 2025.",
        "Please pay £645.50 or contact our customer support team by 4 December 2026 to request a billing review or payment plan.",
      ],
    },
  },
  {
    id: "council-tax-reminder",
    title: "4. Council Tax Instalment Reminder (£312.00)",
    rawText: COUNCIL_TAX_REMINDER_TEXT,
    forbiddenPiiTokens: [
      "Priya Testperson",
      "CTAX-90214",
      "9 Fictional Close",
      "LS0 0CC",
    ],
    expected: {
      noticeCategory: "council_tax",
      amountGBP: 312,
      acceptedDeadlines: ["30 November 2026", "2026-11-30", "30 Nov 2026"],
      requiredBillingPeriodTokens: ["october", "november", "2026"],
      expectedActionKeywords: ["pay", "contact", "council", "instalments"],
      canonicalQuotes: [
        "Our records show missed Council Tax instalments totalling £312.00 for the billing period October to November 2026.",
        "You must bring your account up to date by paying £312.00 by 30 November 2026, or contact the Council Tax office before that date if your household circumstances have changed.",
      ],
    },
  },
  {
    id: "housing-service-charge",
    title: "5. Housing Service Charge Adjustment (£185.40)",
    rawText: HOUSING_SERVICE_CHARGE_TEXT,
    forbiddenPiiTokens: [
      "Marcus Placeholder",
      "TEN-7731",
      "42 Demo Terrace",
      "M0 0DD",
    ],
    expected: {
      noticeCategory: "housing_service_charge",
      amountGBP: 185.4,
      acceptedDeadlines: ["10 December 2026", "2026-12-10", "10 Dec 2026"],
      requiredBillingPeriodTokens: ["july", "september", "2026"],
      expectedActionKeywords: ["pay", "query", "summary", "invoices"],
      canonicalQuotes: [
        "We have reconciled communal maintenance costs and calculated an additional service charge balance of £185.40 covering 1 July 2026 to 30 September 2026.",
        "Please pay £185.40 or submit a written query requesting the summary of relevant costs by 10 December 2026.",
      ],
    },
  },
] as const;

export const M0_SMOKE_TEST_CLOUD_PAYLOAD: CloudBoundStructuralPayload = {
  schemaVersion: "noticelens.cloud-brief.v1",
  noticeCategory: "utility_electricity",
  issueDate: "18 November 2026",
  billingPeriod: "January to June 2025",
  amountGBP: 1280,
  responseDeadline: "25 November 2026",
  redactedObligations: [
    {
      actionSummary: "Pay £1,280 or contact billing team to discuss the electricity account",
      dueDate: "25 November 2026",
      redactedClause:
        "Please pay the balance or contact our billing team by 25 November 2026 to discuss your account.",
    },
    {
      actionSummary: "Provide meter reading records if challenging billing accuracy",
      dueDate: "25 November 2026",
      redactedClause:
        "If you believe you have already provided meter readings or there is an error, please provide the relevant records when you contact us.",
    },
  ],
  responseGoal: "request_billing_review",
  guidanceIds: ["ofgem-backbilling-12m-v1"],
};

/**
 * One local eligibility result for a notice.
 * Read Notice, Action Plan, closed-brief inspection, and the v2 builder
 * all read this object. None of them may turn NEEDS_REVIEW or INELIGIBLE
 * into a verified payment fact. The cloud payload does not receive these
 * evidence offsets or any notice text.
 */
export const ELIGIBILITY_STATUSES = ["ELIGIBLE", "NEEDS_REVIEW", "INELIGIBLE"] as const;

export type EligibilityStatus = (typeof ELIGIBILITY_STATUSES)[number];

export const ELIGIBILITY_REASONS = [
  "current_balance",
  "explicit_reinstatement",
  "distinct_new_charge",
  "repeated_retired_amount",
  "account_settled",
  "conditional_or_hypothetical",
  "model_directed",
  "incomplete_condition",
  "later_settlement",
  "wrong_date_role",
  "issue_date",
  "included_fee",
  "waived_fee",
  "refunded_fee",
  "conditional_fee",
  "conflicting_balances",
  "historical_or_retired",
  "insufficient_evidence",
] as const;

export type EligibilityReason = (typeof ELIGIBILITY_REASONS)[number];

/** Character offsets into the local notice. Not copied into the cloud payload. */
export interface EvidenceRef {
  sentenceIndex: number;
  start: number;
  end: number;
}

export interface EligibilityDecision {
  id: string;
  status: EligibilityStatus;
  reason: EligibilityReason;
  amount: number | null;
  role: string | null;
  evidence: EvidenceRef;
  supporting: EvidenceRef[];
  contradicting: EvidenceRef[];
  paymentActionSupported: boolean;
  deadlineSupported: boolean;
}

export interface NoticeEligibility {
  decisions: EligibilityDecision[];
  /** Outstanding balances this analysis treats as current. Empty means none. */
  eligibleAmountsGBP: number[];
  paymentActionSupported: boolean;
  deadlineSupported: boolean;
}

export const EMPTY_ELIGIBILITY: NoticeEligibility = {
  decisions: [],
  eligibleAmountsGBP: [],
  paymentActionSupported: false,
  deadlineSupported: false,
};

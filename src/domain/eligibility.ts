/**
 * One local eligibility result for a notice.
 * Each decision is an occurrence in the source. Read Notice, Action Plan,
 * closed-brief inspection, and the v2 builder derive payment facts from
 * those decisions. None of them may turn NEEDS_REVIEW or INELIGIBLE into
 * a verified payment fact. The cloud payload does not receive these
 * evidence offsets, action links, or any notice text.
 *
 * `eligibleAmountsGBP`, `paymentActionSupported`, and `deadlineSupported`
 * on the notice are summaries derived from the decisions. They do not
 * verify a different claim.
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
  "correspondence_deadline",
  "payment_deadline",
  "conflicting_deadlines",
  "conflicting_issue_dates",
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
  /** True only when this occurrence supports a payment action. */
  paymentActionSupported: boolean;
  /** True only when this occurrence supports a deadline. */
  deadlineSupported: boolean;
  /** True when contradictory deadlines were encountered for this claim/date. Sticky. */
  deadlineConflict: boolean;
  /** Source span of the linked payment action. Local only. */
  actionEvidence: EvidenceRef | null;
  /** Linked deadline, when this occurrence supports one. Local only. */
  deadlineIso: string | null;
  /** ISO calendar date grounded at `evidence` for date decisions. Local only. */
  dateIso: string | null;
}

export interface NoticeEligibility {
  decisions: EligibilityDecision[];
  /**
   * Derived from the decisions. One eligible balance, or the unresolved
   * amounts when every surviving balance is needs-review. Empty means none.
   */
  eligibleAmountsGBP: number[];
  /** True when some eligible decision supports a payment action. Not a licence for every action. */
  paymentActionSupported: boolean;
  /** True when some eligible decision supports a deadline without cross-claim conflict. */
  deadlineSupported: boolean;
  /** True when payment deadlines conflict within or across relevant claims. */
  paymentDeadlineConflict: boolean;
  /** Unambiguous correspondence response deadlines (distinct from payment deadlines). */
  correspondenceDeadlinesIso: readonly string[];
  /** True when multiple correspondence deadlines conflict. */
  correspondenceDeadlineConflict: boolean;
  /** True when multiple candidate issue dates conflict. */
  issueDateConflict: boolean;
}

export const EMPTY_ELIGIBILITY: NoticeEligibility = {
  decisions: [],
  eligibleAmountsGBP: [],
  paymentActionSupported: false,
  deadlineSupported: false,
  paymentDeadlineConflict: false,
  correspondenceDeadlinesIso: [],
  correspondenceDeadlineConflict: false,
  issueDateConflict: false,
};
Object.freeze(EMPTY_ELIGIBILITY.decisions);
Object.freeze(EMPTY_ELIGIBILITY.eligibleAmountsGBP);
Object.freeze(EMPTY_ELIGIBILITY.correspondenceDeadlinesIso);
Object.freeze(EMPTY_ELIGIBILITY);

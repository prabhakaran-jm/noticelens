export const ALLOWED_NOTICE_CATEGORIES = [
  "utility_electricity",
  "utility_gas",
  "council_tax",
  "housing_service_charge",
  "other_household_notice",
] as const;

export type NoticeCategory = (typeof ALLOWED_NOTICE_CATEGORIES)[number];

export const ALLOWED_RESPONSE_GOALS = [
  "request_billing_review",
  "request_breakdown_and_hold",
  "confirm_payment_plan_options",
] as const;

export type ResponseGoal = (typeof ALLOWED_RESPONSE_GOALS)[number];

export const ALLOWED_GUIDANCE_IDS = [
  "ofgem-backbilling-12m-v1",
  "citizens-advice-council-tax-reminder-v1",
  "housing-service-charge-summary-v1",
] as const;

export type GuidanceId = (typeof ALLOWED_GUIDANCE_IDS)[number];

/** Guidance ids that may be sent or cited for a notice category. */
export const GUIDANCE_IDS_BY_CATEGORY: Record<NoticeCategory, readonly GuidanceId[]> = {
  utility_electricity: ["ofgem-backbilling-12m-v1"],
  utility_gas: ["ofgem-backbilling-12m-v1"],
  council_tax: ["citizens-advice-council-tax-reminder-v1"],
  housing_service_charge: ["housing-service-charge-summary-v1"],
  other_household_notice: [],
};

export const ALLOWED_ACTION_SUMMARIES = [
  "pay_or_contact",
  "contact_sender",
  "provide_records",
  "request_review",
  "pay_stated_balance",
  "review_stated_obligation",
] as const;

export type ActionSummaryId = (typeof ALLOWED_ACTION_SUMMARIES)[number];

/** Zero-free-text circumstance checkboxes. Values are ids, never raw notice text. */
export const ALLOWED_CIRCUMSTANCE_FLAGS = [
  "usage_billed_over_12_months",
  "previously_provided_meter_readings",
  "request_calculation_breakdown",
  "request_account_hold_during_review",
  "request_breakdown",
  "clarify_dates",
  "query_missing_documents",
] as const;

export type CircumstanceFlag = (typeof ALLOWED_CIRCUMSTANCE_FLAGS)[number];

export interface ExtractedObligationItem {
  action: string;
  dueDate: string | null;
  sourceQuote: string;
}

export interface RawNoticeExtraction {
  noticeCategory: NoticeCategory;
  issueDate: string;
  billingPeriod: string;
  /** Null when the model omitted the amount. Never coerced from empty input to 0. */
  amountGBP: number | null;
  responseDeadline: string;
  obligations: ExtractedObligationItem[];
}

export type QuoteMatchMode = "exact" | "normalized" | "unverified";

export type UnverifiedQuoteReason = "empty" | "too_short" | "not_in_source";

export interface QuoteVerificationResult {
  verified: boolean;
  matchMode: QuoteMatchMode;
  /** Inclusive start and exclusive end into the independent source string. */
  startOffset: number | null;
  endOffset: number | null;
  matchedSubstring: string | null;
  /** Present when a quote is unmatched or fabricated. Never omitted on failure. */
  unverifiedReason: UnverifiedQuoteReason | null;
}

export interface VerifiedObligationItem extends ExtractedObligationItem {
  verification: QuoteVerificationResult;
}

export interface VerifiedNoticeExtraction
  extends Omit<RawNoticeExtraction, "obligations"> {
  obligations: VerifiedObligationItem[];
}

export interface CloudBillingWindow {
  /** YYYY-MM or YYYY-MM-DD. Day precision is included only when the notice stated a day. */
  start: string;
  end: string;
}

export interface CloudBoundRedactedObligation {
  actionSummary: ActionSummaryId;
  /** ISO date, or null when the notice did not state one. */
  dueDate: string | null;
  redactedClause: string;
}

export interface CloudBoundStructuralPayload {
  schemaVersion: "noticelens.cloud-brief.v1";
  noticeCategory: NoticeCategory;
  /** ISO date, or null when no issue date was stated. */
  issueDate: string | null;
  billingPeriod: CloudBillingWindow | null;
  /** Explicit amounts only. An empty array means none were stated, not £0. */
  amountsGBP: number[];
  /** ISO dates. An empty array means none were stated. */
  responseDeadlines: string[];
  redactedObligations: CloudBoundRedactedObligation[];
  responseGoal: ResponseGoal;
  guidanceIds: GuidanceId[];
  /** Optional. Omitted means the user selected no circumstance flags. */
  circumstanceFlags?: CircumstanceFlag[];
}

export interface CloudResponseOption {
  title: string;
  rationale: string;
  applicableCondition: string;
}

export interface CloudDraftOutput {
  summaryPlainEnglish: string;
  options: CloudResponseOption[];
  replyTemplateWithPlaceholders: string;
  citedGuidanceIds: string[];
}

export interface InferenceCallRecord<T> {
  output: T;
  rawResponseText: string;
  inferenceSource: string | undefined;
  latencyMs: number;
}

export type LocalIdentifierKind =
  | "recipient_name"
  | "account_ref"
  | "supply_address"
  | "email"
  | "phone"
  | "other";

export interface LocalIdentifierEntry {
  kind: LocalIdentifierKind;
  placeholder: string;
  rawValue: string;
  startOffset: number;
  endOffset: number;
}

/** Stays in browser memory. Do not copy entries into a cloud payload. */
export interface LocalIdentifierMap {
  locality: "browser-only";
  entries: LocalIdentifierEntry[];
}

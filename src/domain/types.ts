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

export interface ExtractedObligationItem {
  action: string;
  dueDate: string | null;
  sourceQuote: string;
}

export interface RawNoticeExtraction {
  noticeCategory: NoticeCategory;
  issueDate: string;
  billingPeriod: string;
  amountGBP: number;
  responseDeadline: string;
  obligations: ExtractedObligationItem[];
}

export type QuoteMatchMode = "exact" | "normalized" | "unverified";

export interface QuoteVerificationResult {
  verified: boolean;
  matchMode: QuoteMatchMode;
  startOffset: number | null;
  endOffset: number | null;
  matchedSubstring: string | null;
}

export interface VerifiedObligationItem extends ExtractedObligationItem {
  verification: QuoteVerificationResult;
}

export interface VerifiedNoticeExtraction
  extends Omit<RawNoticeExtraction, "obligations"> {
  obligations: VerifiedObligationItem[];
}

export interface CloudBoundRedactedObligation {
  actionSummary: string;
  dueDate: string | null;
  redactedClause: string;
}

export interface CloudBoundStructuralPayload {
  schemaVersion: "noticelens.cloud-brief.v1";
  noticeCategory: NoticeCategory;
  issueDate: string;
  billingPeriod: string;
  amountGBP: number;
  responseDeadline: string;
  redactedObligations: CloudBoundRedactedObligation[];
  responseGoal: ResponseGoal;
  guidanceIds: GuidanceId[];
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

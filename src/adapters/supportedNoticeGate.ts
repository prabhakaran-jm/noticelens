import originalSample from "../../examples/energy-backbill-original.txt?raw";
import revisedSample from "../../examples/energy-backbill-revised.txt?raw";
import { buildClosedCloudBrief } from "./buildClosedCloudBrief";
import {
  displayVerifiedAmount,
  displayVerifiedIssueDate,
  groundNoticeFacts,
  verifiedResponseDeadlineIso,
} from "./groundNoticeFacts";
import { CLOSED_CLOUD_BRIEF_ROOT_KEYS, type ClosedCloudBrief } from "../domain/closedCloudBrief";
import { normalizeNewlines } from "../domain/textNormalize";
import type { ActionSummaryId } from "../domain/types";

/**
 * Narrow demo gate for a future cloud-drafting check.
 * Exact fixture text is the identity. Amounts, suppliers, categories,
 * payment phrases, model text, and approval do not grant eligibility.
 * This function does not send and does not authorise a send.
 */

export type SupportedNoticeState = "DEMO_ELIGIBLE" | "LOCAL_REVIEW_ONLY";

export type SupportedNoticeRejection =
  | "stale_source_generation"
  | "not_approved_fixture"
  | "grounding_mismatch"
  | "obligation_mismatch"
  | "unexpected_v2_field"
  | "identifier_in_payload"
  | "v2_mismatch"
  | "v2_validation_failed";

export interface SupportedNoticeDecision {
  readonly state: SupportedNoticeState;
  readonly reason: SupportedNoticeRejection | null;
  readonly sourceGenerationId: string;
  readonly fixtureId: string | null;
  readonly authorisesSend: false;
}

interface ExpectedObligation {
  readonly actionSummary: ActionSummaryId;
  readonly dueDate: string | null;
}

interface ApprovedFixture {
  readonly id: string;
  readonly text: string;
  readonly issueDate: string;
  readonly issueDateIso: string;
  readonly amountGBP: number;
  readonly deadlineIso: string;
  readonly noticeCategory: ClosedCloudBrief["noticeCategory"];
  readonly billingPeriod: ClosedCloudBrief["billingPeriod"];
  readonly obligations: readonly ExpectedObligation[];
  readonly guidanceIds: readonly string[];
  readonly forbiddenInPayload: readonly string[];
}

const RESPONSE_GOAL = "request_billing_review" as const;

const ORIGINAL_TEXT = normalizeNewlines(originalSample);
const REVISED_TEXT = normalizeNewlines(revisedSample);

/**
 * Expected facts are checked only after the source matches a fixture.
 * They are not a substitute for that match.
 */
const APPROVED_FIXTURES: readonly ApprovedFixture[] = [
  {
    id: "energy-backbill-original",
    text: ORIGINAL_TEXT,
    issueDate: "18 November 2026",
    issueDateIso: "2026-11-18",
    amountGBP: 1280,
    deadlineIso: "2026-11-25",
    noticeCategory: "utility_electricity",
    billingPeriod: { start: "2025-01", end: "2025-06" },
    obligations: [{ actionSummary: "pay_or_contact", dueDate: "2026-11-25" }],
    guidanceIds: ["ofgem-backbilling-12m-v1"],
    forbiddenInPayload: [
      "Sarah Example",
      "EXAMPLE-8472",
      "example-8472",
      "14 Example Road",
      "RG0 0AA",
      "Our records show an outstanding balance of £1,280",
    ],
  },
  {
    id: "energy-backbill-revised",
    text: REVISED_TEXT,
    issueDate: "2 December 2026",
    issueDateIso: "2026-12-02",
    amountGBP: 520,
    deadlineIso: "2026-12-16",
    noticeCategory: "other_household_notice",
    billingPeriod: null,
    obligations: [{ actionSummary: "contact_sender", dueDate: "2026-12-16" }],
    guidanceIds: [],
    forbiddenInPayload: [
      "Sarah Example",
      "EXAMPLE-8472",
      "example-8472",
      "14 Example Road",
      "RG0 0AA",
      "the balance now requested is £520",
    ],
  },
];

const ALLOWED_KEYS = new Set<string>(CLOSED_CLOUD_BRIEF_ROOT_KEYS);

function fnv1a(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Identity of this exact source. It contains no notice text and no account token. */
export function sourceGenerationId(text: string): string {
  const canonical = normalizeNewlines(text);
  return `sg1-${fnv1a(`v1\n${canonical}`)}-${canonical.length.toString(16)}`;
}

function localOnly(
  text: string,
  reason: SupportedNoticeRejection
): SupportedNoticeDecision {
  return {
    state: "LOCAL_REVIEW_ONLY",
    reason,
    sourceGenerationId: sourceGenerationId(text),
    fixtureId: null,
    authorisesSend: false,
  };
}

function sameObligations(
  actual: readonly { actionSummary: string; dueDate: string | null }[],
  expected: readonly ExpectedObligation[]
): boolean {
  if (actual.length !== expected.length) {
    return false;
  }
  return actual.every(
    (item, index) =>
      item.actionSummary === expected[index]?.actionSummary && item.dueDate === expected[index]?.dueDate
  );
}

function expectedPayloadKeys(): string[] {
  return [...CLOSED_CLOUD_BRIEF_ROOT_KEYS].sort();
}

/** Extra or missing canonical keys fail closed. This does not grant eligibility. */
export function rejectionForPayloadShape(payload: object): "unexpected_v2_field" | null {
  const keys = Object.keys(payload).sort();
  if (keys.join("\n") !== expectedPayloadKeys().join("\n") || keys.some((key) => !ALLOWED_KEYS.has(key))) {
    return "unexpected_v2_field";
  }
  return null;
}

/**
 * Re-reads the live source. A stored decision, a checkbox, a session id,
 * and model text are not inputs to the match.
 */
export function assessSupportedNotice(input: {
  rawNoticeText: string;
  today: string;
  claimedSourceGenerationId?: string | null;
  sessionId?: string | null;
  approvalGranted?: boolean;
  modelText?: string | null;
}): SupportedNoticeDecision {
  void input.sessionId;
  void input.approvalGranted;
  void input.modelText;
  const text = normalizeNewlines(input.rawNoticeText);
  const liveId = sourceGenerationId(text);
  if (input.claimedSourceGenerationId != null && input.claimedSourceGenerationId !== liveId) {
    return localOnly(text, "stale_source_generation");
  }
  const fixture = APPROVED_FIXTURES.find((item) => item.text === text);
  if (!fixture) {
    return localOnly(text, "not_approved_fixture");
  }

  const view = groundNoticeFacts({ rawNoticeText: text, today: input.today });
  let payload: ClosedCloudBrief;
  try {
    payload = buildClosedCloudBrief({ view, responseGoal: RESPONSE_GOAL }).payload;
  } catch {
    return localOnly(text, "v2_validation_failed");
  }

  const serialized = JSON.stringify(payload);
  if (fixture.forbiddenInPayload.some((token) => serialized.includes(token))) {
    return localOnly(text, "identifier_in_payload");
  }
  if (rejectionForPayloadShape(payload) === "unexpected_v2_field") {
    return localOnly(text, "unexpected_v2_field");
  }
  if (!sameObligations(payload.obligations, fixture.obligations)) {
    return localOnly(text, "obligation_mismatch");
  }
  const amount = displayVerifiedAmount(view);
  const issue = displayVerifiedIssueDate(view);
  const deadline = verifiedResponseDeadlineIso(view);
  if (amount !== fixture.amountGBP || issue !== fixture.issueDate || deadline !== fixture.deadlineIso) {
    return localOnly(text, "grounding_mismatch");
  }
  const billingMatches =
    fixture.billingPeriod === null
      ? payload.billingPeriod === null
      : payload.billingPeriod?.start === fixture.billingPeriod.start &&
        payload.billingPeriod?.end === fixture.billingPeriod.end;
  if (
    payload.schemaVersion !== "noticelens.cloud-brief.v2" ||
    payload.noticeCategory !== fixture.noticeCategory ||
    payload.issueDate !== fixture.issueDateIso ||
    !billingMatches ||
    payload.amountsGBP.length !== 1 ||
    payload.amountsGBP[0] !== fixture.amountGBP ||
    payload.responseDeadlines.length !== 1 ||
    payload.responseDeadlines[0] !== fixture.deadlineIso ||
    payload.responseGoal !== RESPONSE_GOAL ||
    payload.guidanceIds.join("\n") !== fixture.guidanceIds.join("\n") ||
    payload.circumstanceFlags != null
  ) {
    return localOnly(text, "v2_mismatch");
  }

  return {
    state: "DEMO_ELIGIBLE",
    reason: null,
    sourceGenerationId: liveId,
    fixtureId: fixture.id,
    authorisesSend: false,
  };
}


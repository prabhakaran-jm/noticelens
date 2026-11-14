import { hasAtMostTwoDecimalPlaces } from "./amounts";
import { parseCalendarDate } from "./dates";
import {
  ALLOWED_ACTION_SUMMARIES,
  ALLOWED_CIRCUMSTANCE_FLAGS,
  ALLOWED_GUIDANCE_IDS,
  ALLOWED_NOTICE_CATEGORIES,
  ALLOWED_RESPONSE_GOALS,
  GUIDANCE_IDS_BY_CATEGORY,
  type ActionSummaryId,
  type CircumstanceFlag,
  type CloudBillingWindow,
  type GuidanceId,
  type NoticeCategory,
  type ResponseGoal,
} from "./types";

/** Closed brief. No notice prose, placeholders, or identifier map. */
export const CLOSED_CLOUD_BRIEF_SCHEMA_VERSION = "noticelens.cloud-brief.v2" as const;

export const CLOSED_CLOUD_BRIEF_ROOT_KEYS = [
  "schemaVersion",
  "noticeCategory",
  "issueDate",
  "billingPeriod",
  "amountsGBP",
  "responseDeadlines",
  "obligations",
  "responseGoal",
  "guidanceIds",
] as const;

export const CLOSED_CLOUD_BRIEF_OPTIONAL_KEYS = ["circumstanceFlags"] as const;

export const CLOSED_CLOUD_OBLIGATION_KEYS = ["actionSummary", "dueDate"] as const;

export const CLOSED_CLOUD_BRIEF_LIMITS = {
  maxObligations: 6,
  maxAmounts: 6,
  maxDeadlines: 6,
  maxGuidanceIds: 5,
  maxCircumstanceFlags: 8,
  maxAmountGBP: 1_000_000,
  maxSerializedLength: 2_600,
} as const;

/**
 * Trusted labels for action ids. These sentences are not notice text and are
 * not fields in the canonical JSON.
 */
export const TRUSTED_ACTION_SUMMARY_LABELS: Record<ActionSummaryId, string> = {
  pay_or_contact: "Pay or contact the sender",
  contact_sender: "Contact the sender",
  provide_records: "Provide records",
  request_review: "Request a review",
  pay_stated_balance: "Pay the stated balance",
  review_stated_obligation: "Review the stated obligation",
};

export function trustedActionSummaryLabel(id: ActionSummaryId): string {
  return TRUSTED_ACTION_SUMMARY_LABELS[id];
}

export interface ClosedCloudObligation {
  actionSummary: ActionSummaryId;
  /** ISO date, or null when the notice did not state a separate due date. */
  dueDate: string | null;
}

/**
 * `amountsGBP` is the verified outstanding balance only.
 * An empty array means no such balance was supported. It does not mean £0.
 * Historical payments, cancelled or withdrawn charges, conditional fees,
 * and ambiguous figures are omitted. This list does not repair a grounding
 * error: a figure local code wrongly marks as a current balance can still appear.
 */
export interface ClosedCloudBrief {
  schemaVersion: typeof CLOSED_CLOUD_BRIEF_SCHEMA_VERSION;
  noticeCategory: NoticeCategory;
  issueDate: string | null;
  billingPeriod: CloudBillingWindow | null;
  amountsGBP: number[];
  responseDeadlines: string[];
  obligations: ClosedCloudObligation[];
  responseGoal: ResponseGoal;
  guidanceIds: GuidanceId[];
  circumstanceFlags?: CircumstanceFlag[];
}

export interface CanonicalClosedCloudBrief {
  payload: ClosedCloudBrief;
  serialized: string;
}

export class ClosedCloudBriefValidationError extends Error {
  public readonly violations: readonly string[];

  constructor(violations: string[]) {
    super(
      `Closed cloud brief rejected (${violations.length} violation(s)): ${violations.join("; ")}`
    );
    this.name = "ClosedCloudBriefValidationError";
    this.violations = Object.freeze([...violations]);
  }
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH = /^(\d{4})-(\d{2})$/;
const FORBIDDEN_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "redactedClause",
  "redactedObligations",
  "sourceQuote",
  "rawNoticeText",
  "localIdentifierMap",
  "identifierMap",
  "placeholders",
  "recipientName",
  "accountReference",
  "supplyAddress",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function rejectUnsafeKey(key: string, violations: string[]): boolean {
  if (FORBIDDEN_KEYS.has(key)) {
    violations.push("payload contains a forbidden key");
    return true;
  }
  return false;
}

function assertArrayOwnProperties(value: unknown[], violations: string[]): boolean {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    violations.push("payload contains a non-plain array");
    return false;
  }
  for (const name of Object.getOwnPropertyNames(value)) {
    if (name === "length") {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor?.enumerable) {
      violations.push("payload has a non-enumerable property");
      return false;
    }
    if (!/^\d+$/.test(name)) {
      violations.push("payload has an extra enumerable property");
      return false;
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      violations.push("payload contains an empty array slot");
      return false;
    }
  }
  return true;
}

function noteNonJson(value: unknown, violations: string[]): boolean {
  const valueType = typeof value;
  if (
    valueType === "undefined" ||
    valueType === "function" ||
    valueType === "symbol" ||
    valueType === "bigint"
  ) {
    violations.push("payload contains a value that is not a JSON value");
    return false;
  }
  return true;
}

function readIsoDate(value: unknown, violations: string[]): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || !ISO_DATE.test(value) || !parseCalendarDate(value)) {
    violations.push("a date field must be an ISO calendar date or null");
    return undefined;
  }
  return value;
}

function readMonthOrDate(value: unknown, violations: string[]): string | undefined {
  if (typeof value !== "string") {
    violations.push("a billing window field is not a calendar value");
    return undefined;
  }
  if (ISO_DATE.test(value)) {
    if (!parseCalendarDate(value)) {
      violations.push("a billing window field is not a calendar value");
      return undefined;
    }
    return value;
  }
  const month = ISO_MONTH.exec(value);
  if (!month) {
    violations.push("a billing window field is not a calendar value");
    return undefined;
  }
  const monthNumber = Number(month[2]);
  if (monthNumber < 1 || monthNumber > 12) {
    violations.push("a billing window field is not a calendar value");
    return undefined;
  }
  return value;
}

function windowSortKey(value: string): string {
  return value.length === 7 ? `${value}-00` : value;
}

function readAmount(value: unknown, violations: string[]): number | undefined {
  if (!noteNonJson(value, violations)) {
    return undefined;
  }
  if (typeof value !== "number" || Object.is(value, -0) || !Number.isFinite(value)) {
    violations.push("payload contains a non-finite JSON number");
    return undefined;
  }
  if (value < 0 || value > CLOSED_CLOUD_BRIEF_LIMITS.maxAmountGBP || !hasAtMostTwoDecimalPlaces(value)) {
    violations.push("amountsGBP is outside the allowed range");
    return undefined;
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}

function fail(violations: string[]): never {
  throw new ClosedCloudBriefValidationError(
    violations.length > 0 ? violations : ["Closed cloud brief did not match the allowlist"]
  );
}

/**
 * Validates and canonicalizes a closed v2 brief.
 * v1 payloads, notice quotations, and unknown properties are rejected.
 * The returned payload is a frozen copy. `serialized` is its exact JSON.
 * Violation text does not include field values.
 */
export function canonicalClosedCloudBrief(input: unknown): CanonicalClosedCloudBrief {
  const violations: string[] = [];
  if (!isPlainObject(input)) {
    fail(["Payload root must be a plain JSON object"]);
  }
  if (input.schemaVersion === "noticelens.cloud-brief.v1" || "redactedObligations" in input || "redactedClause" in input) {
    violations.push("v1 payload is not accepted at the v2 boundary");
  }

  const allowedRoot = new Set<string>([
    ...CLOSED_CLOUD_BRIEF_ROOT_KEYS,
    ...CLOSED_CLOUD_BRIEF_OPTIONAL_KEYS,
  ]);
  for (const key of Object.keys(input)) {
    if (rejectUnsafeKey(key, violations)) {
      continue;
    }
    if (!allowedRoot.has(key)) {
      violations.push("unexpected key is not on allowlist");
    }
  }
  for (const requiredKey of CLOSED_CLOUD_BRIEF_ROOT_KEYS) {
    if (!(requiredKey in input)) {
      violations.push("missing required allowlisted field");
    }
  }

  if (input.schemaVersion !== CLOSED_CLOUD_BRIEF_SCHEMA_VERSION) {
    violations.push("schemaVersion is not the closed cloud brief schema");
  }

  let noticeCategory: NoticeCategory | undefined;
  if (
    typeof input.noticeCategory !== "string" ||
    !(ALLOWED_NOTICE_CATEGORIES as readonly string[]).includes(input.noticeCategory)
  ) {
    violations.push("noticeCategory is not an allowed category");
  } else {
    noticeCategory = input.noticeCategory as NoticeCategory;
  }

  const issueDate = readIsoDate(input.issueDate, violations);

  let billingPeriod: CloudBillingWindow | null | undefined;
  if (input.billingPeriod === null) {
    billingPeriod = null;
  } else if (!isPlainObject(input.billingPeriod)) {
    violations.push("billingPeriod is not a billing window or null");
    billingPeriod = undefined;
  } else {
    for (const key of Object.keys(input.billingPeriod)) {
      if (rejectUnsafeKey(key, violations)) {
        continue;
      }
      if (key !== "start" && key !== "end") {
        violations.push("unexpected key is not on allowlist");
      }
    }
    if (!("start" in input.billingPeriod) || !("end" in input.billingPeriod)) {
      violations.push("billingPeriod is missing a window bound");
    }
    const start = readMonthOrDate(input.billingPeriod.start, violations);
    const end = readMonthOrDate(input.billingPeriod.end, violations);
    if (start && end) {
      if (windowSortKey(start) > windowSortKey(end)) {
        violations.push("billingPeriod window is out of order");
      } else {
        billingPeriod = { start, end };
      }
    }
  }

  const amountsGBP: number[] = [];
  if (!Array.isArray(input.amountsGBP)) {
    violations.push("amountsGBP must be an array");
  } else if (
    input.amountsGBP.length > CLOSED_CLOUD_BRIEF_LIMITS.maxAmounts ||
    !assertArrayOwnProperties(input.amountsGBP, violations)
  ) {
    if (input.amountsGBP.length > CLOSED_CLOUD_BRIEF_LIMITS.maxAmounts) {
      violations.push("amountsGBP has too many entries");
    }
  } else {
    for (const item of input.amountsGBP) {
      const amount = readAmount(item, violations);
      if (amount !== undefined) {
        amountsGBP.push(amount);
      }
    }
  }

  const responseDeadlines: string[] = [];
  if (!Array.isArray(input.responseDeadlines)) {
    violations.push("responseDeadlines must be an array");
  } else if (
    input.responseDeadlines.length > CLOSED_CLOUD_BRIEF_LIMITS.maxDeadlines ||
    !assertArrayOwnProperties(input.responseDeadlines, violations)
  ) {
    if (input.responseDeadlines.length > CLOSED_CLOUD_BRIEF_LIMITS.maxDeadlines) {
      violations.push("responseDeadlines has too many entries");
    }
  } else {
    const seen = new Set<string>();
    for (const item of input.responseDeadlines) {
      const iso = readIsoDate(item, violations);
      if (iso === undefined || iso === null) {
        if (iso === null) {
          violations.push("a date field must be an ISO calendar date or null");
        }
        continue;
      }
      if (issueDate && iso === issueDate) {
        violations.push("an issue date is not a response deadline");
      }
      if (seen.has(iso)) {
        violations.push("responseDeadlines duplicates a date");
      }
      seen.add(iso);
      responseDeadlines.push(iso);
    }
  }

  const obligations: ClosedCloudObligation[] = [];
  if (!Array.isArray(input.obligations)) {
    violations.push("obligations must be an array");
  } else if (
    input.obligations.length > CLOSED_CLOUD_BRIEF_LIMITS.maxObligations ||
    !assertArrayOwnProperties(input.obligations, violations)
  ) {
    if (input.obligations.length > CLOSED_CLOUD_BRIEF_LIMITS.maxObligations) {
      violations.push("obligations has too many entries");
    }
  } else {
    const allowedObligation = new Set<string>(CLOSED_CLOUD_OBLIGATION_KEYS);
    for (const item of input.obligations) {
      if (!isPlainObject(item)) {
        violations.push("an obligation must be a plain object");
        continue;
      }
      for (const key of Object.keys(item)) {
        if (rejectUnsafeKey(key, violations)) {
          continue;
        }
        if (!allowedObligation.has(key)) {
          violations.push("unexpected key is not on allowlist");
        }
      }
      for (const requiredKey of CLOSED_CLOUD_OBLIGATION_KEYS) {
        if (!(requiredKey in item)) {
          violations.push("an obligation is missing a required field");
        }
      }
      if (!noteNonJson(item.actionSummary, violations) || !noteNonJson(item.dueDate, violations)) {
        continue;
      }
      if (
        typeof item.actionSummary !== "string" ||
        !(ALLOWED_ACTION_SUMMARIES as readonly string[]).includes(item.actionSummary)
      ) {
        violations.push("actionSummary is not an allowed action id");
        continue;
      }
      const dueDate = readIsoDate(item.dueDate, violations);
      if (dueDate === undefined) {
        continue;
      }
      obligations.push({
        actionSummary: item.actionSummary as ActionSummaryId,
        dueDate,
      });
    }
  }

  let responseGoal: ResponseGoal | undefined;
  if (
    typeof input.responseGoal !== "string" ||
    !(ALLOWED_RESPONSE_GOALS as readonly string[]).includes(input.responseGoal)
  ) {
    violations.push("responseGoal is not an allowed goal");
  } else {
    responseGoal = input.responseGoal as ResponseGoal;
  }

  const guidanceIds: GuidanceId[] = [];
  if (!Array.isArray(input.guidanceIds)) {
    violations.push("guidanceIds must be an array");
  } else if (
    input.guidanceIds.length > CLOSED_CLOUD_BRIEF_LIMITS.maxGuidanceIds ||
    !assertArrayOwnProperties(input.guidanceIds, violations)
  ) {
    if (input.guidanceIds.length > CLOSED_CLOUD_BRIEF_LIMITS.maxGuidanceIds) {
      violations.push("guidanceIds has too many entries");
    }
  } else {
    const allowedForCategory = noticeCategory
      ? new Set<string>(GUIDANCE_IDS_BY_CATEGORY[noticeCategory])
      : null;
    const seen = new Set<string>();
    for (const gid of input.guidanceIds) {
      if (
        typeof gid !== "string" ||
        !(ALLOWED_GUIDANCE_IDS as readonly string[]).includes(gid) ||
        (allowedForCategory !== null && !allowedForCategory.has(gid))
      ) {
        violations.push("guidanceIds contains an id that is not allowed for this notice category");
        continue;
      }
      if (seen.has(gid)) {
        violations.push("guidanceIds duplicates an allowed id");
      }
      seen.add(gid);
      guidanceIds.push(gid as GuidanceId);
    }
  }

  const hasFlags = Object.prototype.hasOwnProperty.call(input, "circumstanceFlags");
  let circumstanceFlags: CircumstanceFlag[] | undefined;
  if (hasFlags) {
    const flags = input.circumstanceFlags;
    if (!Array.isArray(flags) || flags.length > CLOSED_CLOUD_BRIEF_LIMITS.maxCircumstanceFlags) {
      violations.push("circumstanceFlags must be a bounded array");
    } else if (assertArrayOwnProperties(flags, violations)) {
      const seen = new Set<string>();
      const collected: CircumstanceFlag[] = [];
      for (const flag of flags) {
        if (
          typeof flag !== "string" ||
          !(ALLOWED_CIRCUMSTANCE_FLAGS as readonly string[]).includes(flag)
        ) {
          violations.push("circumstanceFlags contains an unknown circumstance flag");
          continue;
        }
        if (seen.has(flag)) {
          violations.push("circumstanceFlags duplicates an allowed id");
        }
        seen.add(flag);
        collected.push(flag as CircumstanceFlag);
      }
      circumstanceFlags = collected;
    }
  }

  if (
    violations.length > 0 ||
    !noticeCategory ||
    issueDate === undefined ||
    billingPeriod === undefined ||
    !responseGoal ||
    !Array.isArray(input.obligations) ||
    obligations.length !== input.obligations.length ||
    !Array.isArray(input.guidanceIds) ||
    guidanceIds.length !== input.guidanceIds.length
  ) {
    fail(violations);
  }

  const canonical: ClosedCloudBrief = {
    schemaVersion: CLOSED_CLOUD_BRIEF_SCHEMA_VERSION,
    noticeCategory,
    issueDate,
    billingPeriod,
    amountsGBP,
    responseDeadlines,
    obligations,
    responseGoal,
    guidanceIds,
  };
  if (circumstanceFlags && circumstanceFlags.length > 0) {
    canonical.circumstanceFlags = circumstanceFlags;
  }

  const serialized = JSON.stringify(canonical);
  if (serialized.length > CLOSED_CLOUD_BRIEF_LIMITS.maxSerializedLength) {
    fail(["serialized payload exceeds the length cap"]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    fail(["payload did not round-trip through JSON"]);
  }
  if (JSON.stringify(parsed) !== serialized) {
    fail(["payload did not round-trip through JSON"]);
  }

  return {
    payload: deepFreeze(parsed as ClosedCloudBrief),
    serialized,
  };
}

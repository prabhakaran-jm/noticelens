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

/**
 * A schema-valid brief is not evidence that a payment figure or obligation is correct.
 * R5-3 remains open. Do not present this sentence as a clearance for cloud submission.
 */
export const STRUCTURAL_VALIDATION_DOES_NOT_ESTABLISH_PAYMENT_CORRECTNESS =
  "Structural validation does not establish that a payment obligation is correct.";

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

function readStableData(
  target: object,
  key: string,
  violations: string[]
): { ok: true; value: unknown } | { ok: false } {
  let first: PropertyDescriptor | undefined;
  let second: PropertyDescriptor | undefined;
  try {
    first = Object.getOwnPropertyDescriptor(target, key);
    second = Object.getOwnPropertyDescriptor(target, key);
  } catch {
    violations.push("payload property cannot be read safely");
    return { ok: false };
  }
  if (!first || !second) {
    violations.push("payload contains an empty array slot");
    return { ok: false };
  }
  if (
    first.get ||
    first.set ||
    second.get ||
    second.set ||
    !("value" in first) ||
    !("value" in second)
  ) {
    violations.push("a payload property must be an own data property");
    return { ok: false };
  }
  if (!Object.is(first.value, second.value)) {
    violations.push("payload property changed between reads");
    return { ok: false };
  }
  return { ok: true, value: first.value };
}

function noteInheritedProperties(value: object, violations: string[]): void {
  const watched = [
    ...CLOSED_CLOUD_BRIEF_ROOT_KEYS,
    ...CLOSED_CLOUD_BRIEF_OPTIONAL_KEYS,
    ...CLOSED_CLOUD_OBLIGATION_KEYS,
    "start",
    "end",
  ];
  for (const key of watched) {
    let own = false;
    let inherited = false;
    try {
      own = Object.prototype.hasOwnProperty.call(value, key);
      inherited = !own && key in value;
    } catch {
      violations.push("payload property cannot be read safely");
      return;
    }
    if (inherited) {
      violations.push("an inherited property is not accepted");
    }
  }
}

function snapshotArray(value: unknown[], violations: string[], depth: number): unknown[] | undefined {
  let lengthDesc: PropertyDescriptor | undefined;
  let lengthAgain: PropertyDescriptor | undefined;
  try {
    lengthDesc = Object.getOwnPropertyDescriptor(value, "length");
    lengthAgain = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    violations.push("payload property cannot be read safely");
    return undefined;
  }
  if (
    !lengthDesc ||
    !lengthAgain ||
    lengthDesc.get ||
    lengthDesc.set ||
    lengthAgain.get ||
    lengthAgain.set ||
    !("value" in lengthDesc) ||
    !("value" in lengthAgain) ||
    !Object.is(lengthDesc.value, lengthAgain.value) ||
    typeof lengthDesc.value !== "number" ||
    !Number.isInteger(lengthDesc.value)
  ) {
    violations.push("a payload property must be an own data property");
    return undefined;
  }
  if (lengthDesc.value > 32) {
    violations.push("payload has too many entries");
    return undefined;
  }
  const copy: unknown[] = [];
  for (let index = 0; index < lengthDesc.value; index += 1) {
    const read = readStableData(value, String(index), violations);
    if (!read.ok) {
      return undefined;
    }
    copy.push(snapshotJson(read.value, violations, depth + 1));
  }
  return copy;
}

function snapshotObject(
  value: object,
  violations: string[],
  depth: number
): Record<string, unknown> | undefined {
  noteInheritedProperties(value, violations);
  let names: string[];
  let again: string[];
  try {
    names = Object.getOwnPropertyNames(value);
    again = Object.getOwnPropertyNames(value);
  } catch {
    violations.push("payload property cannot be read safely");
    return undefined;
  }
  if (names.length !== again.length || names.some((name, index) => name !== again[index])) {
    violations.push("payload property changed between reads");
    return undefined;
  }
  const copy: Record<string, unknown> = {};
  for (const key of names) {
    if (key === "redactedClause" || key === "redactedObligations") {
      violations.push("v1 payload is not accepted at the v2 boundary");
      continue;
    }
    if (FORBIDDEN_KEYS.has(key)) {
      violations.push("payload contains a forbidden key");
      continue;
    }
    const read = readStableData(value, key, violations);
    if (!read.ok) {
      continue;
    }
    copy[key] = snapshotJson(read.value, violations, depth + 1);
  }
  return copy;
}

/** One plain copy. Later validation does not read the caller's object again. */
function snapshotJson(value: unknown, violations: string[], depth: number): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value !== "object") {
    violations.push("payload contains a value that is not a JSON value");
    return undefined;
  }
  if (depth > 8) {
    violations.push("payload is too deep");
    return undefined;
  }
  let prototype: unknown;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    violations.push("payload property cannot be read safely");
    return undefined;
  }
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) {
      violations.push("payload contains a non-plain array");
      return undefined;
    }
    return snapshotArray(value, violations, depth);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    violations.push("an inherited prototype is not accepted");
    return undefined;
  }
  return snapshotObject(value, violations, depth);
}

/**
 * Validates and canonicalizes a closed v2 brief.
 * v1 payloads, notice quotations, and unknown properties are rejected.
 * The returned payload is a frozen copy. `serialized` is its exact JSON.
 * Violation text does not include field values.
 */
export function canonicalClosedCloudBrief(input: unknown): CanonicalClosedCloudBrief {
  return canonicalizeClosedCloudBrief(input, false);
}

function canonicalizeClosedCloudBrief(value: unknown, recheck: boolean): CanonicalClosedCloudBrief {
  const violations: string[] = [];
  let source: Record<string, unknown>;
  if (!recheck) {
    const snapshot = snapshotJson(value, violations, 0);
    if (!isPlainObject(snapshot) || violations.length > 0) {
      fail(violations.length > 0 ? violations : ["Payload root must be a plain JSON object"]);
    }
    source = snapshot;
  } else if (!isPlainObject(value)) {
    fail(["payload did not round-trip through JSON"]);
  } else {
    source = value;
  }
  if (source.schemaVersion === "noticelens.cloud-brief.v1" || "redactedObligations" in source || "redactedClause" in source) {
    violations.push("v1 payload is not accepted at the v2 boundary");
  }

  const allowedRoot = new Set<string>([
    ...CLOSED_CLOUD_BRIEF_ROOT_KEYS,
    ...CLOSED_CLOUD_BRIEF_OPTIONAL_KEYS,
  ]);
  for (const key of Object.keys(source)) {
    if (rejectUnsafeKey(key, violations)) {
      continue;
    }
    if (!allowedRoot.has(key)) {
      violations.push("unexpected key is not on allowlist");
    }
  }
  for (const requiredKey of CLOSED_CLOUD_BRIEF_ROOT_KEYS) {
    if (!(requiredKey in source)) {
      violations.push("missing required allowlisted field");
    }
  }

  if (source.schemaVersion !== CLOSED_CLOUD_BRIEF_SCHEMA_VERSION) {
    violations.push("schemaVersion is not the closed cloud brief schema");
  }

  let noticeCategory: NoticeCategory | undefined;
  if (
    typeof source.noticeCategory !== "string" ||
    !(ALLOWED_NOTICE_CATEGORIES as readonly string[]).includes(source.noticeCategory)
  ) {
    violations.push("noticeCategory is not an allowed category");
  } else {
    noticeCategory = source.noticeCategory as NoticeCategory;
  }

  const issueDate = readIsoDate(source.issueDate, violations);

  let billingPeriod: CloudBillingWindow | null | undefined;
  if (source.billingPeriod === null) {
    billingPeriod = null;
  } else if (!isPlainObject(source.billingPeriod)) {
    violations.push("billingPeriod is not a billing window or null");
    billingPeriod = undefined;
  } else {
    for (const key of Object.keys(source.billingPeriod)) {
      if (rejectUnsafeKey(key, violations)) {
        continue;
      }
      if (key !== "start" && key !== "end") {
        violations.push("unexpected key is not on allowlist");
      }
    }
    if (!("start" in source.billingPeriod) || !("end" in source.billingPeriod)) {
      violations.push("billingPeriod is missing a window bound");
    }
    const start = readMonthOrDate(source.billingPeriod.start, violations);
    const end = readMonthOrDate(source.billingPeriod.end, violations);
    if (start && end) {
      if (windowSortKey(start) > windowSortKey(end)) {
        violations.push("billingPeriod window is out of order");
      } else {
        billingPeriod = { start, end };
      }
    }
  }

  const amountsGBP: number[] = [];
  if (!Array.isArray(source.amountsGBP)) {
    violations.push("amountsGBP must be an array");
  } else if (
    source.amountsGBP.length > CLOSED_CLOUD_BRIEF_LIMITS.maxAmounts ||
    !assertArrayOwnProperties(source.amountsGBP, violations)
  ) {
    if (source.amountsGBP.length > CLOSED_CLOUD_BRIEF_LIMITS.maxAmounts) {
      violations.push("amountsGBP has too many entries");
    }
  } else {
    const seenAmounts = new Set<number>();
    for (const item of source.amountsGBP) {
      const amount = readAmount(item, violations);
      if (amount === undefined) {
        continue;
      }
      if (seenAmounts.has(amount)) {
        violations.push("amountsGBP duplicates an amount");
      }
      seenAmounts.add(amount);
      amountsGBP.push(amount);
    }
    amountsGBP.sort((left, right) => left - right);
  }

  const responseDeadlines: string[] = [];
  if (!Array.isArray(source.responseDeadlines)) {
    violations.push("responseDeadlines must be an array");
  } else if (
    source.responseDeadlines.length > CLOSED_CLOUD_BRIEF_LIMITS.maxDeadlines ||
    !assertArrayOwnProperties(source.responseDeadlines, violations)
  ) {
    if (source.responseDeadlines.length > CLOSED_CLOUD_BRIEF_LIMITS.maxDeadlines) {
      violations.push("responseDeadlines has too many entries");
    }
  } else {
    const seen = new Set<string>();
    for (const item of source.responseDeadlines) {
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
    responseDeadlines.sort();
  }

  const obligations: ClosedCloudObligation[] = [];
  if (!Array.isArray(source.obligations)) {
    violations.push("obligations must be an array");
  } else if (
    source.obligations.length > CLOSED_CLOUD_BRIEF_LIMITS.maxObligations ||
    !assertArrayOwnProperties(source.obligations, violations)
  ) {
    if (source.obligations.length > CLOSED_CLOUD_BRIEF_LIMITS.maxObligations) {
      violations.push("obligations has too many entries");
    }
  } else {
    const allowedObligation = new Set<string>(CLOSED_CLOUD_OBLIGATION_KEYS);
    for (const item of source.obligations) {
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
    const seenObligations = new Set<string>();
    for (const item of obligations) {
      const key = `${item.actionSummary}\u0000${item.dueDate ?? ""}`;
      if (seenObligations.has(key)) {
        violations.push("obligations duplicates an action");
      }
      seenObligations.add(key);
    }
    obligations.sort((left, right) => {
      if (left.actionSummary !== right.actionSummary) {
        return left.actionSummary < right.actionSummary ? -1 : 1;
      }
      if (left.dueDate === right.dueDate) {
        return 0;
      }
      if (left.dueDate === null) {
        return -1;
      }
      if (right.dueDate === null) {
        return 1;
      }
      return left.dueDate < right.dueDate ? -1 : 1;
    });
  }

  let responseGoal: ResponseGoal | undefined;
  if (
    typeof source.responseGoal !== "string" ||
    !(ALLOWED_RESPONSE_GOALS as readonly string[]).includes(source.responseGoal)
  ) {
    violations.push("responseGoal is not an allowed goal");
  } else {
    responseGoal = source.responseGoal as ResponseGoal;
  }

  const guidanceIds: GuidanceId[] = [];
  if (!Array.isArray(source.guidanceIds)) {
    violations.push("guidanceIds must be an array");
  } else if (
    source.guidanceIds.length > CLOSED_CLOUD_BRIEF_LIMITS.maxGuidanceIds ||
    !assertArrayOwnProperties(source.guidanceIds, violations)
  ) {
    if (source.guidanceIds.length > CLOSED_CLOUD_BRIEF_LIMITS.maxGuidanceIds) {
      violations.push("guidanceIds has too many entries");
    }
  } else {
    const allowedForCategory = noticeCategory
      ? new Set<string>(GUIDANCE_IDS_BY_CATEGORY[noticeCategory])
      : null;
    const seen = new Set<string>();
    for (const gid of source.guidanceIds) {
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
    guidanceIds.sort();
  }

  const hasFlags = Object.prototype.hasOwnProperty.call(source, "circumstanceFlags");
  let circumstanceFlags: CircumstanceFlag[] | undefined;
  if (hasFlags) {
    const flags = source.circumstanceFlags;
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
      collected.sort();
      circumstanceFlags = collected;
    }
  }

  if (
    violations.length > 0 ||
    !noticeCategory ||
    issueDate === undefined ||
    billingPeriod === undefined ||
    !responseGoal ||
    !Array.isArray(source.obligations) ||
    obligations.length !== source.obligations.length ||
    !Array.isArray(source.guidanceIds) ||
    guidanceIds.length !== source.guidanceIds.length
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
  if (!recheck) {
    const replayed = canonicalizeClosedCloudBrief(parsed, true);
    if (replayed.serialized !== serialized) {
      fail(["payload did not round-trip through JSON"]);
    }
    return replayed;
  }

  return {
    payload: deepFreeze(parsed as ClosedCloudBrief),
    serialized,
  };
}

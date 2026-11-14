import { hasAtMostTwoDecimalPlaces } from "./amounts";
import { parseCalendarDate } from "./dates";
import { hasPartialPlaceholderIdentifier } from "./placeholders";
import {
  containsAlphanumericAccountReference,
  hasLongNumericIdentifier,
  identifierLeaks,
  normalizeDashes,
} from "./textNormalize";
import { UNTRUSTED_DATA_BEGIN, UNTRUSTED_DATA_END } from "./untrustedFence";
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
  type CloudBoundRedactedObligation,
  type CloudBoundStructuralPayload,
  type GuidanceId,
  type NoticeCategory,
  type ResponseGoal,
} from "./types";

export const ALLOWED_CLOUD_ROOT_KEYS = [
  "schemaVersion",
  "noticeCategory",
  "issueDate",
  "billingPeriod",
  "amountsGBP",
  "responseDeadlines",
  "redactedObligations",
  "responseGoal",
  "guidanceIds",
] as const;

export const ALLOWED_CLOUD_OBLIGATION_KEYS = [
  "actionSummary",
  "dueDate",
  "redactedClause",
] as const;

export const OPTIONAL_CLOUD_ROOT_KEYS = ["circumstanceFlags"] as const;

export const CLOUD_PAYLOAD_LIMITS = {
  maxObligations: 6,
  maxAmounts: 6,
  maxDeadlines: 6,
  minRedactedClauseLength: 4,
  maxRedactedClauseLength: 220,
  maxGuidanceIds: 5,
  maxCircumstanceFlags: 8,
  maxAmountGBP: 1_000_000,
  maxTotalSerializedLength: 2_600,
} as const;

/**
 * Pattern checks can reject some obvious personal data.
 * They do not prove that a payload is free of personal information.
 */
export const CLOUD_PAYLOAD_REDACTION_LIMITATION =
  "Pattern checks do not guarantee that personal information was removed. A person must review the brief before any cloud request.";

const UK_POSTCODE_REGEX = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i;
const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE_REGEX = /(?:\+44\s?\d{3,4}|\(?0\d{3,4}\)?)\s?\d{3}\s?\d{3,4}\b(?![\s-]*\d)/;
const SALUTATION_NAME_REGEX =
  /\b(?:Dear|Mr|Mrs|Ms|Miss|Dr)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/;
const STREET_ADDRESS_REGEX =
  /\b\d{1,4}[A-Z]?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\s+(?:Road|Street|Lane|Avenue|Close|Drive|Way|Court|Place|Gardens|Crescent|Terrace)\b/;
const LABELED_ACCOUNT_REF_REGEX =
  /\b(?:Account|Tenancy|Customer|Council\s*Tax)\s*(?:reference|ref|number|no\.?)\s*[:#-]?\s*[A-Z0-9-]{3,}\b|\bRef(?:erence)?\s*[:#-]?\s*[A-Za-z]{2,12}-\d{3,12}\b/i;
const ALPHANUMERIC_REF_TOKEN_REGEX = /\b[A-Z]{2,12}-\d{3,12}\b/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH = /^(\d{4})-(\d{2})$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface CloudPayloadGuardOptions {
  rawNoticeText?: string;
  forbiddenIdentifiers?: string[];
}

/** One guard-option object for construction, inspection, approval, and a later send. */
export function cloudGuardOptionsFromPrivateIdentifiers(input: {
  rawNoticeText?: string;
  localRawValues?: readonly string[];
  extraKnownIdentifiers?: readonly string[];
}): CloudPayloadGuardOptions {
  const seen = new Set<string>();
  const forbiddenIdentifiers: string[] = [];
  for (const value of [...(input.localRawValues ?? []), ...(input.extraKnownIdentifiers ?? [])]) {
    const trimmed = value.trim();
    if (trimmed.length < 3 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    forbiddenIdentifiers.push(trimmed);
  }
  return {
    rawNoticeText: input.rawNoticeText,
    forbiddenIdentifiers,
  };
}

export interface CanonicalCloudPayload {
  payload: CloudBoundStructuralPayload;
  serialized: string;
}

export class CloudPayloadValidationError extends Error {
  public readonly violations: readonly string[];

  constructor(violations: string[]) {
    super(
      `Cloud-bound payload rejected (${violations.length} violation(s)): ${violations.join("; ")}`
    );
    this.name = "CloudPayloadValidationError";
    this.violations = Object.freeze([...violations]);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function stripInvisibles(value: string): string {
  return value.normalize("NFKC").replace(/\p{Cf}/gu, "");
}

function inspectStringForPiiOrLeakage(
  value: string,
  options: CloudPayloadGuardOptions | undefined,
  violations: string[]
): void {
  const visible = normalizeDashes(stripInvisibles(value));
  if (
    visible.includes(UNTRUSTED_DATA_BEGIN) ||
    visible.includes(UNTRUSTED_DATA_END)
  ) {
    violations.push("a text field contains a reserved delimiter");
  }
  if (UK_POSTCODE_REGEX.test(visible)) {
    violations.push("a text field contains a UK postcode pattern");
  }
  if (EMAIL_REGEX.test(visible)) {
    violations.push("a text field contains an email address pattern");
  }
  if (PHONE_REGEX.test(visible) || hasLongNumericIdentifier(visible)) {
    violations.push("a text field contains a telephone number pattern");
  }
  if (hasPartialPlaceholderIdentifier(visible)) {
    violations.push("a text field contains a partial identifier beside a placeholder");
  }
  if (SALUTATION_NAME_REGEX.test(visible)) {
    violations.push("a text field contains a personal salutation pattern");
  }
  if (STREET_ADDRESS_REGEX.test(visible)) {
    violations.push("a text field contains a street address pattern");
  }
  if (
    LABELED_ACCOUNT_REF_REGEX.test(visible) ||
    ALPHANUMERIC_REF_TOKEN_REGEX.test(visible) ||
    containsAlphanumericAccountReference(value)
  ) {
    violations.push("a text field contains an account reference pattern");
  }

  if (options?.forbiddenIdentifiers) {
    for (const rawId of options.forbiddenIdentifiers) {
      if (identifierLeaks(value, rawId)) {
        violations.push("a text field contains a forbidden local identifier");
        break;
      }
    }
  }

  if (options?.rawNoticeText) {
    const normalizedRaw = options.rawNoticeText.replace(/\s+/g, " ").trim();
    const normalizedVal = visible.replace(/\s+/g, " ").trim();
    if (
      normalizedRaw.length >= 80 &&
      normalizedVal.length >= Math.min(normalizedRaw.length, 240) &&
      normalizedRaw.includes(normalizedVal)
    ) {
      violations.push("a text field appears to embed raw notice text");
    }
  }
}

function rejectUnsafeKey(key: string, violations: string[]): boolean {
  if (FORBIDDEN_KEYS.has(key)) {
    violations.push("payload contains a forbidden key");
    return true;
  }
  return false;
}

function assertArrayOwnProperties(value: unknown[], violations: string[]): boolean {
  const proto = Object.getPrototypeOf(value);
  if (proto !== Array.prototype) {
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

function assertObjectOwnProperties(value: Record<string, unknown>, violations: string[]): boolean {
  for (const name of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor?.enumerable) {
      violations.push("payload has a non-enumerable property");
      return false;
    }
    rejectUnsafeKey(name, violations);
  }
  return !violations.some((item) => item === "payload contains a forbidden key" || item === "payload has a non-enumerable property");
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
    return parseCalendarDate(value) ? value : undefined;
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

function readAmount(value: unknown, violations: string[]): number | undefined {
  if (!noteNonJson(value, violations)) {
    return undefined;
  }
  if (typeof value !== "number" || Object.is(value, -0) || !Number.isFinite(value)) {
    violations.push("payload contains a non-finite JSON number");
    return undefined;
  }
  if (value < 0 || value > CLOUD_PAYLOAD_LIMITS.maxAmountGBP || !hasAtMostTwoDecimalPlaces(value)) {
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

/**
 * Builds a detached JSON snapshot and validates that snapshot.
 * The returned payload is frozen. `serialized` is the exact JSON that a send would use.
 * Violation text does not include caller keys, identifiers, or field values.
 */
export function canonicalCloudPayload(
  input: unknown,
  options?: CloudPayloadGuardOptions
): CanonicalCloudPayload {
  const violations: string[] = [];
  if (!isPlainObject(input)) {
    throw new CloudPayloadValidationError(["Payload root must be a plain JSON object"]);
  }
  assertObjectOwnProperties(input, violations);

  const allowedRoot = new Set<string>([
    ...ALLOWED_CLOUD_ROOT_KEYS,
    ...OPTIONAL_CLOUD_ROOT_KEYS,
  ]);
  for (const key of Object.keys(input)) {
    if (rejectUnsafeKey(key, violations)) {
      continue;
    }
    if (!allowedRoot.has(key)) {
      violations.push("unexpected key is not on allowlist");
    }
  }
  for (const requiredKey of ALLOWED_CLOUD_ROOT_KEYS) {
    if (!(requiredKey in input)) {
      violations.push("missing required allowlisted field");
    }
  }

  const schemaVersion = input.schemaVersion;
  const noticeCategoryValue = input.noticeCategory;
  const issueDateValue = input.issueDate;
  const billingPeriodValue = input.billingPeriod;
  const amountsValue = input.amountsGBP;
  const deadlinesValue = input.responseDeadlines;
  const obligationsValue = input.redactedObligations;
  const responseGoalValue = input.responseGoal;
  const guidanceValue = input.guidanceIds;
  const hasCircumstanceFlags = Object.prototype.hasOwnProperty.call(input, "circumstanceFlags");
  const flagsValue = hasCircumstanceFlags ? input.circumstanceFlags : undefined;
  if (hasCircumstanceFlags && flagsValue === undefined) {
    violations.push("payload contains a value that is not a JSON value");
  }

  if (schemaVersion !== "noticelens.cloud-brief.v1") {
    violations.push("schemaVersion is not the supported cloud brief schema");
  }

  let noticeCategory: NoticeCategory | undefined;
  if (
    typeof noticeCategoryValue !== "string" ||
    !(ALLOWED_NOTICE_CATEGORIES as readonly string[]).includes(noticeCategoryValue)
  ) {
    violations.push("noticeCategory is not an allowed category");
  } else {
    noticeCategory = noticeCategoryValue as NoticeCategory;
  }

  const issueDate = readIsoDate(issueDateValue, violations);

  let billingPeriod: CloudBillingWindow | null | undefined;
  if (billingPeriodValue === null) {
    billingPeriod = null;
  } else if (!isPlainObject(billingPeriodValue)) {
    violations.push("billingPeriod is not a billing window or null");
    billingPeriod = undefined;
  } else {
    assertObjectOwnProperties(billingPeriodValue, violations);
    for (const key of Object.keys(billingPeriodValue)) {
      if (key !== "start" && key !== "end") {
        violations.push("unexpected key is not on allowlist");
      }
    }
    if (!("start" in billingPeriodValue) || !("end" in billingPeriodValue)) {
      violations.push("billingPeriod is missing a window bound");
    }
    const start = readMonthOrDate(billingPeriodValue.start, violations);
    const end = readMonthOrDate(billingPeriodValue.end, violations);
    if (start && end) {
      if (windowSortKey(start) > windowSortKey(end)) {
        violations.push("billingPeriod window is out of order");
      } else {
        billingPeriod = { start, end };
      }
    }
  }

  const amountsGBP: number[] = [];
  if (!Array.isArray(amountsValue)) {
    violations.push("amountsGBP must be an array");
  } else if (
    amountsValue.length > CLOUD_PAYLOAD_LIMITS.maxAmounts ||
    !assertArrayOwnProperties(amountsValue, violations)
  ) {
    if (amountsValue.length > CLOUD_PAYLOAD_LIMITS.maxAmounts) {
      violations.push("amountsGBP has too many entries");
    }
  } else {
    for (const item of amountsValue) {
      const amount = readAmount(item, violations);
      if (amount !== undefined) {
        amountsGBP.push(amount);
      }
    }
  }

  const responseDeadlines: string[] = [];
  if (!Array.isArray(deadlinesValue)) {
    violations.push("responseDeadlines must be an array");
  } else if (
    deadlinesValue.length > CLOUD_PAYLOAD_LIMITS.maxDeadlines ||
    !assertArrayOwnProperties(deadlinesValue, violations)
  ) {
    if (deadlinesValue.length > CLOUD_PAYLOAD_LIMITS.maxDeadlines) {
      violations.push("responseDeadlines has too many entries");
    }
  } else {
    const seen = new Set<string>();
    for (const item of deadlinesValue) {
      const iso = readIsoDate(item, violations);
      if (iso === undefined || iso === null) {
        if (iso === null) {
          violations.push("a date field must be an ISO calendar date or null");
        }
        continue;
      }
      if (seen.has(iso)) {
        violations.push("responseDeadlines duplicates a date");
      }
      seen.add(iso);
      responseDeadlines.push(iso);
    }
  }

  let responseGoal: ResponseGoal | undefined;
  if (
    typeof responseGoalValue !== "string" ||
    !(ALLOWED_RESPONSE_GOALS as readonly string[]).includes(responseGoalValue)
  ) {
    violations.push("responseGoal is not an allowed goal");
  } else {
    responseGoal = responseGoalValue as ResponseGoal;
  }

  const guidanceIds: GuidanceId[] = [];
  if (!Array.isArray(guidanceValue)) {
    violations.push("guidanceIds must be an array");
  } else if (
    guidanceValue.length > CLOUD_PAYLOAD_LIMITS.maxGuidanceIds ||
    !assertArrayOwnProperties(guidanceValue, violations)
  ) {
    if (guidanceValue.length > CLOUD_PAYLOAD_LIMITS.maxGuidanceIds) {
      violations.push("guidanceIds has too many entries");
    }
  } else {
    const allowedForCategory = noticeCategory
      ? new Set<string>(GUIDANCE_IDS_BY_CATEGORY[noticeCategory])
      : null;
    const seen = new Set<string>();
    for (const gid of guidanceValue) {
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

  const redactedObligations: CloudBoundRedactedObligation[] = [];
  if (
    !Array.isArray(obligationsValue) ||
    obligationsValue.length < 1 ||
    obligationsValue.length > CLOUD_PAYLOAD_LIMITS.maxObligations
  ) {
    violations.push("redactedObligations must be a bounded array");
  } else if (assertArrayOwnProperties(obligationsValue, violations)) {
    for (const item of obligationsValue) {
      if (!isPlainObject(item)) {
        violations.push("an obligation must be a plain object");
        continue;
      }
      assertObjectOwnProperties(item, violations);
      const allowedObligation = new Set<string>(ALLOWED_CLOUD_OBLIGATION_KEYS);
      for (const key of Object.keys(item)) {
        if (!allowedObligation.has(key)) {
          violations.push("unexpected key is not on allowlist");
        }
      }
      for (const requiredKey of ALLOWED_CLOUD_OBLIGATION_KEYS) {
        if (!(requiredKey in item)) {
          violations.push("an obligation is missing a required field");
        }
      }
      const actionValue = item.actionSummary;
      const dueValue = item.dueDate;
      const clauseValue = item.redactedClause;
      if (
        !noteNonJson(actionValue, violations) ||
        !noteNonJson(dueValue, violations) ||
        !noteNonJson(clauseValue, violations)
      ) {
        continue;
      }
      let actionSummary: ActionSummaryId | undefined;
      if (
        typeof actionValue !== "string" ||
        !(ALLOWED_ACTION_SUMMARIES as readonly string[]).includes(actionValue)
      ) {
        violations.push("actionSummary is not an allowed action id");
      } else {
        actionSummary = actionValue as ActionSummaryId;
      }
      const dueDate = readIsoDate(dueValue, violations);
      let redactedClause: string | undefined;
      if (
        typeof clauseValue !== "string" ||
        clauseValue.trim().length < CLOUD_PAYLOAD_LIMITS.minRedactedClauseLength ||
        clauseValue.length > CLOUD_PAYLOAD_LIMITS.maxRedactedClauseLength
      ) {
        violations.push("redactedClause length is outside bounds");
      } else {
        inspectStringForPiiOrLeakage(clauseValue, options, violations);
        redactedClause = clauseValue;
      }
      if (actionSummary && dueDate !== undefined && redactedClause) {
        redactedObligations.push({ actionSummary, dueDate, redactedClause });
      }
    }
  }

  let circumstanceFlags: CircumstanceFlag[] | undefined;
  if (flagsValue !== undefined) {
    const flags = flagsValue;
    if (!Array.isArray(flags) || flags.length > CLOUD_PAYLOAD_LIMITS.maxCircumstanceFlags) {
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
      if (collected.length > 0) {
        circumstanceFlags = collected;
      }
    }
  }

  if (
    violations.length > 0 ||
    !noticeCategory ||
    issueDate === undefined ||
    billingPeriod === undefined ||
    !responseGoal ||
    redactedObligations.length !== (Array.isArray(obligationsValue) ? obligationsValue.length : -1)
  ) {
    throw new CloudPayloadValidationError(
      violations.length > 0 ? violations : ["Cloud-bound payload did not match the allowlist"]
    );
  }

  const canonical: CloudBoundStructuralPayload = {
    schemaVersion: "noticelens.cloud-brief.v1",
    noticeCategory,
    issueDate,
    billingPeriod,
    amountsGBP,
    responseDeadlines,
    redactedObligations,
    responseGoal,
    guidanceIds,
  };
  if (circumstanceFlags) {
    canonical.circumstanceFlags = circumstanceFlags;
  }

  const serialized = JSON.stringify(canonical);
  if (serialized.length > CLOUD_PAYLOAD_LIMITS.maxTotalSerializedLength) {
    throw new CloudPayloadValidationError(["serialized payload exceeds the length cap"]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new CloudPayloadValidationError(["payload did not round-trip through JSON"]);
  }
  if (JSON.stringify(parsed) !== serialized) {
    throw new CloudPayloadValidationError(["payload did not round-trip through JSON"]);
  }

  return {
    payload: deepFreeze(parsed as CloudBoundStructuralPayload),
    serialized,
  };
}

export function validateCloudBoundPayload(
  input: unknown,
  options?: CloudPayloadGuardOptions
): CloudBoundStructuralPayload {
  return canonicalCloudPayload(input, options).payload;
}

/**
 * Re-checks the payload the user is about to send.
 * The result is a frozen snapshot, not the object the caller still holds.
 */
export function revalidateFinalCloudPayload(
  editedPayload: unknown,
  options?: CloudPayloadGuardOptions
): CloudBoundStructuralPayload {
  return canonicalCloudPayload(editedPayload, options).payload;
}

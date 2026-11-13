import {
  ALLOWED_GUIDANCE_IDS,
  ALLOWED_NOTICE_CATEGORIES,
  ALLOWED_RESPONSE_GOALS,
  type CloudBoundStructuralPayload,
} from "./types";

export const ALLOWED_CLOUD_ROOT_KEYS = [
  "schemaVersion",
  "noticeCategory",
  "issueDate",
  "billingPeriod",
  "amountGBP",
  "responseDeadline",
  "redactedObligations",
  "responseGoal",
  "guidanceIds",
] as const;

export const ALLOWED_CLOUD_OBLIGATION_KEYS = [
  "actionSummary",
  "dueDate",
  "redactedClause",
] as const;

export const CLOUD_PAYLOAD_LIMITS = {
  maxDateLength: 40,
  maxBillingPeriodLength: 80,
  maxAmountGBP: 1_000_000,
  maxObligations: 6,
  maxActionSummaryLength: 160,
  minRedactedClauseLength: 4,
  maxRedactedClauseLength: 220,
  maxGuidanceIds: 5,
  maxTotalSerializedLength: 2_600,
} as const;

const UK_POSTCODE_REGEX = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i;
const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE_REGEX = /(?:\+44\s?\d{3,4}|\(?0\d{3,4}\)?)\s?\d{3}\s?\d{3,4}\b/;
const SALUTATION_NAME_REGEX =
  /\b(?:Dear|Mr|Mrs|Ms|Miss|Dr)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/;
const STREET_ADDRESS_REGEX =
  /\b\d{1,4}[A-Z]?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\s+(?:Road|Street|Lane|Avenue|Close|Drive|Way|Court|Place|Gardens|Crescent|Terrace)\b/;
const LABELED_ACCOUNT_REF_REGEX =
  /\b(?:Account|Tenancy|Customer|Council\s*Tax)\s*(?:reference|ref|number|no\.?)\s*[:#-]?\s*[A-Z0-9-]{3,}\b/i;
const ALPHANUMERIC_REF_TOKEN_REGEX = /\b[A-Z]{2,12}-\d{3,12}\b/;

export interface CloudPayloadGuardOptions {
  rawNoticeText?: string;
  forbiddenIdentifiers?: string[];
}

export class CloudPayloadValidationError extends Error {
  public readonly violations: string[];

  constructor(violations: string[]) {
    super(
      `Cloud-bound payload rejected by strict allowlist guard (${violations.length} violation(s)): ${violations.join("; ")}`
    );
    this.name = "CloudPayloadValidationError";
    this.violations = violations;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function inspectStringForPiiOrLeakage(
  fieldPath: string,
  value: string,
  options: CloudPayloadGuardOptions | undefined,
  violations: string[]
): void {
  if (UK_POSTCODE_REGEX.test(value)) {
    violations.push(`${fieldPath} contains a UK postcode pattern`);
  }
  if (EMAIL_REGEX.test(value)) {
    violations.push(`${fieldPath} contains an email address pattern`);
  }
  if (PHONE_REGEX.test(value)) {
    violations.push(`${fieldPath} contains a telephone number pattern`);
  }
  if (SALUTATION_NAME_REGEX.test(value)) {
    violations.push(`${fieldPath} contains a personal salutation/name pattern`);
  }
  if (STREET_ADDRESS_REGEX.test(value)) {
    violations.push(`${fieldPath} contains a street address pattern`);
  }
  if (
    LABELED_ACCOUNT_REF_REGEX.test(value) ||
    ALPHANUMERIC_REF_TOKEN_REGEX.test(value)
  ) {
    violations.push(`${fieldPath} contains an unredacted account/reference token`);
  }

  if (options?.forbiddenIdentifiers) {
    const lowerVal = value.toLowerCase();
    for (const rawId of options.forbiddenIdentifiers) {
      const cleanId = rawId.trim();
      if (cleanId.length >= 3 && lowerVal.includes(cleanId.toLowerCase())) {
        violations.push(
          `${fieldPath} contains forbidden local identifier (${cleanId.slice(0, 2)}***)`
        );
      }
    }
  }

  if (options?.rawNoticeText) {
    const normalizedRaw = options.rawNoticeText.replace(/\s+/g, " ").trim();
    const normalizedVal = value.replace(/\s+/g, " ").trim();
    if (
      normalizedRaw.length >= 80 &&
      normalizedVal.length >= Math.min(normalizedRaw.length, 240) &&
      normalizedRaw.includes(normalizedVal)
    ) {
      violations.push(
        `${fieldPath} appears to embed raw multi-paragraph notice text`
      );
    }
  }
}

export function validateCloudBoundPayload(
  input: unknown,
  options?: CloudPayloadGuardOptions
): CloudBoundStructuralPayload {
  const violations: string[] = [];

  if (!isPlainObject(input)) {
    throw new CloudPayloadValidationError([
      "Payload root must be a plain JSON object",
    ]);
  }

  const allowedRootSet = new Set<string>(ALLOWED_CLOUD_ROOT_KEYS);
  for (const key of Object.keys(input)) {
    if (!allowedRootSet.has(key)) {
      violations.push(`Unexpected root key "${key}" is not on the allowlist`);
    }
  }
  for (const requiredKey of ALLOWED_CLOUD_ROOT_KEYS) {
    if (!(requiredKey in input)) {
      violations.push(`Missing required allowlisted root key "${requiredKey}"`);
    }
  }

  if (input.schemaVersion !== "noticelens.cloud-brief.v1") {
    violations.push(
      'schemaVersion must equal "noticelens.cloud-brief.v1"'
    );
  }

  if (
    typeof input.noticeCategory !== "string" ||
    !(ALLOWED_NOTICE_CATEGORIES as readonly string[]).includes(
      input.noticeCategory
    )
  ) {
    violations.push("noticeCategory is not an allowed NoticeCategory enum");
  }

  if (
    typeof input.issueDate !== "string" ||
    input.issueDate.trim().length < 1 ||
    input.issueDate.length > CLOUD_PAYLOAD_LIMITS.maxDateLength
  ) {
    violations.push(
      `issueDate must be a non-empty string <= ${CLOUD_PAYLOAD_LIMITS.maxDateLength} chars`
    );
  } else {
    inspectStringForPiiOrLeakage("issueDate", input.issueDate, options, violations);
  }

  if (
    typeof input.billingPeriod !== "string" ||
    input.billingPeriod.trim().length < 1 ||
    input.billingPeriod.length > CLOUD_PAYLOAD_LIMITS.maxBillingPeriodLength
  ) {
    violations.push(
      `billingPeriod must be a non-empty string <= ${CLOUD_PAYLOAD_LIMITS.maxBillingPeriodLength} chars`
    );
  } else {
    inspectStringForPiiOrLeakage(
      "billingPeriod",
      input.billingPeriod,
      options,
      violations
    );
  }

  if (
    typeof input.amountGBP !== "number" ||
    !Number.isFinite(input.amountGBP) ||
    input.amountGBP < 0 ||
    input.amountGBP > CLOUD_PAYLOAD_LIMITS.maxAmountGBP
  ) {
    violations.push(
      `amountGBP must be a finite number between 0 and ${CLOUD_PAYLOAD_LIMITS.maxAmountGBP}`
    );
  }

  if (
    typeof input.responseDeadline !== "string" ||
    input.responseDeadline.trim().length < 1 ||
    input.responseDeadline.length > CLOUD_PAYLOAD_LIMITS.maxDateLength
  ) {
    violations.push(
      `responseDeadline must be a non-empty string <= ${CLOUD_PAYLOAD_LIMITS.maxDateLength} chars`
    );
  } else {
    inspectStringForPiiOrLeakage(
      "responseDeadline",
      input.responseDeadline,
      options,
      violations
    );
  }

  if (
    typeof input.responseGoal !== "string" ||
    !(ALLOWED_RESPONSE_GOALS as readonly string[]).includes(input.responseGoal)
  ) {
    violations.push("responseGoal is not an allowed ResponseGoal enum");
  }

  if (
    !Array.isArray(input.guidanceIds) ||
    input.guidanceIds.length < 1 ||
    input.guidanceIds.length > CLOUD_PAYLOAD_LIMITS.maxGuidanceIds
  ) {
    violations.push(
      `guidanceIds must be an array of 1..${CLOUD_PAYLOAD_LIMITS.maxGuidanceIds} items`
    );
  } else {
    input.guidanceIds.forEach((gid, idx) => {
      if (
        typeof gid !== "string" ||
        !(ALLOWED_GUIDANCE_IDS as readonly string[]).includes(gid)
      ) {
        violations.push(`guidanceIds[${idx}] is not an allowed GuidanceId`);
      }
    });
  }

  const allowedObligationKeySet = new Set<string>(ALLOWED_CLOUD_OBLIGATION_KEYS);
  if (
    !Array.isArray(input.redactedObligations) ||
    input.redactedObligations.length < 1 ||
    input.redactedObligations.length > CLOUD_PAYLOAD_LIMITS.maxObligations
  ) {
    violations.push(
      `redactedObligations must be an array of 1..${CLOUD_PAYLOAD_LIMITS.maxObligations} items`
    );
  } else {
    input.redactedObligations.forEach((item, idx) => {
      const pathPrefix = `redactedObligations[${idx}]`;
      if (!isPlainObject(item)) {
        violations.push(`${pathPrefix} must be a plain object`);
        return;
      }
      for (const k of Object.keys(item)) {
        if (!allowedObligationKeySet.has(k)) {
          violations.push(
            `${pathPrefix} contains unexpected key "${k}" not on allowlist`
          );
        }
      }
      for (const reqKey of ALLOWED_CLOUD_OBLIGATION_KEYS) {
        if (!(reqKey in item)) {
          violations.push(`${pathPrefix} is missing required key "${reqKey}"`);
        }
      }

      if (
        typeof item.actionSummary !== "string" ||
        item.actionSummary.trim().length < 1 ||
        item.actionSummary.length > CLOUD_PAYLOAD_LIMITS.maxActionSummaryLength
      ) {
        violations.push(
          `${pathPrefix}.actionSummary must be 1..${CLOUD_PAYLOAD_LIMITS.maxActionSummaryLength} chars`
        );
      } else {
        inspectStringForPiiOrLeakage(
          `${pathPrefix}.actionSummary`,
          item.actionSummary,
          options,
          violations
        );
      }

      if (item.dueDate !== null) {
        if (
          typeof item.dueDate !== "string" ||
          item.dueDate.trim().length < 1 ||
          item.dueDate.length > CLOUD_PAYLOAD_LIMITS.maxDateLength
        ) {
          violations.push(
            `${pathPrefix}.dueDate must be null or 1..${CLOUD_PAYLOAD_LIMITS.maxDateLength} chars`
          );
        } else {
          inspectStringForPiiOrLeakage(
            `${pathPrefix}.dueDate`,
            item.dueDate,
            options,
            violations
          );
        }
      }

      if (
        typeof item.redactedClause !== "string" ||
        item.redactedClause.trim().length <
          CLOUD_PAYLOAD_LIMITS.minRedactedClauseLength ||
        item.redactedClause.length >
          CLOUD_PAYLOAD_LIMITS.maxRedactedClauseLength
      ) {
        violations.push(
          `${pathPrefix}.redactedClause must be ${CLOUD_PAYLOAD_LIMITS.minRedactedClauseLength}..${CLOUD_PAYLOAD_LIMITS.maxRedactedClauseLength} chars`
        );
      } else {
        inspectStringForPiiOrLeakage(
          `${pathPrefix}.redactedClause`,
          item.redactedClause,
          options,
          violations
        );
      }
    });
  }

  const serialized = JSON.stringify(input);
  if (serialized.length > CLOUD_PAYLOAD_LIMITS.maxTotalSerializedLength) {
    violations.push(
      `Serialized payload length (${serialized.length}) exceeds cap (${CLOUD_PAYLOAD_LIMITS.maxTotalSerializedLength})`
    );
  }

  if (violations.length > 0) {
    throw new CloudPayloadValidationError(violations);
  }

  return input as unknown as CloudBoundStructuralPayload;
}

import { isCanonicalPlaceholder, listPlaceholderTokens } from "./placeholders";
import {
  ALLOWED_GUIDANCE_IDS,
  GUIDANCE_IDS_BY_CATEGORY,
  type CloudDraftOutput,
  type NoticeCategory,
} from "./types";

/**
 * Facts the output may rely on. Both the historical v1 brief and the closed
 * v2 brief satisfy this shape. The check does not rebuild a payload.
 */
export interface ApprovedCloudDraftFacts {
  noticeCategory: NoticeCategory;
  guidanceIds: readonly string[];
  amountsGBP: readonly number[];
  issueDate: string | null;
  billingPeriod: { start: string; end: string } | null;
  responseDeadlines: readonly string[];
  redactedObligations?: readonly { dueDate: string | null }[];
  obligations?: readonly { dueDate: string | null }[];
}

export class CloudOutputValidationError extends Error {
  public readonly violations: readonly string[];

  constructor(violations: string[]) {
    super(
      `Cloud output rejected (${violations.length} violation(s)): ${violations.join("; ")}`
    );
    this.name = "CloudOutputValidationError";
    this.violations = Object.freeze([...violations]);
  }
}

const OUTPUT_KEYS = [
  "summaryPlainEnglish",
  "options",
  "replyTemplateWithPlaceholders",
  "citedGuidanceIds",
] as const;

const OPTION_KEYS = ["title", "rationale", "applicableCondition"] as const;

const DEFINITIVE_LEGAL_CONCLUSION =
  /\b(legally invalid|unenforceable|this bill is invalid|this notice is invalid|charge is unlawful|you are not liable|notice is void)\b/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasUnsupportedLegalConclusion(text: string): boolean {
  if (DEFINITIVE_LEGAL_CONCLUSION.test(text)) {
    return true;
  }
  if (/\byou do not have to pay\b/i.test(text) && !/\bif\b/i.test(text) && !/\bmay\b/i.test(text)) {
    return true;
  }
  return false;
}

function boundedString(
  value: unknown,
  max: number,
  label: string,
  violations: string[]
): string | null {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    violations.push(`${label} is not a bounded string`);
    return null;
  }
  if (hasUnsupportedLegalConclusion(value)) {
    violations.push(`${label} states an unsupported legal conclusion`);
  }
  return value;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

function approvedDateSet(approved: ApprovedCloudDraftFacts): Set<string> {
  const dates = new Set<string>();
  const add = (value: string | null | undefined) => {
    if (typeof value === "string" && value.length > 0) {
      dates.add(value);
    }
  };
  add(approved.issueDate);
  add(approved.billingPeriod?.start);
  add(approved.billingPeriod?.end);
  for (const date of approved.responseDeadlines) {
    add(date);
  }
  for (const item of approved.redactedObligations ?? []) {
    add(item.dueDate);
  }
  for (const item of approved.obligations ?? []) {
    add(item.dueDate);
  }
  return dates;
}

function sameMoney(left: number, right: number): boolean {
  return Math.round(left * 100) === Math.round(right * 100);
}

function parseMoneyToken(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) {
    return null;
  }
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function isoFromParts(day: string, monthName: string, year: string): string | null {
  const month = MONTHS.indexOf(monthName.toLowerCase() as (typeof MONTHS)[number]);
  const dayNumber = Number(day);
  const yearNumber = Number(year);
  if (month < 0 || dayNumber < 1 || dayNumber > 31 || yearNumber < 1900 || yearNumber > 2100) {
    return null;
  }
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(dayNumber).padStart(2, "0")}`;
}

/**
 * Rejects draft text that adds an amount, a date, a personal-identifier shape,
 * or an Ofgem claim the approved brief does not carry.
 * Unusual names that do not match these shapes can still pass. That does not close R5-2.
 */
export function draftConsistencyViolations(
  texts: readonly string[],
  approved: ApprovedCloudDraftFacts
): string[] {
  const violations: string[] = [];
  const dates = approvedDateSet(approved);
  const monthNames = MONTHS.join("|");
  let inventedAmount = false;
  let inventedDate = false;
  let identifier = false;
  let ofgem = false;
  const ofgemApproved = approved.guidanceIds.includes("ofgem-backbilling-12m-v1");

  for (const text of texts) {
    const stripped = text.replace(/\[[A-Z0-9_]+\]/g, " ");
    const dayMonth = new RegExp(`\\b(\\d{1,2}) (${monthNames}) (\\d{4})\\b`, "gi");
    const monthDay = new RegExp(`\\b(${monthNames}) (\\d{1,2}), (\\d{4})\\b`, "gi");
    const money = /(?:£|GBP)\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?/gi;
    const pounds = /\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?\s+pounds?\b/gi;
    for (const match of stripped.matchAll(money)) {
      const value = parseMoneyToken(match[1] ?? "");
      if (value === null || !approved.amountsGBP.some((amount) => sameMoney(amount, value))) {
        inventedAmount = true;
      }
    }
    for (const match of stripped.matchAll(pounds)) {
      const value = parseMoneyToken(match[1] ?? "");
      if (value === null || !approved.amountsGBP.some((amount) => sameMoney(amount, value))) {
        inventedAmount = true;
      }
    }
    for (const match of stripped.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) {
      if (!dates.has(match[1] ?? "")) {
        inventedDate = true;
      }
    }
    for (const match of stripped.matchAll(dayMonth)) {
      const iso = isoFromParts(match[1] ?? "", match[2] ?? "", match[3] ?? "");
      if (iso === null || !dates.has(iso)) {
        inventedDate = true;
      }
    }
    for (const match of stripped.matchAll(monthDay)) {
      const iso = isoFromParts(match[2] ?? "", match[1] ?? "", match[3] ?? "");
      if (iso === null || !dates.has(iso)) {
        inventedDate = true;
      }
    }
    if (
      /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/.test(stripped) ||
      /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i.test(stripped) ||
      /\b(?:\+44\d{10}|0\d{10,11})\b/.test(stripped) ||
      /\b[A-Z]{2,}[-/]\d{3,}\b/.test(stripped) ||
      /\bDear\s+[A-Z][a-z]{2,}\b/.test(stripped) ||
      /\b\d{6,}\b/.test(stripped)
    ) {
      identifier = true;
    }
    if (/\bofgem\b/i.test(stripped) && !ofgemApproved) {
      ofgem = true;
    }
  }

  if (inventedAmount) {
    violations.push("draft mentions an amount that is not on the approved brief");
  }
  if (inventedDate) {
    violations.push("draft mentions a date that is not on the approved brief");
  }
  if (identifier) {
    violations.push("draft mentions a personal identifier");
  }
  if (ofgem) {
    violations.push("draft cites Ofgem without approved guidance");
  }
  return violations;
}

/**
 * Accepts model JSON only when its guidance ids were on the approved brief
 * and its placeholders belong to the canonical set.
 * Amounts, dates, identifier shapes, and Ofgem claims must also fit that brief.
 * The returned object is a detached copy. Errors do not include model text.
 */
export function validateCloudDraftOutput(
  input: unknown,
  approved: ApprovedCloudDraftFacts
): CloudDraftOutput {
  const violations: string[] = [];
  if (!isPlainObject(input)) {
    throw new CloudOutputValidationError(["Cloud output was not a JSON object"]);
  }
  for (const key of Object.keys(input)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      violations.push("Cloud output contains a forbidden key");
      continue;
    }
    if (!(OUTPUT_KEYS as readonly string[]).includes(key)) {
      violations.push("Cloud output contains an unexpected key");
    }
  }
  for (const key of OUTPUT_KEYS) {
    if (!(key in input)) {
      violations.push("Cloud output is missing a required field");
    }
  }

  const summary = boundedString(input.summaryPlainEnglish, 1200, "summary", violations);
  const template = boundedString(
    input.replyTemplateWithPlaceholders,
    4000,
    "reply template",
    violations
  );
  const rejectUnexpectedPlaceholders = (text: string, label: string) => {
    for (const token of listPlaceholderTokens(text)) {
      if (!isCanonicalPlaceholder(token)) {
        violations.push(
          label === "reply template"
            ? "reply template contains a placeholder outside the canonical set"
            : `${label} contains an unexpected placeholder`
        );
        return;
      }
    }
  };
  if (summary) {
    rejectUnexpectedPlaceholders(summary, "summary");
  }
  if (template) {
    rejectUnexpectedPlaceholders(template, "reply template");
  }

  const options: CloudDraftOutput["options"] = [];
  if (!Array.isArray(input.options) || input.options.length < 1 || input.options.length > 6) {
    violations.push("options are not a bounded list");
  } else {
    for (const item of input.options) {
      if (!isPlainObject(item)) {
        violations.push("an option is not an object");
        continue;
      }
      for (const key of Object.keys(item)) {
        if (!(OPTION_KEYS as readonly string[]).includes(key)) {
          violations.push("an option contains an unexpected key");
        }
      }
      const title = boundedString(item.title, 160, "option title", violations);
      const rationale = boundedString(item.rationale, 800, "option rationale", violations);
      const applicableCondition = boundedString(
        item.applicableCondition,
        400,
        "option condition",
        violations
      );
      if (title && rationale && applicableCondition) {
        rejectUnexpectedPlaceholders(title, "option title");
        rejectUnexpectedPlaceholders(rationale, "option rationale");
        rejectUnexpectedPlaceholders(applicableCondition, "option condition");
        options.push({ title, rationale, applicableCondition });
      }
    }
  }

  const allowedForCategory = new Set<string>(GUIDANCE_IDS_BY_CATEGORY[approved.noticeCategory]);
  const approvedIds = new Set<string>(approved.guidanceIds);
  const citedGuidanceIds: string[] = [];
  if (!Array.isArray(input.citedGuidanceIds) || input.citedGuidanceIds.length > 5) {
    violations.push("cited guidance ids are not a bounded list");
  } else {
    for (const id of input.citedGuidanceIds) {
      if (typeof id !== "string" || !(ALLOWED_GUIDANCE_IDS as readonly string[]).includes(id)) {
        violations.push("a cited guidance id is not allowed");
        continue;
      }
      if (!approvedIds.has(id) || !allowedForCategory.has(id)) {
        violations.push("a cited guidance id was not on the approved brief for this notice category");
        continue;
      }
      if (!citedGuidanceIds.includes(id)) {
        citedGuidanceIds.push(id);
      }
    }
  }

  const draftTexts: string[] = [];
  if (typeof input.summaryPlainEnglish === "string") {
    draftTexts.push(input.summaryPlainEnglish);
  }
  if (typeof input.replyTemplateWithPlaceholders === "string") {
    draftTexts.push(input.replyTemplateWithPlaceholders);
  }
  if (Array.isArray(input.options)) {
    for (const item of input.options) {
      if (!isPlainObject(item)) {
        continue;
      }
      for (const key of OPTION_KEYS) {
        if (typeof item[key] === "string") {
          draftTexts.push(item[key]);
        }
      }
    }
  }
  violations.push(...draftConsistencyViolations(draftTexts, approved));

  if (violations.length > 0 || !summary || !template) {
    throw new CloudOutputValidationError(
      violations.length > 0 ? violations : ["Cloud output was incomplete"]
    );
  }

  return {
    summaryPlainEnglish: summary,
    options,
    replyTemplateWithPlaceholders: template,
    citedGuidanceIds,
  };
}

import { isCanonicalPlaceholder, listPlaceholderTokens } from "./placeholders";
import {
  ALLOWED_GUIDANCE_IDS,
  GUIDANCE_IDS_BY_CATEGORY,
  type CloudBoundStructuralPayload,
  type CloudDraftOutput,
} from "./types";

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

/**
 * Accepts model JSON only when its guidance ids were on the approved brief
 * and its placeholders belong to the canonical set.
 * The returned object is a detached copy. Errors do not include model text.
 */
export function validateCloudDraftOutput(
  input: unknown,
  approved: CloudBoundStructuralPayload
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

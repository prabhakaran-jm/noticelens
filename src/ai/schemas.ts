import { Schema } from "firebase/ai";
import { ALLOWED_NOTICE_CATEGORIES } from "../domain/types";

export const NOTICE_EXTRACTION_SCHEMA = Schema.object({
  properties: {
    noticeCategory: Schema.enumString({
      enum: [...ALLOWED_NOTICE_CATEGORIES],
    }),
    issueDate: Schema.string(),
    billingPeriod: Schema.string(),
    amountGBP: Schema.number(),
    responseDeadline: Schema.string(),
    obligations: Schema.array({
      items: Schema.object({
        properties: {
          action: Schema.string(),
          dueDate: Schema.string(),
          sourceQuote: Schema.string(),
        },
        optionalProperties: ["dueDate"],
      }),
    }),
  },
});

export const CLOUD_DRAFT_SCHEMA = Schema.object({
  properties: {
    summaryPlainEnglish: Schema.string(),
    options: Schema.array({
      items: Schema.object({
        properties: {
          title: Schema.string(),
          rationale: Schema.string(),
          applicableCondition: Schema.string(),
        },
      }),
    }),
    replyTemplateWithPlaceholders: Schema.string(),
    citedGuidanceIds: Schema.array({
      items: Schema.string(),
    }),
  },
});

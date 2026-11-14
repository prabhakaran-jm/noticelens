import { GUIDANCE_IDS_BY_CATEGORY, type GuidanceId, type NoticeCategory } from "./types";

export interface NoticeCategoryDecision {
  noticeCategory: NoticeCategory;
  guidanceIds: readonly GuidanceId[];
  /** True when the text does not support one category, including a model label with no evidence. */
  needsConfirmation: boolean;
  /** True when a model label was present and was not used as the category. */
  modelIgnored: boolean;
}

function evidenceCategories(text: string): NoticeCategory[] {
  const found: NoticeCategory[] = [];
  if (/\bcouncil tax\b/i.test(text)) {
    found.push("council_tax");
  }
  if (/\belectricity\b/i.test(text)) {
    found.push("utility_electricity");
  }
  if (/\bgas\b/i.test(text)) {
    found.push("utility_gas");
  }
  if (/\bservice charge\b/i.test(text)) {
    found.push("housing_service_charge");
  }
  return found;
}

function general(modelIgnored: boolean, needsConfirmation: boolean): NoticeCategoryDecision {
  return {
    noticeCategory: "other_household_notice",
    guidanceIds: [],
    needsConfirmation,
    modelIgnored,
  };
}

/**
 * The notice text decides the category. A model label is not enough, and it
 * cannot select Ofgem guidance for a council-tax notice.
 */
export function decideNoticeCategory(
  text: string,
  modelCategory?: NoticeCategory | null
): NoticeCategoryDecision {
  const evidence = evidenceCategories(text);
  const modelIgnored = Boolean(modelCategory && modelCategory !== "other_household_notice");
  if (evidence.length > 1) {
    return general(modelIgnored, true);
  }
  if (evidence.length === 1) {
    const noticeCategory = evidence[0]!;
    return {
      noticeCategory,
      guidanceIds: GUIDANCE_IDS_BY_CATEGORY[noticeCategory],
      needsConfirmation: false,
      modelIgnored: Boolean(modelCategory && modelCategory !== noticeCategory),
    };
  }
  if (modelCategory && modelCategory !== "other_household_notice") {
    return general(true, true);
  }
  return general(false, false);
}

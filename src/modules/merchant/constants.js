/** Confidence thresholds — see PHASE2_SYSTEM_ARCHITECTURE.md §5.2 */
export const AUTO_MATCH_CONFIDENCE = 0.95;
export const REVIEW_CONFIDENCE = 0.6;

export const MATCH_METHODS = {
  EXACT_NORMALIZED_NAME: "exact_normalized_name",
  EXACT_ALIAS: "exact_alias",
  NORMALIZED_ALIAS: "normalized_alias",
  FUZZY_NAME: "fuzzy_name",
  MANUAL: "manual",
  NONE: "none",
};

export const MATCH_OUTCOMES = {
  MATCHED: "matched",
  NEEDS_REVIEW: "needs_review",
  NO_MATCH: "no_match",
};

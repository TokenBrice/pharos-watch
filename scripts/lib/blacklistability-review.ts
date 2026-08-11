import type { StablecoinMeta } from "../../shared/types";

export interface BlacklistabilityReviewIssue {
  id: string;
  message: string;
}

export function findBlacklistabilityReviewIssues(
  coins: readonly StablecoinMeta[],
): BlacklistabilityReviewIssue[] {
  const issues: BlacklistabilityReviewIssue[] = [];
  for (const coin of coins) {
    if (!coin.blacklistabilityReview) {
      issues.push({
        id: coin.id,
        message: "stablecoin requires blacklistabilityReview",
      });
      continue;
    }

    const hasSources = (coin.blacklistabilityReview.sources?.length ?? 0) > 0;
    if (!hasSources && !coin.blacklistabilityReview.sourceFreeRationale) {
      issues.push({
        id: coin.id,
        message: "blacklistabilityReview requires sources or sourceFreeRationale",
      });
    }
  }

  return issues;
}

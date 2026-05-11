import type { StablecoinMeta } from "../../shared/types";
import { resolveBlacklistStatuses } from "../../shared/lib/report-card-blacklist-authority";

export interface BlacklistabilityReviewIssue {
  id: string;
  message: string;
}

function cloneWithoutBlacklistOverride(meta: StablecoinMeta): StablecoinMeta {
  const {
    canBeBlacklisted: _canBeBlacklisted,
    canBeBlacklistedSource: _canBeBlacklistedSource,
    blacklistabilityReview: _blacklistabilityReview,
    ...rest
  } = meta;
  return rest as StablecoinMeta;
}

export function findBlacklistabilityReviewIssues(
  coins: readonly StablecoinMeta[],
): BlacklistabilityReviewIssue[] {
  const issues: BlacklistabilityReviewIssue[] = [];
  const withoutExplicitFalse = coins.map((coin) => (
    coin.canBeBlacklisted === false ? cloneWithoutBlacklistOverride(coin) : coin
  ));
  const statusesWithoutFalseSuppression = resolveBlacklistStatuses(withoutExplicitFalse);
  const resolvedStatuses = resolveBlacklistStatuses(coins);

  for (const coin of coins) {
    if (!coin.blacklistabilityReview) {
      issues.push({
        id: coin.id,
        message: "stablecoin requires blacklistabilityReview",
      });
      continue;
    }

    const expectedStatus = coin.canBeBlacklisted ?? resolvedStatuses.get(coin.id);
    if (coin.blacklistabilityReview.reviewedStatus !== expectedStatus) {
      issues.push({
        id: coin.id,
        message: "blacklistabilityReview.reviewedStatus must match resolved canBeBlacklisted status",
      });
    }

    const hasSources = (coin.blacklistabilityReview.sources?.length ?? 0) > 0;
    if (!hasSources && !coin.blacklistabilityReview.sourceFreeRationale) {
      issues.push({
        id: coin.id,
        message: "blacklistabilityReview requires sources or sourceFreeRationale",
      });
    }

    if (coin.canBeBlacklisted !== false) {
      continue;
    }

    const unsuppressedStatus = statusesWithoutFalseSuppression.get(coin.id);
    if (
      unsuppressedStatus === "inherited" &&
      !coin.blacklistabilityReview.upstreamSuppressionRationale
    ) {
      issues.push({
        id: coin.id,
        message: (
          "explicit canBeBlacklisted=false suppresses inferred upstream exposure; " +
          "add blacklistabilityReview.upstreamSuppressionRationale or remove the override"
        ),
      });
    }
  }

  return issues;
}

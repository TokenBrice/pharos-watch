import type { StablecoinMeta } from "@shared/types";
import { isActiveStablecoinMeta } from "@shared/lib/stablecoins/status";
import type { ReserveAssetClass } from "@shared/types/reserves";

// Candidate bases only: these classes may carry custodial exposure, but their
// presence does not establish the measured reserve-majority test.
const CUSTODIAL_RESERVE_CLASSES: Partial<Record<ReserveAssetClass, true>> = {
  cash: true,
  "bank-deposit": true,
  "treasury-bill": true,
  "government-security": true,
  repo: true,
  "money-market-fund": true,
  "private-credit": true,
  "public-credit": true,
  "tokenized-security": true,
  "fund-share": true,
  "commodity-allocated": true,
};

function hasReserveExposureCandidate(
  coin: StablecoinMeta,
  metaById: ReadonlyMap<string, StablecoinMeta>,
): boolean {
  return (coin.reserves ?? []).some((reserve) => {
    // Self-token legs remain in the denominator, never the exposed numerator.
    if (reserve.pct <= 0 || reserve.coinId === coin.id) return false;
    const reserveStatus = reserve.coinId == null
      ? undefined
      : metaById.get(reserve.coinId)?.blacklistabilityReview?.reviewedStatus;
    return (
      reserve.blacklistable === true ||
      reserve.blacklistabilityExposure === "yes" ||
      reserve.blacklistabilityExposure === "possible" ||
      reserve.blacklistabilityExposure === "upstream" ||
      (reserveStatus != null && reserveStatus !== false) ||
      (reserve.assetClass != null && CUSTODIAL_RESERVE_CLASSES[reserve.assetClass] === true)
    );
  });
}

export interface BlacklistabilityReviewIssue {
  id: string;
  message: string;
}

export function findBlacklistabilityReviewIssues(
  coins: readonly StablecoinMeta[],
): BlacklistabilityReviewIssue[] {
  const issues: BlacklistabilityReviewIssue[] = [];
  const metaById = new Map(coins.map((coin) => [coin.id, coin]));
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

    if (!isActiveStablecoinMeta(coin)) continue;

    const parentIds = [...new Set(
      [coin.variantOf, coin.mintAuthority?.inheritedFrom].filter((id): id is string => id != null),
    )];
    const reviewedStatus = coin.blacklistabilityReview.reviewedStatus;
    if (reviewedStatus === false) {
      for (const parentId of parentIds) {
        const parentStatus = metaById.get(parentId)?.blacklistabilityReview?.reviewedStatus;
        if (parentStatus != null && parentStatus !== false) {
          issues.push({
            id: coin.id,
            message: `blacklistabilityReview.reviewedStatus cannot be false while declared parent "${parentId}" resolves to ${String(parentStatus)}`,
          });
        }
      }
    } else if (
      reviewedStatus === "inherited" &&
      parentIds.length > 0 &&
      parentIds.every((id) => metaById.get(id)?.blacklistabilityReview?.reviewedStatus === false) &&
      !hasReserveExposureCandidate(coin, metaById)
    ) {
      issues.push({
        id: coin.id,
        message: `blacklistabilityReview.reviewedStatus inherited has only declared parent(s) resolving to false (${parentIds.join(", ")}) and no exposed or custodial reserve candidate`,
      });
    }
  }

  return issues;
}

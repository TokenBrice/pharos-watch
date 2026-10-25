import { REDEMPTION_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstop-configs";
import type { RedemptionBackstopConfig } from "@shared/lib/redemption-backstop-configs/shared";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";

/**
 * The reviewed redemption route for a coin, or null when none is configured or
 * its review is older than the shared reviewed-evidence budget. Static copy
 * never presents an expired review as current (R3).
 */
export function getCurrentRedemptionConfig(
  stablecoinId: string,
  nowSec = Math.floor(Date.now() / 1_000),
): RedemptionBackstopConfig | null {
  const config = REDEMPTION_BACKSTOP_CONFIGS[stablecoinId];
  if (!config?.reviewedAt) return null;
  const reviewedSec = Date.parse(`${config.reviewedAt}T00:00:00Z`) / 1_000;
  if (!Number.isFinite(reviewedSec) || nowSec - reviewedSec > V9_REVIEW_EVIDENCE_MAX_AGE_SEC) return null;
  return config;
}

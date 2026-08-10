import {
  getBlacklistStatusLabel,
  type BlacklistStatus,
} from "@shared/lib/report-cards";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type { SafetyScoreV9Card } from "@shared/types";

type ReportCardWithFreezeExposure = Pick<SafetyScoreV9Card, "accessPosture">;

function isResolvedBlacklistStatus(value: unknown): value is BlacklistStatus {
  return value === true || value === false || value === "possible" || value === "inherited";
}

export function getTrackedBlacklistStatus(stablecoinId: string): BlacklistStatus | null {
  const metadata = CLIENT_TRACKED_META_BY_ID.get(stablecoinId);
  const reviewedStatus = metadata?.blacklistStatus;
  if (isResolvedBlacklistStatus(reviewedStatus)) return reviewedStatus;

  const legacyStatus = metadata?.canBeBlacklisted;
  if (isResolvedBlacklistStatus(legacyStatus)) return legacyStatus;

  return null;
}

export function getResolvedBlacklistStatus(
  stablecoinId: string,
  reportCard?: ReportCardWithFreezeExposure | null,
): BlacklistStatus | null {
  const trackedStatus = getTrackedBlacklistStatus(stablecoinId);
  if (trackedStatus !== null) return trackedStatus;

  switch (reportCard?.accessPosture?.freezeExposure) {
    case "direct":
      return true;
    case "upstream":
      return "inherited";
    case "possible":
      return "possible";
    case "none-known":
      return false;
    case "unknown":
    case undefined:
      return null;
  }
}

export function getResolvedBlacklistStatusLabel(stablecoinId: string): ReturnType<typeof getBlacklistStatusLabel> | null {
  const status = getResolvedBlacklistStatus(stablecoinId);
  return status === null ? null : getBlacklistStatusLabel(status);
}

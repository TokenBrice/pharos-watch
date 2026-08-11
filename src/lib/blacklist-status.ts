import {
  getBlacklistStatusLabel,
  type BlacklistStatus,
} from "@shared/lib/report-cards";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";

function isResolvedBlacklistStatus(value: unknown): value is BlacklistStatus {
  return value === true || value === false || value === "possible" || value === "inherited";
}

function getTrackedBlacklistStatus(stablecoinId: string): BlacklistStatus | null {
  const metadata = CLIENT_TRACKED_META_BY_ID.get(stablecoinId);
  const reviewedStatus = metadata?.blacklistStatus;
  if (isResolvedBlacklistStatus(reviewedStatus)) return reviewedStatus;
  return null;
}

export function getResolvedBlacklistStatus(stablecoinId: string): BlacklistStatus | null {
  return getTrackedBlacklistStatus(stablecoinId);
}

export function getResolvedBlacklistStatusLabel(stablecoinId: string): ReturnType<typeof getBlacklistStatusLabel> | null {
  const status = getResolvedBlacklistStatus(stablecoinId);
  return status === null ? null : getBlacklistStatusLabel(status);
}

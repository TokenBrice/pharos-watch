import {
  getBlacklistStatusLabel,
  type BlacklistStatus,
} from "@shared/lib/report-cards";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";

export function getResolvedBlacklistStatus(stablecoinId: string): BlacklistStatus | null {
  return CLIENT_TRACKED_META_BY_ID.get(stablecoinId)?.blacklistStatus ?? null;
}

export function getResolvedBlacklistStatusLabel(stablecoinId: string): ReturnType<typeof getBlacklistStatusLabel> | null {
  const status = getResolvedBlacklistStatus(stablecoinId);
  return status === null ? null : getBlacklistStatusLabel(status);
}

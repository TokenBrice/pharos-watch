import {
  getBlacklistStatusLabel,
  type BlacklistStatus,
} from "@shared/lib/report-cards";
import { getTrackedBlacklistStatus } from "@shared/lib/tracked-blacklist-status";
import type { ReportCard } from "@shared/types";

// Shared label vocabulary for the hero pill and the mobile tertiary chip.
// Returns null for `false` so the pill knows to skip rendering; the chip
// surfaces "No" explicitly via the view-model's blacklistDisplay fallback.
export function getFreezableLabel(status: BlacklistStatus): string | null {
  switch (status) {
    case true:
      return "Freezable";
    case "possible":
      return "Possible Freeze";
    case "inherited":
      return "Upstream Freeze";
    default:
      return null;
  }
}

export function getResolvedBlacklistStatus(
  stablecoinId: string,
  reportCard?: Pick<ReportCard, "rawInputs"> | null,
): BlacklistStatus | null {
  const localValue = getTrackedBlacklistStatus(stablecoinId);
  return reportCard?.rawInputs.canBeBlacklisted ?? localValue;
}

export function getResolvedBlacklistStatusLabel(
  stablecoinId: string,
  reportCard?: Pick<ReportCard, "rawInputs"> | null,
): ReturnType<typeof getBlacklistStatusLabel> | null {
  const status = getResolvedBlacklistStatus(stablecoinId, reportCard);
  return status === null ? null : getBlacklistStatusLabel(status);
}

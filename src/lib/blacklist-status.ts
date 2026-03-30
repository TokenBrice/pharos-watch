import {
  getBlacklistStatusLabel,
  type BlacklistStatus,
} from "@shared/lib/report-cards";
import { getTrackedBlacklistStatus } from "@shared/lib/tracked-blacklist-status";
import type { ReportCard } from "@shared/types";

export function getResolvedBlacklistStatus(
  stablecoinId: string,
  reportCard?: Pick<ReportCard, "rawInputs"> | null,
): BlacklistStatus | null {
  return reportCard?.rawInputs.canBeBlacklisted ?? getTrackedBlacklistStatus(stablecoinId);
}

export function getResolvedBlacklistStatusLabel(
  stablecoinId: string,
  reportCard?: Pick<ReportCard, "rawInputs"> | null,
): ReturnType<typeof getBlacklistStatusLabel> | null {
  const status = getResolvedBlacklistStatus(stablecoinId, reportCard);
  return status === null ? null : getBlacklistStatusLabel(status);
}

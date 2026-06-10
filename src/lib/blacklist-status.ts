import {
  getBlacklistStatusLabel,
  type BlacklistStatus,
} from "@shared/lib/report-cards";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type { ReportCard } from "@shared/types";

export function getResolvedBlacklistStatus(
  stablecoinId: string,
  reportCard?: Pick<ReportCard, "rawInputs"> | null,
): BlacklistStatus | null {
  const localValue = CLIENT_TRACKED_META_BY_ID.get(stablecoinId)?.blacklistStatus ?? null;
  return reportCard?.rawInputs.canBeBlacklisted ?? localValue;
}

export function getResolvedBlacklistStatusLabel(
  stablecoinId: string,
  reportCard?: Pick<ReportCard, "rawInputs"> | null,
): ReturnType<typeof getBlacklistStatusLabel> | null {
  const status = getResolvedBlacklistStatus(stablecoinId, reportCard);
  return status === null ? null : getBlacklistStatusLabel(status);
}

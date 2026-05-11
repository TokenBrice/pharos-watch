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
  const localValue = getTrackedBlacklistStatus(stablecoinId);
  // canBeBlacklisted is an authored governance field — the API snapshot just
  // echoes the worker's view of the meta. During tier rollouts the worker may
  // be behind the local meta (e.g. the report-card schema didn't yet emit
  // "dilutable"), so let the local meta win when it explicitly asserts the
  // new tier. Once the snapshot catches up, both sources agree.
  if (localValue === "dilutable") return "dilutable";
  return reportCard?.rawInputs.canBeBlacklisted ?? localValue;
}

export function getResolvedBlacklistStatusLabel(
  stablecoinId: string,
  reportCard?: Pick<ReportCard, "rawInputs"> | null,
): ReturnType<typeof getBlacklistStatusLabel> | null {
  const status = getResolvedBlacklistStatus(stablecoinId, reportCard);
  return status === null ? null : getBlacklistStatusLabel(status);
}

import { getLiveReserveAdapterValidationPolicy } from "@shared/lib/live-reserve-adapters";
import { resolveLiveReserveSourceAgeBudget } from "@shared/lib/live-reserve-freshness";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import type { ExitRouteObservation } from "@shared/types/exit-route";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import { LIVE_RESERVE_FRESHNESS_SEC } from "../live-reserves/store-shared";

/**
 * A reserve disclosure and the cron that consumed it have different clocks.
 * Keep the disclosure's actual observation time. Since 10.26 a disclosure the
 * redemption run admitted as source-fresh is carried forward until that run's
 * own budget (two producer intervals: the next scheduled refresh plus one
 * retry) expires, so a source budget that lapses between scheduled runs no
 * longer drops the route for one publication. Each run re-assesses source
 * freshness; a disclosure already stale at assessment is never admitted.
 */
export function reserveBackedRedemptionRouteMaxAgeSec(
  observation: ExitRouteObservation,
  entry: RedemptionBackstopEntry | undefined,
  producerMaxAgeSec: number,
): number {
  const input = entry?.reserveInput;
  if (!entry || !input || entry.sourceMode !== "dynamic" ||
      entry.freshnessKind !== "verified-source-timestamp" ||
      observation.evidenceKind !== "live-reserve-state" ||
      observation.routeId !== `redemption:${entry.stablecoinId}:${entry.routeFamily}`) {
    return producerMaxAgeSec;
  }
  const freshness = input.freshness;
  const sourceTimestamp = freshness.sourceTimestamp;
  const fetchedAt = freshness.fetchedAt;
  const positiveInteger = (value: number | null | undefined): value is number =>
    value != null && Number.isSafeInteger(value) && value > 0;
  // A malformed purported binding cannot grant a wider source-age allowance.
  if (input.stablecoinId !== entry.stablecoinId || input.attemptId !== freshness.attemptId ||
      freshness.freshnessMode !== "verified" || freshness.stale || freshness.sourceFreshnessInvalid ||
      !positiveInteger(sourceTimestamp) || !positiveInteger(fetchedAt) ||
      !positiveInteger(freshness.sourceAgeBudgetSec) || !positiveInteger(freshness.fetchBudgetSec) ||
      freshness.assessedAt !== entry.updatedAt || fetchedAt > entry.updatedAt ||
      sourceTimestamp !== entry.sourceTimestamp || sourceTimestamp !== observation.observedAt ||
      sourceTimestamp > entry.updatedAt) return 0;
  const config = WORKER_TRACKED_META_BY_ID.get(entry.stablecoinId)?.liveReservesConfig;
  if (!config || config.suspended) return 0;
  const adapterPolicy = getLiveReserveAdapterValidationPolicy(config.adapter);
  const { sourceAgeBudgetSec } = resolveLiveReserveSourceAgeBudget(
    config.scoring?.maxSourceAgeSec, adapterPolicy?.maxSourceAgeSec, LIVE_RESERVE_FRESHNESS_SEC,
  );
  const sourceExpiry = sourceTimestamp + Math.min(freshness.sourceAgeBudgetSec, sourceAgeBudgetSec);
  const fetchExpiry = fetchedAt + Math.min(freshness.fetchBudgetSec, LIVE_RESERVE_FRESHNESS_SEC);
  // The run assessed the disclosure inside both budgets, so carry it forward
  // through the run's own budget; it is still not renewable past the run.
  if (sourceExpiry < entry.updatedAt || fetchExpiry < entry.updatedAt) return 0;
  const producerExpiry = entry.updatedAt + producerMaxAgeSec;
  return Math.max(0, producerExpiry - observation.observedAt);
}

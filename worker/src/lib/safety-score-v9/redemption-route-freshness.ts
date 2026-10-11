import { getLiveReserveAdapterValidationPolicy } from "@shared/lib/live-reserve-adapters";
import { resolveLiveReserveSourceAgeBudget } from "@shared/lib/live-reserve-freshness";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import type { ExitRouteObservation } from "@shared/types/exit-route";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import { LIVE_RESERVE_FRESHNESS_SEC } from "../live-reserves/store-shared";

/**
 * A reserve disclosure and the cron that consumed it have different clocks.
 * Keep the disclosure's actual observation time; its effective expiry is the
 * earliest of the admitted source, reserve fetch and redemption-run expiries.
 * No new producer run can renew the underlying disclosure's source budget.
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
  const producerExpiry = entry.updatedAt + producerMaxAgeSec;
  return Math.max(0, Math.min(sourceExpiry, fetchExpiry, producerExpiry) - observation.observedAt);
}

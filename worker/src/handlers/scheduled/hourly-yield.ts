import { fetchTbillRate } from "../../cron/fetch-tbill-rate";
import type { CronResult } from "../../lib/cron-logger";
import { syncYieldData } from "../../cron/sync-yield-data";
import { syncYieldSupplemental } from "../../cron/sync-yield-supplemental";
import { resolveVaultsFyiConfig } from "../../lib/env";
import type { ScheduledRuntimeContext } from "./context";
import { bindScheduledSlotPlan, runScheduledSlotGroups } from "./slot-groups";

/**
 * C16: the 4-hourly supplemental slot stays the primary producer; the hourly
 * yield slot only catches up after a missed slot, so the catch-up skips while
 * the newest family marker is younger than one producer cadence.
 */
export const SUPPLEMENTAL_CATCH_UP_MIN_MARKER_AGE_SEC = 4 * 3600;

/** A4: refresh the benchmark registry mid-day only once the daily slot is overdue. */
export const HOURLY_TBILL_MIN_REGISTRY_AGE_SEC = 24 * 3600;

/**
 * YBH-3: the supplemental catch-up and the benchmark retry are both
 * degraded-mode legs the hourly slot runs before the publication. When the
 * catch-up actually ran (its result is not a neutral cadence skip), the retry
 * defers one hour so the two legs never stack in front of the publication in
 * one isolate.
 */
export const TBILL_DEFERRED_AFTER_SUPPLEMENTAL_CATCH_UP_REASON = "deferred-after-supplemental-catch-up";

function buildDeferredTbillResult(): CronResult {
  return {
    status: "skipped_neutral",
    itemCount: 0,
    metadata: JSON.stringify({
      skipped: true,
      skipReason: TBILL_DEFERRED_AFTER_SUPPLEMENTAL_CATCH_UP_REASON,
      reason: TBILL_DEFERRED_AFTER_SUPPLEMENTAL_CATCH_UP_REASON,
      minRegistryAgeSec: HOURLY_TBILL_MIN_REGISTRY_AGE_SEC,
    }),
  };
}

function buildHourlyYieldSlotGroups(runtime: ScheduledRuntimeContext) {
  const vaultsFyi = resolveVaultsFyiConfig(runtime.env);
  // YBH-3: the catch-up runs first in this serial chain, so its result decides
  // whether the benchmark retry is allowed to spend this slot's remaining
  // budget in front of the publication.
  let supplementalCatchUpRan = false;
  // Serially ordered on purpose: the catch-up and the benchmark refresh both
  // publish evidence the publication reads in the same slot.
  return bindScheduledSlotPlan("hourlyYieldSync", {
    mode: "serial",
    label: "post-V9 yield slot",
    implementations: {
      "sync-yield-supplemental": async (signal, reportProgress) => {
        const result = await syncYieldSupplemental(runtime.db, signal, runtime.chainRpcs, reportProgress, vaultsFyi, {
          catchUpMinMarkerAgeSec: SUPPLEMENTAL_CATCH_UP_MIN_MARKER_AGE_SEC,
        });
        supplementalCatchUpRan = result.status !== "skipped_neutral";
        return result;
      },
      "fetch-tbill-rate": async (signal) =>
        supplementalCatchUpRan
          ? buildDeferredTbillResult()
          : fetchTbillRate(runtime.db, signal, runtime.env, {
              minRegistryAgeSec: HOURLY_TBILL_MIN_REGISTRY_AGE_SEC,
            }),
      "sync-yield-data": (signal, reportProgress) =>
        syncYieldData(
          runtime.db,
          signal,
          runtime.chainRpcs,
          runtime.coingeckoApiKey,
          runtime.env.ETHERSCAN_API_KEY ?? null,
          reportProgress,
        ),
    },
  });
}

export async function runHourlyYieldSlot(runtime: ScheduledRuntimeContext) {
  return runScheduledSlotGroups(runtime, "post-V9 yield slot", buildHourlyYieldSlotGroups(runtime));
}

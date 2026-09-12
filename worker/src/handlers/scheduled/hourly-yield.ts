import { fetchTbillRate } from "../../cron/fetch-tbill-rate";
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

function buildHourlyYieldSlotGroups(runtime: ScheduledRuntimeContext) {
  const vaultsFyi = resolveVaultsFyiConfig(runtime.env);
  // Serially ordered on purpose: the catch-up and the benchmark refresh both
  // publish evidence the publication reads in the same slot.
  return bindScheduledSlotPlan("hourlyYieldSync", {
    mode: "serial",
    label: "post-V9 yield slot",
    implementations: {
      "sync-yield-supplemental": (signal, reportProgress) =>
        syncYieldSupplemental(runtime.db, signal, runtime.chainRpcs, reportProgress, vaultsFyi, {
          catchUpMinMarkerAgeSec: SUPPLEMENTAL_CATCH_UP_MIN_MARKER_AGE_SEC,
        }),
      "fetch-tbill-rate": (signal) =>
        fetchTbillRate(runtime.db, signal, runtime.env, {
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

/**
 * Half-hourly trigger (10,40 * * * *):
 *   sync-stablecoin-charts (1) → sync-dex-liquidity (4) → sync-yield-data (2)
 *
 * Jobs are chained sequentially so the heaviest phase (dex-liquidity with
 * up to 4 concurrent Curve-chain fetches) does not overlap with yield-sync.
 * Connection budget: 4/6 peak (dex-liquidity Curve-chains phase)
 */
import { syncStablecoinCharts } from "../../cron/sync-stablecoin-charts";
import { syncDexLiquidity } from "../../cron/dex-liquidity";
import { syncYieldData } from "../../cron/sync-yield-data";
import type { ScheduledRuntimeContext } from "./context";

export function runHalfHourlySlot(runtime: ScheduledRuntimeContext): void {
  const chartsSync = runtime.runLeasedCron("sync-stablecoin-charts", (signal) =>
    syncStablecoinCharts(runtime.db, signal),
  );
  runtime.ctx.waitUntil(chartsSync);

  const dexSync = chartsSync.then(() =>
    runtime.runLeasedCron("sync-dex-liquidity", (signal) =>
      syncDexLiquidity(runtime.db, runtime.env.GRAPH_API_KEY ?? null, signal, runtime.coingeckoApiKey),
    ),
  );
  runtime.ctx.waitUntil(dexSync);
  runtime.ctx.waitUntil(dexSync.then(() =>
    runtime.runLeasedCron("sync-yield-data", (signal) => syncYieldData(runtime.db, signal, runtime.chainRpcs, runtime.coingeckoApiKey)),
  ));
}

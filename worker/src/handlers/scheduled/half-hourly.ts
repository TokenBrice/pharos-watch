/**
 * Half-hourly trigger (10,40 * * * *):
 *   sync-stablecoin-charts (1) → sync-dex-liquidity (4)
 *   → compute-dews (0) → stability-index (0) → sync-yield-data (2)
 *
 * Jobs are chained sequentially so the heaviest phase (dex-liquidity with
 * up to 4 concurrent Curve-chain/subgraph fetches) does not overlap with yield-sync.
 * compute-dews and stability-index are DB-only (0 connections) and benefit
 * from running after dex-liquidity provides fresh liquidity scores.
 * Connection budget: 4/6 peak (dex-liquidity subgraph phase; direct APIs run afterward)
 */
import { syncStablecoinCharts } from "../../cron/sync-stablecoin-charts";
import { syncDexLiquidity } from "../../cron/dex-liquidity";
import { computeAndStoreDEWS } from "../../cron/compute-dews";
import { computeAndStoreStabilityIndex } from "../../cron/stability-index";
import { syncYieldData } from "../../cron/sync-yield-data";
import type { ScheduledRuntimeContext } from "./context";

export function runHalfHourlySlot(runtime: ScheduledRuntimeContext): void {
  const chartsSync = runtime.runLeasedCron("sync-stablecoin-charts", (signal) =>
    syncStablecoinCharts(runtime.db, signal),
  );
  runtime.ctx.waitUntil(chartsSync);

  const dexSync = chartsSync.then(() =>
    runtime.runLeasedCron("sync-dex-liquidity", (signal) =>
      syncDexLiquidity(
        runtime.db,
        runtime.env.GRAPH_API_KEY ?? null,
        signal,
        runtime.coingeckoApiKey,
        runtime.chainRpcs,
      ),
    ),
  );
  runtime.ctx.waitUntil(dexSync);

  const dewsSync = dexSync.then(() =>
    runtime.runLeasedCron("compute-dews", (signal) => computeAndStoreDEWS(runtime.db, signal)),
  );
  runtime.ctx.waitUntil(dewsSync);

  const stabilitySync = dewsSync.then(() =>
    runtime.runLeasedCron("stability-index", (signal) => computeAndStoreStabilityIndex(runtime.db, signal)),
  );
  runtime.ctx.waitUntil(stabilitySync);

  runtime.ctx.waitUntil(stabilitySync.then(() =>
    runtime.runLeasedCron("sync-yield-data", (signal) => syncYieldData(runtime.db, signal, runtime.chainRpcs, runtime.coingeckoApiKey)),
  ));
}

/**
 * Half-hourly trigger (10,40 * * * *):
 *   sync-stablecoin-charts (1) → sync-dex-liquidity (4)
 *   → compute-dews (0) → stability-index (0)
 *
 * Jobs are chained sequentially so the heaviest phase (dex-liquidity with
 * up to 4 concurrent Curve-chain/subgraph fetches) does not overlap with any
 * other fetch-heavy work.
 * compute-dews and stability-index are DB-only (0 connections) and benefit
 * from running after dex-liquidity provides fresh liquidity scores.
 * Connection budget: 4/6 peak (dex-liquidity subgraph phase; direct APIs run afterward)
 */
import { syncStablecoinCharts } from "../../cron/sync-stablecoin-charts";
import { syncDexLiquidity } from "../../cron/dex-liquidity";
import { computeAndStoreDEWS } from "../../cron/compute-dews";
import { computeAndStoreStabilityIndex } from "../../cron/stability-index";
import type { ScheduledRuntimeContext } from "./context";

export async function runHalfHourlySlot(runtime: ScheduledRuntimeContext): Promise<void> {
  const runHalfHourlyJob = async (
    job: string,
    fn: Parameters<ScheduledRuntimeContext["runLeasedCron"]>[1],
  ) => {
    try {
      return (await runtime.runLeasedCron(job, fn)) ?? null;
    } catch (err) {
      console.error(`[cron] ${job} failed in half-hour slot:`, err);
      return null;
    }
  };

  await runHalfHourlyJob("sync-stablecoin-charts", (signal) =>
    syncStablecoinCharts(runtime.db, signal),
  );

  const dexResult = await runHalfHourlyJob("sync-dex-liquidity", (signal) =>
    syncDexLiquidity(
      runtime.db,
      runtime.env.GRAPH_API_KEY ?? null,
      signal,
      runtime.coingeckoApiKey,
      runtime.chainRpcs,
    ),
  );
  if (dexResult?.status === "error" || dexResult == null) {
    console.warn("[cron] sync-dex-liquidity did not complete cleanly — continuing with downstream degraded paths");
  }

  await runHalfHourlyJob("compute-dews", (signal) => computeAndStoreDEWS(runtime.db, signal));
  await runHalfHourlyJob("stability-index", (signal) => computeAndStoreStabilityIndex(runtime.db, signal));
}

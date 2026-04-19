/**
 * Half-hourly trigger (10,40 * * * *):
 *   sync-stablecoin-charts (1) → sync-dex-liquidity (4)
 *
 * Jobs are chained sequentially so the heaviest phase (dex-liquidity with
 * up to 4 concurrent Curve-chain/subgraph fetches) does not overlap with any
 * other fetch-heavy work. DEWS and PSI run on the separate dews-psi trigger
 * so a platform-level DEX-liquidity CPU kill cannot starve downstream DB-only
 * availability jobs.
 * Connection budget: 4/6 peak (dex-liquidity subgraph phase; direct APIs run afterward)
 */
import { syncStablecoinCharts } from "../../cron/sync-stablecoin-charts";
import { syncDexLiquidity } from "../../cron/dex-liquidity";
import type { ScheduledRuntimeContext } from "./context";
import { runBestEffortScheduledJob } from "./run-best-effort-job";

export async function runHalfHourlySlot(runtime: ScheduledRuntimeContext): Promise<void> {
  await runBestEffortScheduledJob(runtime, "half-hour slot", "sync-stablecoin-charts", (signal) =>
    syncStablecoinCharts(runtime.db, signal),
  );

  const dexResult = await runBestEffortScheduledJob(runtime, "half-hour slot", "sync-dex-liquidity", (signal) =>
    syncDexLiquidity(
      runtime.db,
      runtime.env.GRAPH_API_KEY ?? null,
      signal,
      runtime.coingeckoApiKey,
      runtime.chainRpcs,
    ),
  );
  if (dexResult?.status === "error" || dexResult == null) {
    console.warn("[cron] sync-dex-liquidity did not complete cleanly");
  }
}

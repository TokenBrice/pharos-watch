/**
 * Half-hourly trigger (10,40 * * * *):
 *   sync-dex-liquidity (5)
 *
 * Dedicated DEX scoring lane so the heavy dex-liquidity phase has a full
 * scheduled invocation budget to itself. DEWS and PSI stay on the separate
 * dews-psi trigger so a platform-level DEX-liquidity CPU kill still cannot
 * starve downstream DB-only availability jobs.
 * Connection budget: 5/6 peak (nested direct-API phase; still within the repo policy)
 */
import { syncDexLiquidity } from "../../cron/dex-liquidity/orchestrator";
import type { ScheduledRuntimeContext } from "./context";
import { runSingleScheduledJob } from "./slot-groups";

export async function runHalfHourlySlot(runtime: ScheduledRuntimeContext) {
  return runSingleScheduledJob(runtime, "half-hour dex slot", {
    job: "sync-dex-liquidity",
    run: (signal, reportProgress) =>
      syncDexLiquidity(
        runtime.db,
        runtime.env.GRAPH_API_KEY ?? null,
        signal,
        runtime.coingeckoApiKey,
        runtime.chainRpcs,
        reportProgress,
      ),
  });
}

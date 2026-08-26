/**
 * Hourly trigger (10 * * * *):
 *   sync-dex-liquidity-stage (5)
 *
 * Dedicated DEX source and pool-construction lane. The exact scoring input is
 * stored as bounded, generation-fenced D1 chunks for the 16/46 consumer.
 * Connection budget: 5/6 peak (nested direct-API phase; still within the repo policy)
 */
import { stageDexLiquidityScoring } from "../../cron/dex-liquidity/orchestrator";
import type { ScheduledRuntimeContext } from "./context";
import { runSingleScheduledJob } from "./slot-groups";

export async function runHalfHourlySlot(runtime: ScheduledRuntimeContext) {
  return runSingleScheduledJob(runtime, "half-hour dex slot", {
    job: "sync-dex-liquidity-stage",
    run: (signal, reportProgress) =>
      stageDexLiquidityScoring(
        runtime.db,
        runtime.env.GRAPH_API_KEY ?? null,
        signal,
        runtime.coingeckoApiKey,
        runtime.chainRpcs,
        reportProgress,
        runtime.slotStartedAt,
      ),
  });
}

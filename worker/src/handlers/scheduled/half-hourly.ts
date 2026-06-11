/**
 * Half-hourly trigger (10,40 * * * *):
 *   sync-dex-liquidity (4)
 *
 * Dedicated DEX scoring lane so the heavy dex-liquidity phase has a full
 * scheduled invocation budget to itself. DEWS and PSI stay on the separate
 * dews-psi trigger so a platform-level DEX-liquidity CPU kill still cannot
 * starve downstream DB-only availability jobs.
 * Connection budget: 4/6 peak (dex-liquidity subgraph phase; direct APIs run afterward)
 */
import { syncDexLiquidity } from "../../cron/dex-liquidity/orchestrator";
import type { ScheduledRuntimeContext } from "./context";
import { runScheduledSlotGroups, type ScheduledSlotGroup } from "./slot-groups";

function buildHalfHourlySlotGroups(runtime: ScheduledRuntimeContext): ScheduledSlotGroup[] {
  return [
    {
      mode: "serial",
      label: "dex-liquidity",
      tasks: [
        {
          job: "sync-dex-liquidity",
          run: (signal) =>
            syncDexLiquidity(
              runtime.db,
              runtime.env.GRAPH_API_KEY ?? null,
              signal,
              runtime.coingeckoApiKey,
              runtime.chainRpcs,
            ),
        },
      ],
    },
  ];
}

export async function runHalfHourlySlot(runtime: ScheduledRuntimeContext) {
  return runScheduledSlotGroups(runtime, "half-hour dex slot", buildHalfHourlySlotGroups(runtime));
}

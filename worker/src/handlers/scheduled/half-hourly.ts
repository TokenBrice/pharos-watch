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
      syncDexLiquidity(runtime.db, runtime.env.GRAPH_API_KEY ?? null, signal),
    ),
  );
  runtime.ctx.waitUntil(dexSync);
  runtime.ctx.waitUntil(dexSync.then(() =>
    runtime.runLeasedCron("sync-yield-data", (signal) => syncYieldData(runtime.db, signal)),
  ));
}

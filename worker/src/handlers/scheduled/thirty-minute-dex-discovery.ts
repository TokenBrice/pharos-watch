import { syncDexDiscovery } from "../../cron/dex-discovery/orchestrator";
import type { ScheduledRuntimeContext } from "./context";
import { buildScheduledSlotSummary, summarizeCronResult } from "./slot-summary";

export async function runTwoHourlyDexDiscoverySlot(runtime: ScheduledRuntimeContext) {
  const result = await runtime.runLeasedCron("sync-dex-discovery", (signal, reportProgress) =>
    syncDexDiscovery(runtime.db, runtime.env.COINGECKO_API_KEY ?? null, signal, reportProgress),
  );
  return buildScheduledSlotSummary([summarizeCronResult("sync-dex-discovery", result)]);
}

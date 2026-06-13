import { syncDexDiscovery } from "../../cron/dex-discovery/orchestrator";
import type { ScheduledRuntimeContext } from "./context";
import { buildScheduledSlotSummary, summarizeCronResult } from "./slot-summary";

export async function runTwoHourlyDexDiscoverySlot(runtime: ScheduledRuntimeContext) {
  // NOTE: errors propagate here (event marked failed), unlike runSingleScheduledJob handlers which swallow into a 'thrown' summary.
  const result = await runtime.runLeasedCron("sync-dex-discovery", (signal, reportProgress) =>
    syncDexDiscovery(runtime.db, runtime.env.COINGECKO_API_KEY ?? null, signal, reportProgress),
  );
  return buildScheduledSlotSummary([summarizeCronResult("sync-dex-discovery", result)]);
}

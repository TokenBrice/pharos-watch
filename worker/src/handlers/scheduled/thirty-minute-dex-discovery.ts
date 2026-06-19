import { syncDexDiscovery } from "../../cron/dex-discovery/orchestrator";
import type { ScheduledRuntimeContext } from "./context";
import { runSinglePropagatingSlotJob } from "./slot-summary";

export async function runTwoHourlyDexDiscoverySlot(runtime: ScheduledRuntimeContext) {
  return runSinglePropagatingSlotJob(runtime, "sync-dex-discovery", (signal, reportProgress) =>
    syncDexDiscovery(runtime.db, runtime.env.COINGECKO_API_KEY ?? null, signal, reportProgress),
  );
}

import { syncDexDiscovery } from "../../cron/dex-discovery";
import type { ScheduledRuntimeContext } from "./context";

export async function runTwoHourlyDexDiscoverySlot(runtime: ScheduledRuntimeContext): Promise<void> {
  await runtime.runLeasedCron("sync-dex-discovery", (signal, reportProgress) =>
    syncDexDiscovery(runtime.db, runtime.env.COINGECKO_API_KEY ?? null, signal, reportProgress),
  );
}

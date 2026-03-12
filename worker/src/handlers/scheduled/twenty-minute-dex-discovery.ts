import { syncDexDiscovery } from "../../cron/dex-discovery";
import type { ScheduledRuntimeContext } from "./context";

export function runTwentyMinuteDexDiscoverySlot(runtime: ScheduledRuntimeContext): void {
  runtime.ctx.waitUntil(runtime.runLeasedCron("sync-dex-discovery", (signal, reportProgress) =>
    syncDexDiscovery(runtime.db, runtime.env.COINGECKO_API_KEY ?? null, signal, reportProgress),
  ));
}

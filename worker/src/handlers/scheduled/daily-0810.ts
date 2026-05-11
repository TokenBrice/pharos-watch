/**
 * Daily 08:10 UTC trigger (10 8 * * *):
 *   discovery-scan (1)
 *
 * This isolates the weekly CoinGecko coverage scan from the 08:05 digest and
 * Bluechip lane so both triggers retain connection headroom.
 */
import { runDiscoveryScan } from "../../cron/discovery-scan";
import type { ScheduledRuntimeContext } from "./context";
import { runBestEffortScheduledJob } from "./run-best-effort-job";

export async function runDaily0810Slot(runtime: ScheduledRuntimeContext): Promise<void> {
  await runBestEffortScheduledJob(
    runtime,
    "daily 08:10 slot",
    "discovery-scan",
    (signal) => runDiscoveryScan(runtime.db, signal, runtime.coingeckoApiKey),
  );
}

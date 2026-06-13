/**
 * Daily 08:10 UTC trigger (10 8 * * *):
 *   discovery-scan (1)
 *
 * This isolates the weekly CoinGecko coverage scan from the 08:05 digest and
 * Bluechip lane so both triggers retain connection headroom.
 */
import { runDiscoveryScan } from "../../cron/discovery-scan";
import type { ScheduledRuntimeContext } from "./context";
import { runSingleScheduledJob } from "./slot-groups";

export async function runDaily0810Slot(runtime: ScheduledRuntimeContext) {
  return runSingleScheduledJob(runtime, "daily 08:10 slot", {
    job: "discovery-scan",
    run: (signal) => runDiscoveryScan(runtime.db, signal, runtime.coingeckoApiKey),
  });
}

import { syncYieldData } from "../../cron/sync-yield-data";
import type { ScheduledRuntimeContext } from "./context";
import { runBestEffortScheduledJob } from "./run-best-effort-job";

export async function runHourlyYieldSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  await runBestEffortScheduledJob(runtime, "hourly yield slot", "sync-yield-data", (signal) =>
    syncYieldData(
      runtime.db,
      signal,
      runtime.chainRpcs,
      runtime.coingeckoApiKey,
      runtime.env.ETHERSCAN_API_KEY ?? null,
    ),
  );
}

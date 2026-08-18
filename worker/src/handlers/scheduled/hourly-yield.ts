import { syncYieldData } from "../../cron/sync-yield-data";
import type { ScheduledRuntimeContext } from "./context";
import { runSingleScheduledJob } from "./slot-groups";

export async function runHourlyYieldSlot(runtime: ScheduledRuntimeContext) {
  return runSingleScheduledJob(runtime, "post-V9 yield slot", {
    job: "sync-yield-data",
    run: (signal, reportProgress) =>
      syncYieldData(
        runtime.db,
        signal,
        runtime.chainRpcs,
        runtime.coingeckoApiKey,
        runtime.env.ETHERSCAN_API_KEY ?? null,
        reportProgress,
      ),
  });
}

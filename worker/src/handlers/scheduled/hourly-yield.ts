import { syncYieldData } from "../../cron/sync-yield-data";
import type { ScheduledRuntimeContext } from "./context";

export async function runHourlyYieldSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  try {
    await runtime.runLeasedCron("sync-yield-data", (signal) =>
      syncYieldData(
        runtime.db,
        signal,
        runtime.chainRpcs,
        runtime.coingeckoApiKey,
        runtime.env.ETHERSCAN_API_KEY ?? null,
      ),
    );
  } catch (err) {
    console.error("[cron] sync-yield-data failed in hourly yield slot:", err);
  }
}

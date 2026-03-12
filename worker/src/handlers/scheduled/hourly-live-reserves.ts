import { syncLiveReserves } from "../../cron/sync-live-reserves";
import type { ScheduledRuntimeContext } from "./context";

export function runHourlyReserveSyncSlot(runtime: ScheduledRuntimeContext): void {
  runtime.ctx.waitUntil(
    runtime.runLeasedCron("sync-live-reserves", (signal) =>
      syncLiveReserves(runtime.db, signal, {
        etherscanApiKey: runtime.env.ETHERSCAN_API_KEY,
        alchemyApiKey: runtime.env.ALCHEMY_API_KEY,
      }),
    ),
  );
}

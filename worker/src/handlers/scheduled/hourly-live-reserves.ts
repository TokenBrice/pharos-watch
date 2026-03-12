import { syncLiveReserves } from "../../cron/sync-live-reserves";
import { syncRedemptionBackstops } from "../../cron/sync-redemption-backstops";
import type { ScheduledRuntimeContext } from "./context";

export function runHourlyReserveSyncSlot(runtime: ScheduledRuntimeContext): void {
  runtime.ctx.waitUntil(
    (async () => {
      try {
        await runtime.runLeasedCron("sync-live-reserves", (signal) =>
          syncLiveReserves(runtime.db, signal, {
            etherscanApiKey: runtime.env.ETHERSCAN_API_KEY,
            alchemyApiKey: runtime.env.ALCHEMY_API_KEY,
          }),
        );
      } finally {
        await runtime.runLeasedCron("sync-redemption-backstops", (signal) =>
          syncRedemptionBackstops(runtime.db, signal),
        );
      }
    })(),
  );
}

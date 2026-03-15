import { syncLiveReserves } from "../../cron/sync-live-reserves";
import { syncRedemptionBackstops } from "../../cron/sync-redemption-backstops";
import { checkCollateralDrift } from "../../lib/collateral-drift";
import { sendAlert } from "../../lib/alerts";
import type { ScheduledRuntimeContext } from "./context";

export function runHourlyReserveSyncSlot(runtime: ScheduledRuntimeContext): void {
  runtime.ctx.waitUntil(
    (async () => {
      try {
        await runtime.runLeasedCron("sync-live-reserves", (signal) =>
          syncLiveReserves(runtime.db, signal, {
            etherscanApiKey: runtime.env.ETHERSCAN_API_KEY,
            alchemyApiKey: runtime.env.ALCHEMY_API_KEY,
            chainRpcs: runtime.chainRpcs,
          }),
        );
      } finally {
        await runtime.runLeasedCron("sync-redemption-backstops", (signal) =>
          syncRedemptionBackstops(runtime.db, signal),
        );
      }

      // Post-sync: check for collateral drift and fire alerts
      try {
        const drift = await checkCollateralDrift(runtime.db);
        if (drift.driftCoins.length > 0) {
          const summary = drift.driftCoins
            .map((d) => `${d.id}: live=${d.liveScore}, curated=${d.curatedScore} (Δ${d.delta})`)
            .join("\n");
          console.warn(`[live-reserves] Collateral drift detected:\n${summary}`);
          sendAlert(
            runtime.alertWebhookUrl,
            "Collateral Score Drift",
            `${drift.driftCoins.length} coin(s) with >15pt live/curated divergence:\n${summary}`,
          ).catch(() => {});
        }
        if (drift.fallbackCoins.length > 5) {
          console.warn(`[live-reserves] ${drift.fallbackCoins.length} live-enabled coins using curated fallback`);
        }
      } catch (e) {
        console.error("[live-reserves] Drift check failed:", e);
      }
    })(),
  );
}

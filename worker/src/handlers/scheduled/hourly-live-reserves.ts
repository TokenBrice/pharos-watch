/**
 * Hourly reserve-sync trigger (11 * * * *):
 *   sync-live-reserves (1) → sync-redemption-backstops (0) → collateral drift check (0)
 *
 * Reserve adapters run sequentially; backstops are DB-only.
 * Connection budget: 1/6 peak
 */
import { syncLiveReserves } from "../../cron/sync-live-reserves";
import { syncRedemptionBackstops } from "../../cron/sync-redemption-backstops";
import { checkCollateralDrift } from "../../lib/collateral-drift";
import { getMaxSyncAge } from "../../lib/live-reserves-store";
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

        // Staleness check: alert if no successful sync in 6+ hours (missed cron)
        const maxAge = await getMaxSyncAge(runtime.db);
        if (maxAge > 6 * 3600) {
          sendAlert(
            runtime.alertWebhookUrl,
            "Live reserve sync stale",
            `No successful sync in ${Math.round(maxAge / 3600)}h. Check cron scheduler.`,
          ).catch(() => {});
        }
      } catch (e) {
        console.error("[live-reserves] Drift check failed:", e);
      }
    })(),
  );
}

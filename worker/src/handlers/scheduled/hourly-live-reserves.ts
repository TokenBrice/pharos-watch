/**
 * Hourly reserve-sync trigger (11 * * * *):
 *   sync-live-reserves (2) → sync-redemption-backstops (0) → sync-kinesis-supply (1) → collateral drift check (0)
 *
 * Reserve adapters run sequentially; backstops are DB-only.
 * Connection budget: 2/6 peak during reserve adapter I/O
 */
import { syncLiveReserves } from "../../cron/sync-live-reserves";
import { syncRedemptionBackstops } from "../../cron/sync-redemption-backstops";
import { syncKinesisSupply } from "../../cron/sync-kinesis-supply";
import { checkCollateralDrift } from "../../lib/collateral-drift";
import { getMaxSyncAge } from "../../lib/live-reserves-store";
import { sendAlert } from "../../lib/alerts";
import type { ScheduledRuntimeContext } from "./context";

export async function runHourlyReserveSyncSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  try {
    await runtime.runLeasedCron("sync-live-reserves", (signal, reportProgress) =>
      syncLiveReserves(runtime.db, signal, {
        etherscanApiKey: runtime.env.ETHERSCAN_API_KEY,
        alchemyApiKey: runtime.env.ALCHEMY_API_KEY,
        chainRpcs: runtime.chainRpcs,
      }, reportProgress),
    );
  } finally {
    await runtime.runLeasedCron("sync-redemption-backstops", (signal) =>
      syncRedemptionBackstops(runtime.db, signal),
    );
  }

  try {
    await runtime.runLeasedCron("sync-kinesis-supply", (signal) =>
      syncKinesisSupply(runtime.db, signal),
    );
  } catch (e) {
    console.error("[hourly-live-reserves] Kinesis supply sync failed:", e);
  }

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
}

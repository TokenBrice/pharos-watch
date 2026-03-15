/**
 * Quarter-hourly trigger (every 15 min):
 *   sync-stablecoins (3) → snapshot-supply (0) → sync-fx-rates (2)
 *   → stability-index (0) → compute-dews (0) → status-self-check (1)
 *
 * All jobs run sequentially in-slot to avoid cross-job connection spikes.
 * Connection budget: 3/6 peak (sync-stablecoins phase)
 */
import { getCache } from "../../lib/db-cache";
import { sendAlert } from "../../lib/alerts";

import { syncStablecoins } from "../../cron/sync-stablecoins";
import { syncFxRates } from "../../cron/sync-fx-rates";
import { snapshotSupply } from "../../cron/snapshot-supply";
import { computeAndStoreStabilityIndex } from "../../cron/stability-index";
import { computeAndStoreDEWS } from "../../cron/compute-dews";
import { runStatusSelfCheck } from "../../cron/status-self-check";
import { parseStablecoinsCapabilities, type ScheduledRuntimeContext } from "./context";

export async function runQuarterHourlySlot(runtime: ScheduledRuntimeContext): Promise<void> {
  runtime.ctx.waitUntil((async () => {
    const runQuarterHourlyJob = async (
      job: string,
      fn: Parameters<ScheduledRuntimeContext["runLeasedCron"]>[1],
    ) => {
      try {
        return (await runtime.runLeasedCron(job, fn)) ?? null;
      } catch (err) {
        console.error(`[cron] ${job} failed in quarter-hour slot:`, err);
        return null;
      }
    };

    // All jobs in this trigger share one Workers 6-connection fetch pool.
    // Run sequentially in-slot to avoid cross-job connection spikes.
    const stablecoinsResult = await runQuarterHourlyJob(
      "sync-stablecoins",
      (signal) => syncStablecoins(runtime.db, runtime.env.CMC_API_KEY, signal, runtime.alertWebhookUrl, runtime.coingeckoApiKey, runtime.chainRpcs),
    );
    const stablecoinsCapabilities = parseStablecoinsCapabilities(stablecoinsResult);
    const stablecoinsCacheSafe = stablecoinsCapabilities.stablecoinsCache;
    const depegPipelineSafe = stablecoinsCapabilities.depegPipeline;
    if (stablecoinsResult && !stablecoinsCacheSafe) {
      console.warn("[cron] sync-stablecoins completed without downstream-safe cache write — skipping dependent jobs");
    }

    if (stablecoinsCacheSafe) {
      await runQuarterHourlyJob("snapshot-supply", (signal) => snapshotSupply(runtime.db, signal));
    }

    await runQuarterHourlyJob("sync-fx-rates", (signal) =>
      syncFxRates(runtime.db, signal, runtime.env.OPENEXCHANGERATES_API_KEY),
    );

    if (stablecoinsCacheSafe && depegPipelineSafe) {
      await runQuarterHourlyJob("stability-index", (signal) => computeAndStoreStabilityIndex(runtime.db, signal));
    } else if (stablecoinsCacheSafe && !depegPipelineSafe) {
      console.warn("[cron] sync-stablecoins completed without a safe depeg pipeline — skipping stability-index");
    }

    if (stablecoinsCacheSafe) {
      await runQuarterHourlyJob("compute-dews", (signal) => computeAndStoreDEWS(runtime.db, signal));
    }

    await runQuarterHourlyJob(
      "status-self-check",
      (signal) => runStatusSelfCheck(
        runtime.db,
        runtime.env.SELF_URL,
        signal,
        runtime.ctx,
        runtime.mintBurnFreshnessConfig,
        runtime.alertWebhookUrl,
      ),
    );

    try {
      const cached = await getCache(runtime.db, "stablecoins");
      if (cached) {
        const age = Math.floor(Date.now() / 1000) - cached.updatedAt;
        if (age > 1800) {
          await sendAlert(runtime.alertWebhookUrl, "Data stale", `Stablecoins cache is ${Math.round(age / 60)}min old (expected <20min)`);
        }
      }
    } catch {
      // Non-blocking.
    }
  })());
}

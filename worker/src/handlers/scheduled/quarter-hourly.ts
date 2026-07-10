/**
 * Quarter-hourly trigger (every 15 min):
 *   sync-fx-rates (3) -> sync-stablecoins (4) -> snapshots/cache refreshes (0)
 *
 * All jobs run sequentially in-slot to avoid cross-job connection spikes.
 * Run FX first so Chainlink gets a clean RPC window before the heavier
 * stablecoin pricing pipeline consumes the slot's shared fetch budget.
 */
import { getCache } from "../../lib/db-cache";
import { sendAlert } from "../../lib/alerts";

import { syncStablecoins } from "../../cron/sync-stablecoins";
import { syncFxRates } from "../../cron/sync-fx-rates";
import { snapshotSupply } from "../../cron/snapshot-supply";
import { snapshotChainSupply } from "../../cron/snapshot-chain-supply";
import { publishReportCardCache } from "../../cron/publish-report-card-cache";
import { computeDepegResolver } from "../../cron/compute-depeg-resolver";
import { parseStablecoinsCapabilities, type ScheduledRuntimeContext } from "./context";
import { runBestEffortScheduledJobWithOutcome } from "./run-best-effort-job";
import {
  buildScheduledSlotSummary,
  summarizeSkippedScheduledJob,
  type ScheduledSlotJobSummary,
} from "./slot-summary";
import { logSkippedCronRun } from "./preflight-skip";

export async function runQuarterHourlySlot(runtime: ScheduledRuntimeContext) {
  const outcomes: ScheduledSlotJobSummary[] = [];
  outcomes.push((await runBestEffortScheduledJobWithOutcome(runtime, "quarter-hour slot", "sync-fx-rates", (signal) =>
    syncFxRates(
      runtime.db,
      signal,
      runtime.env.OPENEXCHANGERATES_API_KEY,
      runtime.chainRpcs,
      runtime.env.DRPC_API_KEY ?? null,
      runtime.env.ETHERSCAN_API_KEY ?? null,
      { scheduledAtSec: runtime.slotStartedAt },
    ),
  )).summary);

  const stablecoinsOutcome = await runBestEffortScheduledJobWithOutcome(
    runtime,
    "quarter-hour slot",
    "sync-stablecoins",
    (signal, reportProgress) => syncStablecoins(
      runtime.db,
      signal,
      {
        cmcApiKey: runtime.env.CMC_API_KEY,
        alertWebhookUrl: runtime.alertWebhookUrl,
        coingeckoApiKey: runtime.coingeckoApiKey,
        chainRpcs: runtime.chainRpcs,
        reportProgress,
        jupiterApiKey: runtime.env.JUPITER_API_KEY,
        addressPriceProvider: {
          enabledProviders: runtime.env.ADDRESS_PRICE_PROVIDERS_ENABLED,
          alchemyApiKey: runtime.env.ALCHEMY_API_KEY,
          moralisApiKey: runtime.env.MORALIS_API_KEY,
          birdeyeApiKey: runtime.env.BIRDEYE_API_KEY,
          cgApiKey: runtime.coingeckoApiKey,
        },
      },
    ),
  );
  outcomes.push(stablecoinsOutcome.summary);
  const stablecoinsResult = stablecoinsOutcome.result;
  const stablecoinsCapabilities = parseStablecoinsCapabilities(stablecoinsResult);
  const stablecoinsCacheSafe = stablecoinsCapabilities.stablecoinsCache;
  if (stablecoinsResult && !stablecoinsCacheSafe) {
    console.warn("[cron] sync-stablecoins completed without downstream-safe cache write — skipping cache-dependent jobs");
  }

  const runIfCacheSafe = async (
    job: string,
    fn: Parameters<typeof runBestEffortScheduledJobWithOutcome>[3],
  ): Promise<void> => {
    if (stablecoinsCacheSafe) {
      outcomes.push((await runBestEffortScheduledJobWithOutcome(runtime, "quarter-hour slot", job, fn)).summary);
    } else {
      await logSkippedCronRun(runtime, {
        job,
        reason: "stablecoins-cache-unsafe",
        message: `${job} did not start because the stablecoins cache capability was unavailable`,
      });
      outcomes.push(summarizeSkippedScheduledJob(job, "stablecoins-cache-unsafe"));
    }
  };

  await runIfCacheSafe("snapshot-supply", (signal) => snapshotSupply(runtime.db, signal));
  await runIfCacheSafe("snapshot-chain-supply", (signal) => snapshotChainSupply(runtime.db, signal));
  await runIfCacheSafe("publish-report-card-cache", (signal) => publishReportCardCache(runtime.db, signal));

  outcomes.push((await runBestEffortScheduledJobWithOutcome(runtime, "quarter-hour slot", "compute-depeg-resolver", (signal) =>
    computeDepegResolver({
      db: runtime.db,
      signal,
      slot: "quarter-hour",
      stablecoinsCacheSafe,
      depegPipelineHealthy: stablecoinsCapabilities.depegPipeline,
      syncCapabilities: stablecoinsCapabilities,
    }),
  )).summary);

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

  return buildScheduledSlotSummary(outcomes);
}

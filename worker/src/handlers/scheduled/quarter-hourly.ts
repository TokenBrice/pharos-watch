import { logWorkerEventArgs } from "../../lib/structured-log";
/**
 * Quarter-hourly trigger (every 15 min):
 *   sync-fx-rates (3) -> sync-stablecoins (4) -> snapshots (0)
 *   -> supply snapshots (0)
 *
 * All jobs run sequentially in-slot to avoid cross-job connection spikes.
 * Run FX first so Chainlink gets a clean RPC window before the heavier
 * stablecoin pricing pipeline consumes the slot's shared fetch budget.
 * Private V9 attribution, DDR, and V9 compilation use fenced follow-up lanes.
 * DDR intentionally runs after the heavy core slot so the quarter-hour trigger
 * does not spend its remaining wall-clock budget on D1-only resolver work.
 * The V9 fixed input (report-cards snapshot + peg-analytics publish) is
 * prepared on the half-hourly 16,46 chart slot (`prepare-safety-score-v9-input`,
 * after DEX publication), not in this quarter-hourly slot.
 */
import { syncStablecoins } from "../../cron/sync-stablecoins";
import {
  isPriceCorroborationSlot,
  runPriceCorroboration,
} from "../../cron/sync-stablecoins/price-corroboration";
import { syncFxRates } from "../../cron/sync-fx-rates";
import { snapshotSupply } from "../../cron/snapshot-supply";
import { snapshotChainSupply } from "../../cron/snapshot-chain-supply";
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
        coingeckoApiKey: runtime.coingeckoApiKey,
        chainRpcs: runtime.chainRpcs,
        reportProgress,
        jupiterApiKey: runtime.env.JUPITER_API_KEY,
      },
    ),
  );
  outcomes.push(stablecoinsOutcome.summary);
  const stablecoinsResult = stablecoinsOutcome.result;
  const stablecoinsCapabilities = parseStablecoinsCapabilities(stablecoinsResult);
  const stablecoinsCacheSafe = stablecoinsCapabilities.stablecoinsCache;
  if (stablecoinsCacheSafe && isPriceCorroborationSlot(runtime.slotStartedAt)) {
    try {
      const corroboration = await runPriceCorroboration({
        db: runtime.db,
        syncStartSec: runtime.slotStartedAt,
        signal: runtime.slotSignal,
        cmcApiKey: runtime.env.CMC_API_KEY,
        jupiterApiKey: runtime.env.JUPITER_API_KEY,
        coingeckoApiKey: runtime.coingeckoApiKey,
        addressProvider: {
          enabledProviders: runtime.env.ADDRESS_PRICE_PROVIDERS_ENABLED,
          cgApiKey: runtime.coingeckoApiKey,
        },
      });
      logWorkerEventArgs(
        "handler",
        "info",
        `[price-corroboration] refreshed ${corroboration.cacheEntriesWritten}/${corroboration.cohortSize} low-depth price-cache rows`,
      );
    } catch (error) {
      logWorkerEventArgs(
        "handler",
        "warn",
        "[price-corroboration] hourly best-effort step failed after stablecoin publication:",
        error,
      );
    }
  }
  if (stablecoinsResult && !stablecoinsCacheSafe) {
    logWorkerEventArgs("handler", "warn", "[cron] sync-stablecoins completed without downstream-safe cache write — skipping cache-dependent jobs");
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
  return buildScheduledSlotSummary(outcomes);
}

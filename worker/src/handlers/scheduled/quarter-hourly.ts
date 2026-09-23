import { logWorkerEventArgs } from "../../lib/structured-log";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
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
import { syncFxRates } from "../../cron/sync-fx-rates";
import { snapshotSupply } from "../../cron/snapshot-supply";
import { snapshotChainSupply } from "../../cron/snapshot-chain-supply";
import { snapshotPsiDaily } from "../../cron/snapshot-psi";
import { snapshotPublicDataset } from "../../cron/snapshot-public-dataset";
import { createNeutralSkippedCronResult } from "../../lib/cron-result";
import type { CronResult } from "../../lib/cron-logger";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { parseStablecoinsCapabilities, type ScheduledRuntimeContext } from "./context";
import { runBestEffortScheduledJobWithOutcome } from "./run-best-effort-job";
import {
  buildScheduledSlotSummary,
  summarizeSkippedScheduledJob,
  type ScheduledSlotJobSummary,
} from "./slot-summary";
import { logSkippedCronRun } from "./preflight-skip";

const SAME_DAY_CATCH_UP_REASON = "same_day_catch_up";
const BEFORE_DAILY_SLOT_REASON = "before_daily_slot";
const DAILY_SLOT_OFFSET_SECONDS = 8 * 3600; // daily0800Utc

function currentUtcDay(slotStartedAt: number) {
  const todayMidnight = bucketUnixSecondsToUtcDay(slotStartedAt);
  return {
    todayMidnight,
    snapshotDate: new Date(todayMidnight * 1000).toISOString().slice(0, 10),
    // The preferred 08:00 attempt owns the day until it has had its turn; a
    // catch-up before that would claim the write-once public snapshot with a
    // midnight cache and bypass the daily0800Utc freshness gate.
    dailySlotStartedAt: todayMidnight + DAILY_SLOT_OFFSET_SECONDS,
  };
}

async function hasPsiDailySnapshot(db: D1Database, computedAt: number): Promise<boolean> {
  // Same-day precheck read. Idempotent SELECT: a transient D1 overload here
  // must be retried, not recorded as the job's error run (a failed read
  // proves nothing about the period either way — R2).
  const row = await runWithOverloadRetry(() =>
    db
      .prepare("SELECT 1 AS present FROM stability_index WHERE computed_at = ? LIMIT 1")
      .bind(computedAt)
      .first<{ present: number }>(),
  );
  return row?.present === 1;
}

async function hasPublicDatasetSnapshot(db: D1Database, snapshotDate: string): Promise<boolean> {
  // Same-day precheck read; see hasPsiDailySnapshot.
  const row = await runWithOverloadRetry(() =>
    db
      .prepare("SELECT 1 AS present FROM public_snapshots WHERE snapshot_date = ? LIMIT 1")
      .bind(snapshotDate)
      .first<{ present: number }>(),
  );
  return row?.present === 1;
}

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
  if (stablecoinsResult && !stablecoinsCacheSafe) {
    logWorkerEventArgs("handler", "warn", "[cron] sync-stablecoins completed without downstream-safe cache write — skipping cache-dependent jobs");
  }

  type ScheduledJobFn = Parameters<typeof runBestEffortScheduledJobWithOutcome>[3];

  // `notDue` answers whether the job has work this slot (not yet due, or the
  // period's write-once output already exists). Only a job with work is gated
  // on the stablecoins cache: recording an unsafe cache as the degraded
  // outcome of an already-completed period would misreport that period.
  const runIfCacheSafe = async (
    job: string,
    fn: ScheduledJobFn,
    notDue?: () => Promise<CronResult | null>,
  ): Promise<void> => {
    if (notDue) {
      // A failed due-check read proves nothing about the period: record it as
      // this job's error outcome instead of assuming the output is missing.
      let neutral: CronResult | null = null;
      let checkError: unknown = null;
      try {
        neutral = await notDue();
      } catch (error) {
        checkError = error;
      }
      if (neutral || checkError) {
        outcomes.push((await runBestEffortScheduledJobWithOutcome(runtime, "quarter-hour slot", job, async () => {
          if (checkError) throw checkError;
          return neutral!;
        })).summary);
        return;
      }
    }
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
  await runIfCacheSafe(
    "snapshot-psi",
    (signal) => snapshotPsiDaily(runtime.db, signal, { completionReason: SAME_DAY_CATCH_UP_REASON }),
    async () => {
      const { todayMidnight, dailySlotStartedAt } = currentUtcDay(runtime.slotStartedAt);
      const computedAt = todayMidnight - DAY_SECONDS;
      if (runtime.slotStartedAt < dailySlotStartedAt) {
        return createNeutralSkippedCronResult(BEFORE_DAILY_SLOT_REASON, { computedAt, dailySlotStartedAt });
      }
      if (await hasPsiDailySnapshot(runtime.db, computedAt)) {
        return createNeutralSkippedCronResult("same_day_snapshot_exists", { computedAt });
      }
      return null;
    },
  );
  const { snapshotDate, dailySlotStartedAt } = currentUtcDay(runtime.slotStartedAt);
  await runIfCacheSafe(
    "snapshot-public-dataset",
    (signal) => snapshotPublicDataset(runtime.db, signal, {
      completionReason: SAME_DAY_CATCH_UP_REASON,
      minStablecoinsCacheUpdatedAtSec: dailySlotStartedAt,
      freshnessGateLabel: "daily0800Utc",
    }),
    async () => {
      if (runtime.slotStartedAt < dailySlotStartedAt) {
        return createNeutralSkippedCronResult(BEFORE_DAILY_SLOT_REASON, { snapshotDate, dailySlotStartedAt });
      }
      if (await hasPublicDatasetSnapshot(runtime.db, snapshotDate)) {
        return createNeutralSkippedCronResult("same_day_snapshot_exists", { snapshotDate });
      }
      return null;
    },
  );
  return buildScheduledSlotSummary(outcomes);
}

import { DAY_SECONDS } from "./time-constants";

/**
 * Cadence lengths (and slot offsets) for every cron lane.
 *
 * Split out of `cron-jobs.ts` so the Safety Score v9 evaluator can bind its
 * evidence-freshness bounds to real producer cadence without pinning the whole
 * schedule authority into the evaluation-build manifest. `cron-jobs.ts` remains
 * the ADR-7 schedule authority (expressions, trigger topology, job table,
 * connection budgets) and imports these numbers back, so every cadence value is
 * still authored exactly once.
 *
 * Editing a value here is a real evidence-freshness change and *should* rotate
 * the Safety Score v9 evaluation-build digest. Editing a cron expression, label,
 * or connection budget in `cron-jobs.ts` must not.
 */
export const CRON_SCHEDULE_CADENCES = {
  quarterHourly: { intervalSec: 900, offsetSec: 0 },
  v9SupplyAttributionOffset: { intervalSec: 900, offsetSec: 8 * 60 },
  depegResolverOffset: { intervalSec: 900, offsetSec: 13 * 60 },
  v9PublicationOffset: { intervalSec: 1800, offsetSec: 22 * 60 },
  statusSelfCheckOffset: { intervalSec: 900, offsetSec: 9 * 60 },
  sixHourlyBlacklist: { intervalSec: 6 * 3600, offsetSec: 3 * 60 },
  halfHourlyMintBurnCritical: { intervalSec: 1800, offsetSec: 4 * 60 },
  twoHourlyDexDiscovery: { intervalSec: 2 * 3600, offsetSec: 6 * 60 },
  halfHourlyMintBurnExtended: { intervalSec: 1800, offsetSec: 18 * 60 },
  halfHourlyMeasuredExecution: { intervalSec: 1800, offsetSec: 0 },
  halfHourlyOffset: { intervalSec: 3600, offsetSec: 10 * 60 },
  halfHourlyChartsOffset: { intervalSec: 1800, offsetSec: 16 * 60 },
  dewsPsiOffset: { intervalSec: 1800, offsetSec: 26 * 60 },
  fourHourlyReserveSync: { intervalSec: 4 * 3600, offsetSec: 11 * 60 },
  hourlyYieldSync: { intervalSec: 3600, offsetSec: 55 * 60 },
  fourHourlyYieldSupplemental: { intervalSec: 4 * 3600, offsetSec: 25 * 60 },
  fiveMinuteTelegramAlerts: { intervalSec: 300, offsetSec: 2 * 60 },
  fiveMinuteReserveRecovery: { intervalSec: 300, offsetSec: 60 },
  digestTriggerPoll: { intervalSec: 300, offsetSec: 0 },
  daily0300Utc: { intervalSec: DAY_SECONDS, offsetSec: 3 * 3600 },
  daily0800Utc: { intervalSec: DAY_SECONDS, offsetSec: 8 * 3600 },
  daily0805Utc: { intervalSec: DAY_SECONDS, offsetSec: 8 * 3600 + 5 * 60 },
  daily0810Utc: { intervalSec: DAY_SECONDS, offsetSec: 8 * 3600 + 10 * 60 },
  monthlyYieldAudit: { intervalSec: 30 * 86400, offsetSec: 6 * 3600 },
} as const;

export function isHourlyDexPriceSlot(slotStartedAtSec: number): boolean {
  return new Date(slotStartedAtSec * 1_000).getUTCMinutes() === 16;
}

export function isDexLiquidityPublicationSlot(slotStartedAtSec: number): boolean {
  const slot = new Date(slotStartedAtSec * 1_000);
  return slot.getUTCMinutes() === 16 && slot.getUTCHours() % 2 === 0;
}

export function isDailyDexShadowTargetPublicationSlot(slotStartedAtSec: number): boolean {
  const slot = new Date(slotStartedAtSec * 1_000);
  return slot.getUTCMinutes() === 16 && slot.getUTCHours() === 6;
}

/**
 * Producer cadences the Safety Score v9 fact-set extension binds evidence
 * freshness to. Kept beside the cadence table (rather than reading
 * `CRON_INTERVALS`) so the evaluator pins this module instead of the whole
 * schedule authority.
 *
 * `shared/lib/__tests__/cron-cadences.test.ts` asserts every entry equals
 * `CRON_INTERVALS[job]`, so a producer moving to a different lane fails CI
 * rather than silently leaving the evaluator on the old cadence.
 */
export const V9_EVIDENCE_PRODUCER_INTERVAL_SEC = {
  "sync-live-reserves": CRON_SCHEDULE_CADENCES.fourHourlyReserveSync.intervalSec,
  "sync-stablecoins": CRON_SCHEDULE_CADENCES.quarterHourly.intervalSec,
  "sync-dex-liquidity": CRON_SCHEDULE_CADENCES.twoHourlyDexDiscovery.intervalSec,
  "sync-redemption-backstops": CRON_SCHEDULE_CADENCES.fourHourlyReserveSync.intervalSec,
} as const;

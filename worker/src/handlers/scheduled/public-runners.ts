import type { CronScheduleKey } from "@shared/lib/cron-jobs";
import type { SlotRunnerLoader } from "./runner-types";

// Compile-time import boundary, not a second schedule/ownership authority.
// Static runner imports would initialize every public workload on first entry;
// defer each registry-selected runner until its fenced invocation is admitted.
export const PUBLIC_SLOT_RUNNER_LOADERS = {
  quarterHourly: () => import("./quarter-hourly").then((mod) => mod.runQuarterHourlySlot),
  depegResolverOffset: () => import("./depeg-resolver").then((mod) => mod.runDepegResolverSlot),
  statusSelfCheckOffset: () => import("./status-self-check").then((mod) => mod.runStatusSelfCheckSlot),
  sixHourlyBlacklist: () => import("./hourly-blacklist").then((mod) => mod.runSixHourlyBlacklistSlot),
  halfHourlyMintBurnCritical: () =>
    import("./twenty-minute-mint-burn-critical").then((mod) => mod.runHalfHourlyMintBurnCriticalSlot),
  twoHourlyDexDiscovery: () =>
    import("./thirty-minute-dex-discovery").then((mod) => mod.runTwoHourlyDexDiscoverySlot),
  halfHourlyMintBurnExtended: () =>
    import("./twenty-minute-mint-burn-extended").then((mod) => mod.runHalfHourlyMintBurnExtendedSlot),
  halfHourlyMeasuredExecution: () =>
    import("./half-hourly-measured-execution").then((mod) => mod.runHalfHourlyMeasuredExecutionSlot),
  halfHourlyMeasuredExecutionSupplemental: () =>
    import("./half-hourly-measured-execution").then((mod) => mod.runSupplementalMeasuredExecutionSlot),
  halfHourlyOffset: () => import("./half-hourly").then((mod) => mod.runHalfHourlySlot),
  dewsPsiOffset: () => import("./dews-psi").then((mod) => mod.runDewsPsiSlot),
  fourHourlyReserveSync: () => import("./hourly-live-reserves").then((mod) => mod.runFourHourlyReserveSyncSlot),
  hourlyYieldSync: () => import("./hourly-yield").then((mod) => mod.runHourlyYieldSlot),
  fourHourlyYieldSupplemental: () => import("./yield-supplemental").then((mod) => mod.runYieldSupplementalSlot),
  fiveMinuteTelegramAlerts: () => import("./five-minute-telegram").then((mod) => mod.runFiveMinuteTelegramSlot),
  fiveMinuteReserveRecovery: () => import("./reserve-recovery").then((mod) => mod.runFiveMinuteReserveRecoverySlot),
  digestTriggerPoll: () => import("./digest-trigger-poll").then((mod) => mod.runDigestTriggerPollSlot),
  daily0300Utc: () => import("./daily-0300").then((mod) => mod.runDaily0300Slot),
  daily0800Utc: () => import("./daily-0800").then((mod) => mod.runDaily0800Slot),
  daily0805Utc: () => import("./daily-0805").then((mod) => mod.runDaily0805Slot),
  daily0810Utc: () => import("./daily-0810").then((mod) => mod.runDaily0810Slot),
  monthlyYieldAudit: () => import("./monthly-yield-audit").then((mod) => mod.runMonthlyYieldAuditSlot),
} satisfies Partial<Record<CronScheduleKey, SlotRunnerLoader>>;

import type { CronScheduleKey } from "@shared/lib/cron-jobs";
import { getScheduledTaskDescriptor, SCHEDULED_SLOT_PLANS, type ScheduledWorkerRole } from "@shared/lib/scheduled-runner-registry";
import {
  createLeaseOwner,
  runCronWithLease,
  type CronLeaseOptions,
} from "../../lib/cron-lease-primitives";
import {
  createSlotDeadline,
  getCronTimeoutBudgetMetadata,
  resolveCronTimeoutBudget,
  type SlotDeadline,
} from "../../lib/cron-timeouts";
import { logCronRun, type CronProgressReporter, type CronResult } from "../../lib/cron-logger";
import { normalizeCgApiKey } from "../../lib/coingecko";
import { buildChainRpcs, type ChainRpcConfig } from "../../lib/chain-registry";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { shouldAttemptFetch } from "../../lib/circuit-breaker";
import { flushDwellirCredits, loadDwellirBudgetState } from "../../lib/rpc-provider-budget";
import { createDwellirNativeCapability, type DwellirNativeCapability } from "../../lib/dwellir-native";
import { logWorkerEvent } from "../../lib/structured-log";
import { normalizeCronMetadataWithLease } from "../../lib/cron-metadata";
import { parseCsvEnv, type ScheduledEnv } from "../../lib/env";
import {
  resolveMintBurnFreshnessConfig,
  type MintBurnFreshnessConfig,
} from "../../lib/mint-burn-health-config";
import type { ScheduledRecoveryCheckpoint } from "../../lib/scheduled-recovery-checkpoint";
import { utcCalendarMonth, type ProducerIdentity } from "../../lib/producer-history";
import { ScheduledFetchBudget } from "../../lib/scheduled-fetch-budget";
import {
  createReserveLeaseOwner,
  RESERVE_PRODUCER_FINALIZATION_MARGIN_MS,
  RESERVE_PRODUCER_WAIT_MAX_MS,
} from "../../lib/reserve-producer-priority";
import { resolveLiveReserveSyncBudgetConfig } from "../../cron/sync-live-reserves-config";
import type { CronLeaseRunResult } from "../../lib/cron-lease-primitives";

/**
 * Per-job overrides for cron lease behavior. Jobs not listed use the default
 * policy in `runCronWithLease` (heartbeatSec = ttlSec/3, maxRenewFailures = 2).
 * Long-running scheduled jobs use a tighter heartbeat so lease-loss detection
 * happens within the job's own timeout window instead of near the outer TTL.
 */
const LONG_RUNNING_LEASE_OPTIONS = { heartbeatSec: 30, maxRenewFailures: 3 } satisfies Pick<
  CronLeaseOptions,
  "heartbeatSec" | "maxRenewFailures"
>;

const PER_JOB_LEASE_OPTIONS: Record<string, Pick<CronLeaseOptions, "heartbeatSec" | "maxRenewFailures">> = {
  "sync-stablecoins": LONG_RUNNING_LEASE_OPTIONS,
  "sync-live-reserves": LONG_RUNNING_LEASE_OPTIONS,
  "reserve-recovery": LONG_RUNNING_LEASE_OPTIONS,
  "sync-cl-exit-depth": LONG_RUNNING_LEASE_OPTIONS,
  "sync-dex-liquidity-stage": LONG_RUNNING_LEASE_OPTIONS,
  "sync-dex-liquidity": LONG_RUNNING_LEASE_OPTIONS,
  "sync-dex-discovery": LONG_RUNNING_LEASE_OPTIONS,
  "sync-yield-data": LONG_RUNNING_LEASE_OPTIONS,
  "sync-yield-supplemental": LONG_RUNNING_LEASE_OPTIONS,
  "sync-blacklist": LONG_RUNNING_LEASE_OPTIONS,
  "sync-mint-burn": LONG_RUNNING_LEASE_OPTIONS,
  "sync-mint-burn-extended": LONG_RUNNING_LEASE_OPTIONS,
  "dispatch-telegram-alerts": LONG_RUNNING_LEASE_OPTIONS,
  "snapshot-public-dataset": LONG_RUNNING_LEASE_OPTIONS,
  "sync-v9-supply-attribution": LONG_RUNNING_LEASE_OPTIONS,
  "daily-digest": LONG_RUNNING_LEASE_OPTIONS,
  "weekly-recap": LONG_RUNNING_LEASE_OPTIONS,
};

/**
 * Contract C (Dwellir trial): `runtime.chainRpcs` is always built without
 * Dwellir, and each runtime opts into the supplemental endpoints at most once,
 * keyed by its own chainRpcs Map. Every failure mode is fail-closed — an
 * unreadable ledger, an exhausted budget, an open circuit, or an unexpected
 * error leaves `chainRpcs` registry-only.
 */
const dwellirEnablementByChainRpcs = new WeakMap<Map<string, ChainRpcConfig>, Promise<void>>();

async function applyDwellirEndpoints(runtime: ScheduledRuntimeContext): Promise<void> {
  const apiKey = runtime.env.DWELLIR_API_KEY;
  if (!apiKey?.trim()) return;
  const budget = await loadDwellirBudgetState(runtime.db, runtime.env, Math.floor(Date.now() / 1000));
  if (!budget.usable) return;
  if (!(await shouldAttemptFetch(runtime.db, CIRCUIT_SOURCE.DWELLIR_EVM))) return;

  const keyedChainRpcs = buildChainRpcs(runtime.env.ALCHEMY_API_KEY, runtime.env.DRPC_API_KEY, {
    dwellirApiKey: runtime.env.DWELLIR_API_KEY,
  });
  // Copied in place so every holder of this runtime's Map observes the
  // supplemental endpoints, and the registry configs keep the same operators
  // in the same order (Dwellir only ever appends after them).
  for (const [chainId, config] of keyedChainRpcs) {
    runtime.chainRpcs.set(chainId, config);
  }
  // Native readers share this exact admission decision; no second authority.
  runtime.dwellirNative = createDwellirNativeCapability(apiKey);
}

function ensureDwellirEndpointsEnabled(runtime: ScheduledRuntimeContext): Promise<void> {
  const chainRpcs = runtime.chainRpcs;
  const pending = dwellirEnablementByChainRpcs.get(chainRpcs);
  if (pending) return pending;

  const enablement = applyDwellirEndpoints(runtime).catch((error: unknown) => {
    logWorkerEvent({
      scope: "handler",
      level: "warn",
      event: "dwellir_runtime_enablement_failed",
      message: "Dwellir supplemental RPC endpoints stayed disabled for this runtime",
      provider: "dwellir",
      error,
    });
  });
  dwellirEnablementByChainRpcs.set(chainRpcs, enablement);
  return enablement;
}

export interface ScheduledRuntimeContext {
  db: D1Database;
  env: ScheduledEnv;
  ctx: ExecutionContext;
  cron: string;
  scheduleKey: CronScheduleKey;
  workerRole?: ScheduledWorkerRole;
  scheduledTimeMs: number | null;
  slotStartedAt: number;
  deadline: SlotDeadline;
  slotSignal?: AbortSignal;
  slotBudgetStartedAtMs?: number;
  invocationId?: string;
  workerVersion?: string | null;
  jobAttemptNo?: number;
  producerKind?: string;
  fetchBudget?: ScheduledFetchBudget;
  recoveryCheckpoint?: ScheduledRecoveryCheckpoint;
  mintBurnDisabledIds: string[];
  mintBurnDisabledSymbols: string[];
  mintBurnFreshnessConfig: MintBurnFreshnessConfig;
  coingeckoApiKey: string | null;
  chainRpcs: Map<string, ChainRpcConfig>;
  dwellirNative?: DwellirNativeCapability;
  runLeasedCron: (
    job: string,
    fn: (signal: AbortSignal, reportProgress: CronProgressReporter) => Promise<CronResult | void>,
  ) => Promise<CronResult | void>;
  runBudgetOnlyTask?: <T>(
    job: string,
    fn: (signal: AbortSignal | undefined) => Promise<T>,
  ) => Promise<T>;
  getProducerIdentity?: (job: string) => ProducerIdentity;
}

export function getRuntimeProducerIdentity(
  runtime: ScheduledRuntimeContext,
  job: string,
): ProducerIdentity {
  const descriptor = getScheduledTaskDescriptor(runtime.scheduleKey, job);
  return {
    scheduleKey: runtime.scheduleKey,
    job,
    producerPath: descriptor.producerPath,
    producerKind: runtime.producerKind ?? descriptor.producerKind,
    invocationId: runtime.invocationId ?? `scheduled:${runtime.scheduleKey}:${runtime.slotStartedAt}`,
    workerVersion: runtime.workerVersion ?? null,
    slotStartedAt: runtime.slotStartedAt,
    calendarPeriod: descriptor.calendarIdentity === "utc-month"
      ? utcCalendarMonth(runtime.slotStartedAt)
      : null,
  };
}

export function runRuntimeBudgetOnlyTask<T>(
  runtime: ScheduledRuntimeContext,
  job: string,
  fn: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  return runtime.runBudgetOnlyTask
    ? runtime.runBudgetOnlyTask(job, fn)
    : fn(runtime.slotSignal);
}

export function parseStablecoinsCapabilities(
  result: CronResult | null | void,
): { stablecoinsCache: boolean; depegPipeline: boolean } {
  if (!result?.metadata) {
    return {
      stablecoinsCache: false,
      depegPipeline: false,
    };
  }

  try {
    const parsed = JSON.parse(result.metadata) as {
      downstreamSafe?: unknown;
      capabilities?: { stablecoinsCache?: unknown; depegPipeline?: unknown };
    };
    return {
      stablecoinsCache:
        parsed.capabilities?.stablecoinsCache === true ||
        (parsed.capabilities?.stablecoinsCache == null && parsed.downstreamSafe === true),
      depegPipeline: parsed.capabilities?.depegPipeline === true,
    };
  } catch {
    // Expected for older cron rows and human-readable metadata strings.
    return {
      stablecoinsCache: false,
      depegPipeline: false,
    };
  }
}

export interface ScheduledRuntimeInit {
  cron: string;
  scheduleKey: CronScheduleKey;
  workerRole?: ScheduledWorkerRole;
  scheduledTimeMs: number | null;
  slotStartedAt: number;
  slotBudgetStartedAtMs?: number;
  deadline?: SlotDeadline;
  parentSignal?: AbortSignal;
  jobAttemptNo?: number;
  producerKind?: string;
  recoveryCheckpoint?: ScheduledRecoveryCheckpoint;
}

export function createScheduledRuntimeContext(
  env: ScheduledEnv,
  ctx: ExecutionContext,
  scheduled: ScheduledRuntimeInit,
): ScheduledRuntimeContext {
  const db = env.DB;
  const mintBurnDisabledIds = parseCsvEnv(env.MINT_BURN_DISABLED_IDS);
  const mintBurnDisabledSymbols = parseCsvEnv(env.MINT_BURN_DISABLED_SYMBOLS);
  const mintBurnFreshnessConfig = resolveMintBurnFreshnessConfig(env);
  const coingeckoApiKey = normalizeCgApiKey(env.COINGECKO_API_KEY);
  const chainRpcs = buildChainRpcs(env.ALCHEMY_API_KEY, env.DRPC_API_KEY);
  const slotBudgetStartedAtMs = scheduled.slotBudgetStartedAtMs ?? Date.now();
  const invocationId = scheduled.recoveryCheckpoint?.invocationId ?? createLeaseOwner(`scheduled:${scheduled.scheduleKey}`);
  const workerVersion = env.CF_VERSION_METADATA?.id || null;
  const jobAttemptNo = scheduled.jobAttemptNo ?? 1;
  const producerKind = scheduled.producerKind ?? "scheduled-job";
  const fetchBudget = new ScheduledFetchBudget();
  const slotAbortSignal = scheduled.parentSignal;

  const runtime: ScheduledRuntimeContext = {
    db,
    env,
    ctx,
    cron: scheduled.cron,
    scheduleKey: scheduled.scheduleKey,
    workerRole: scheduled.workerRole ?? SCHEDULED_SLOT_PLANS[scheduled.scheduleKey].worker,
    scheduledTimeMs: scheduled.scheduledTimeMs,
    slotStartedAt: scheduled.slotStartedAt,
    slotBudgetStartedAtMs,
    deadline: scheduled.deadline ?? createSlotDeadline(slotBudgetStartedAtMs),
    invocationId,
    workerVersion,
    jobAttemptNo,
    producerKind,
    fetchBudget,
    ...(scheduled.recoveryCheckpoint ? { recoveryCheckpoint: scheduled.recoveryCheckpoint } : {}),
    mintBurnDisabledIds,
    mintBurnDisabledSymbols,
    mintBurnFreshnessConfig,
    coingeckoApiKey,
    chainRpcs,
    runLeasedCron: async (job, fn) => {
      const descriptor = getScheduledTaskDescriptor(scheduled.scheduleKey, job);
      if (!descriptor.statusTracked) {
        throw new Error(`${scheduled.scheduleKey}/${job} is budget-only and cannot use runLeasedCron`);
      }
      const timeoutBudget = resolveCronTimeoutBudget(job, { slotBudgetStartedAtMs });
      const timeoutBudgetMetadata = getCronTimeoutBudgetMetadata(timeoutBudget);
      const combinedSlotSignal = runtime.slotSignal && slotAbortSignal
        ? AbortSignal.any([runtime.slotSignal, slotAbortSignal])
        : runtime.slotSignal ?? slotAbortSignal;

      return fetchBudget.run(descriptor.maxConnections, combinedSlotSignal, async () => {
        // Contract C: opt this runtime into the Dwellir supplemental endpoints
        // (memoized, fail-closed) before the job body can read chainRpcs.
        await ensureDwellirEndpointsEnabled(runtime);
        try {
          return await logCronRun(db, job, async (signal, reportProgress): Promise<CronResult> => {
            const slotMeta = {
              slotStartedAt: scheduled.slotStartedAt,
              scheduleKey: scheduled.scheduleKey,
              producerPath: descriptor.producerPath,
              invocationId,
              workerVersion,
              attemptNo: jobAttemptNo,
              producerKind,
            };
            const reserveFamily = job === "sync-live-reserves" || job === "reserve-recovery" || scheduled.recoveryCheckpoint != null;
            const leaseOwner = reserveFamily
              ? createReserveLeaseOwner(createLeaseOwner(job),
                scheduled.recoveryCheckpoint ? "reserve-recovery" : job,
                scheduled.recoveryCheckpoint ? "reserve-checkpoint-replay" : descriptor.producerPath,
                { ...slotMeta, producerKind })
              : createLeaseOwner(job);
            const perJobLeaseOptions = PER_JOB_LEASE_OPTIONS[job] ?? {};
            const buildLeaseMeta = (lease: CronLeaseRunResult<unknown>) => ({
              leaseOwner: lease.leaseOwner,
              renewFailures: lease.renewFailures,
              leaseLost: lease.leaseLost ?? false,
              leaseTtlSec: lease.leaseTtlSec,
              leaseHeartbeatSec: lease.leaseHeartbeatSec,
              leaseMaxRenewFailures: lease.leaseMaxRenewFailures,
              leaseRenewAttempts: lease.leaseRenewAttempts,
              leaseRenewSuccesses: lease.leaseRenewSuccesses,
              leaseRenewFailuresTotal: lease.leaseRenewFailuresTotal,
              leaseLastRenewedAt: lease.leaseLastRenewedAt,
              blockedBy: lease.blockedBy ?? null,
              leaseWaitDurationMs: lease.leaseWaitDurationMs ?? 0,
              leaseAcquisitionAttempts: lease.leaseAcquisitionAttempts ?? 1,
              ...(timeoutBudgetMetadata ? { timeoutBudget: timeoutBudgetMetadata } : {}),
              ...slotMeta,
            });
            const leaseOptions: CronLeaseOptions = {
              owner: leaseOwner,
              abortSignal: signal,
              timeoutBudget,
              ...perJobLeaseOptions,
            };
            if (scheduled.recoveryCheckpoint) leaseOptions.reserveRecoveryAdmission = true;
            if (job === "sync-live-reserves" && scheduled.scheduleKey === "fourHourlyReserveSync"
              && producerKind === "scheduled-job" && !scheduled.recoveryCheckpoint) {
              const nowMs = Date.now();
              const reservationMs = resolveLiveReserveSyncBudgetConfig().runBudgetMs + RESERVE_PRODUCER_FINALIZATION_MARGIN_MS;
              leaseOptions.acquisitionWait = {
                deadlineMs: Math.min(nowMs + RESERVE_PRODUCER_WAIT_MAX_MS,
                  nowMs + timeoutBudget.effectiveTimeoutMs - reservationMs,
                  (timeoutBudget.slotControlledDeadlineMs ?? Infinity) - reservationMs),
                onWait: (blockedBy, attempts) => reportProgress({
                  stage: "waiting-for-reserve-lease", message: "Waiting for the existing reserve writer to settle",
                  leaseOwner, metadata: { ...slotMeta, blockedBy, leaseAcquisitionAttempts: attempts },
                }),
              };
            }
            const lease = await runCronWithLease(db, job, async ({ signal: leaseSignal }) => {
              await reportProgress({
                stage: "started",
                message: `Starting ${job}`,
                leaseOwner,
                metadata: slotMeta,
              });
              await reportProgress({
                stage: "lease-acquired",
                message: `Lease acquired for ${job}`,
                leaseOwner,
                metadata: slotMeta,
              });
              return fn(leaseSignal, reportProgress);
            }, leaseOptions);

            if (lease.status === "skipped_neutral") {
              return {
                status: "skipped_neutral",
                metadata: JSON.stringify({ reason: lease.producerPriority!.reason,
                  producerPriority: lease.producerPriority, ...buildLeaseMeta(lease) }),
              };
            }
            if (lease.status === "skipped_locked") {
              await reportProgress({
                stage: "skipped-locked",
                message: `Lease already held for ${job}`,
                leaseOwner: lease.leaseOwner,
                metadata: slotMeta,
              });
              return {
                status: "skipped_locked",
                metadata: JSON.stringify({
                  reason: "lease-locked",
                  ...buildLeaseMeta(lease),
                }),
              };
            }

            const result = lease.result;
            if (!result) {
              return {
                metadata: JSON.stringify({
                  ...buildLeaseMeta(lease),
                }),
              };
            }

            const leaseMeta = buildLeaseMeta(lease);

            const metadata = normalizeCronMetadataWithLease(result, leaseMeta);

            await reportProgress({
              stage: "completed",
              message: `Completed ${job}`,
              leaseOwner: lease.leaseOwner,
              metadata: slotMeta,
            });

            return { ...result, metadata };
          }, {
            slotStartedAt: scheduled.slotStartedAt,
            timeoutBudget,
            abortSignal: combinedSlotSignal,
            producer: {
              ...getRuntimeProducerIdentity(runtime, job),
            },
          });
        } finally {
          // Contract C: drain this isolate's Dwellir credits after the job body
          // settles; flushing never throws, so it cannot change the job result.
          await flushDwellirCredits(db, Math.floor(Date.now() / 1000));
        }
      });
    },
    runBudgetOnlyTask: (job, fn) => {
      const descriptor = getScheduledTaskDescriptor(scheduled.scheduleKey, job);
      if (descriptor.statusTracked) {
        throw new Error(`${scheduled.scheduleKey}/${job} is status-tracked and cannot use runBudgetOnlyTask`);
      }
      const combinedSignal = runtime.slotSignal && slotAbortSignal
        ? AbortSignal.any([runtime.slotSignal, slotAbortSignal])
        : runtime.slotSignal ?? slotAbortSignal;
      return fetchBudget.run(descriptor.maxConnections, combinedSignal, () => fn(combinedSignal));
    },
    getProducerIdentity: (job) => getRuntimeProducerIdentity(runtime, job),
  };
  return runtime;
}

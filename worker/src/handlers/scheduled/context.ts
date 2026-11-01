import type { ReserveContinuationMessage } from "@shared/types/reserve-continuation";
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
  assertSlotDeadline,
  SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS,
} from "../../lib/cron-timeouts";
import { logCronRun, type CronProgressReporter, type CronResult } from "../../lib/cron-logger";
import { normalizeCgApiKey } from "../../lib/coingecko";
import { buildChainRpcs, type ChainRpcConfig } from "../../lib/chain-registry";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { shouldAttemptFetch } from "../../lib/circuit-breaker";
import { flushDwellirCredits, loadDwellirBudgetState } from "../../lib/rpc-provider-budget";
import { settleAfterAbort, retainUntilDeadline, CRON_ABORT_GRACE_MS, CRON_ABORT_OBSERVATION_MARGIN_MS } from "../../lib/cron-abort-settlement";
import { createDwellirNativeCapability, type DwellirNativeCapability } from "../../lib/dwellir-native";
import { logWorkerEvent } from "../../lib/structured-log";
import { normalizeCronMetadataWithLease } from "../../lib/cron-metadata";
import { parseCsvEnv, parseDwellirRoutingDisabledChains, type ScheduledEnv } from "../../lib/env";
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
import type { ScheduledExecutionFence, ScheduledSlotCatchUpRequest } from "../../lib/scheduled-slot-fence";

/**
 * Contract C: each scheduled runtime starts without Dwellir and admits routing
 * at most once. Unreadable ledger, exhausted budget, unavailable circuit, or
 * unexpected errors leave the original endpoint map unchanged.
 */
const dwellirEnablementByChainRpcs = new WeakMap<Map<string, ChainRpcConfig>, Promise<void>>();

async function applyDwellirEndpoints(runtime: ScheduledRuntimeContext): Promise<void> {
  const apiKey = runtime.env.DWELLIR_API_KEY;
  if (!apiKey?.trim()) return;
  const budget = await loadDwellirBudgetState(runtime.db, runtime.env, Math.floor(Date.now() / 1000));
  if (!budget.usable) return;
  if (!(await shouldAttemptFetch(runtime.db, CIRCUIT_SOURCE.DWELLIR_EVM))) return;

  const disabledChains = parseDwellirRoutingDisabledChains(runtime.env.DWELLIR_ROUTING_DISABLED_CHAINS);
  const keyedChainRpcs = buildChainRpcs(runtime.env.ALCHEMY_API_KEY, runtime.env.DRPC_API_KEY, {
    dwellirApiKey: runtime.env.DWELLIR_API_KEY,
    dwellirRoutingDisabledChains: disabledChains,
  });
  // Copied in place so every holder observes the same admitted routing policy.
  for (const [chainId, config] of keyedChainRpcs) {
    runtime.chainRpcs.set(chainId, config);
  }
  // Native readers share this exact admission decision; no second authority.
  runtime.dwellirNative = createDwellirNativeCapability(apiKey, disabledChains);
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
      message: "Dwellir RPC endpoints stayed disabled for this runtime",
      provider: "dwellir",
      error,
    });
  });
  dwellirEnablementByChainRpcs.set(chainRpcs, enablement);
  return enablement;
}

export interface ScheduledChildDeadline {
  /** Absolute end-to-end stop, including admission and terminal accounting. */
  deadline: SlotDeadline;
  deferredReason: string;
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
  executionFence?: ScheduledExecutionFence;
  slotBudgetStartedAtMs?: number;
  invocationId?: string;
  workerVersion?: string | null;
  jobAttemptNo?: number;
  producerKind?: string;
  fetchBudget?: ScheduledFetchBudget;
  recoveryCheckpoint?: ScheduledRecoveryCheckpoint;
  pendingReserveContinuation?: ReserveContinuationMessage;
  reserveQueueMetadata?: Record<string, string | number>;
  /** Set only for a Queue-executed catch-up of this missed slot. */
  catchUp?: ScheduledSlotCatchUpRequest;
  mintBurnDisabledIds: string[];
  mintBurnDisabledSymbols: string[];
  coingeckoApiKey: string | null;
  chainRpcs: Map<string, ChainRpcConfig>;
  dwellirNative?: DwellirNativeCapability;
  runLeasedCron: (
    job: string,
    fn: (signal: AbortSignal, reportProgress: CronProgressReporter) => Promise<CronResult | void>,
    bounded?: ScheduledChildDeadline,
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
    // Budget-only identities are canonical: the runtime's scheduled-job default
    // would never match the descriptor key /api/status reads.
    producerKind: descriptor.statusTracked
      ? runtime.producerKind ?? descriptor.producerKind
      : descriptor.producerKind,
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
  executionFence?: ScheduledExecutionFence;
  jobAttemptNo?: number;
  producerKind?: string;
  recoveryCheckpoint?: ScheduledRecoveryCheckpoint;
  catchUp?: ScheduledSlotCatchUpRequest;
}

export function createScheduledRuntimeContext(
  env: ScheduledEnv,
  ctx: ExecutionContext,
  scheduled: ScheduledRuntimeInit,
): ScheduledRuntimeContext {
  const db = env.DB;
  const mintBurnDisabledIds = parseCsvEnv(env.MINT_BURN_DISABLED_IDS);
  const mintBurnDisabledSymbols = parseCsvEnv(env.MINT_BURN_DISABLED_SYMBOLS);
  const coingeckoApiKey = normalizeCgApiKey(env.COINGECKO_API_KEY);
  const chainRpcs = buildChainRpcs(env.ALCHEMY_API_KEY, env.DRPC_API_KEY);
  const slotBudgetStartedAtMs = scheduled.deadline?.eventEntryMs ?? scheduled.slotBudgetStartedAtMs ?? Date.now();
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
    executionFence: scheduled.executionFence,
    invocationId,
    workerVersion,
    jobAttemptNo,
    producerKind,
    fetchBudget,
    ...(scheduled.recoveryCheckpoint ? { recoveryCheckpoint: scheduled.recoveryCheckpoint } : {}),
    ...(scheduled.catchUp ? { catchUp: scheduled.catchUp } : {}),
    mintBurnDisabledIds,
    mintBurnDisabledSymbols,
    coingeckoApiKey,
    chainRpcs,
    runLeasedCron: async (job, fn, bounded) => {
      const descriptor = getScheduledTaskDescriptor(scheduled.scheduleKey, job);
      if (!descriptor.statusTracked) {
        throw new Error(`${scheduled.scheduleKey}/${job} is budget-only and cannot use runLeasedCron`);
      }
      const controller = bounded ? new AbortController() : null;
      const deadline = bounded
        ? createSlotDeadline(runtime.deadline.eventEntryMs, Math.min(
          runtime.deadline.platformDeadlineMs,
          bounded.deadline.platformDeadlineMs - CRON_ABORT_GRACE_MS - CRON_ABORT_OBSERVATION_MARGIN_MS,
        ))
        : runtime.deadline;
      const stopError = bounded ? new Error(bounded.deferredReason) : null;
      const timeout = controller
        ? setTimeout(() => controller.abort(stopError), deadline.remainingMs())
        : undefined;
      const signals = [runtime.slotSignal, slotAbortSignal, controller?.signal]
        .filter((signal): signal is AbortSignal => signal != null);
      const combinedSlotSignal = signals.length > 0 ? AbortSignal.any(signals) : undefined;

      let childWork: Promise<CronResult | void> | undefined;
      const pending = fetchBudget.run(descriptor.maxConnections, combinedSlotSignal, async () => {
        // Contract C: opt this runtime into the Dwellir supplemental endpoints
        // (memoized, fail-closed) before the job body can read chainRpcs.
        await ensureDwellirEndpointsEnabled(runtime);
        // Only bounded tails need this pre-logger cancellation fence. Ordinary
        // exhausted jobs must retain logCronRun's controlled timeout accounting.
        if (bounded) assertSlotDeadline(deadline, combinedSlotSignal);
        const timeoutBudget = resolveCronTimeoutBudget(job, { deadline });
        const timeoutBudgetMetadata = getCronTimeoutBudgetMetadata(timeoutBudget);
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
              ...(runtime.reserveQueueMetadata ? { reserveQueue: runtime.reserveQueueMetadata } : {}),
              ...(runtime.catchUp ? { catchUp: runtime.catchUp } : {}),
            };
            const reserveFamily = job === "sync-live-reserves" || job === "reserve-recovery" || scheduled.recoveryCheckpoint != null;
            const leaseOwner = reserveFamily
              ? createReserveLeaseOwner(createLeaseOwner(job),
                scheduled.recoveryCheckpoint ? "reserve-recovery" : job,
                scheduled.recoveryCheckpoint ? "reserve-checkpoint-replay" : descriptor.producerPath,
                { ...slotMeta, producerKind })
              : createLeaseOwner(job);
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
              deadline,
              ...descriptor.leaseOptions,
            };
            if (scheduled.recoveryCheckpoint) leaseOptions.reserveRecoveryAdmission = true;
            if (job === "sync-live-reserves" && scheduled.scheduleKey === "fourHourlyReserveSync"
              && producerKind === "scheduled-job" && !scheduled.recoveryCheckpoint) {
              const nowMs = Date.now();
              const reservationMs = resolveLiveReserveSyncBudgetConfig().runBudgetMs + RESERVE_PRODUCER_FINALIZATION_MARGIN_MS;
              leaseOptions.acquisitionWait = {
                deadlineMs: Math.min(nowMs + RESERVE_PRODUCER_WAIT_MAX_MS,
                  nowMs + timeoutBudget.effectiveTimeoutMs - reservationMs,
                  runtime.deadline.latestAdmissionMs(0, reservationMs)),
                onWait: (blockedBy, attempts) => reportProgress({
                  stage: "waiting-for-reserve-lease", message: "Waiting for the existing reserve writer to settle",
                  leaseOwner, metadata: { ...slotMeta, blockedBy, leaseAcquisitionAttempts: attempts },
                }),
              };
            }
            const lease = await runCronWithLease(db, job, async ({ signal: leaseSignal }) => {
              // This update also persists the required attempt's lease owner;
              // unlike optional progress detail, it must precede child work.
              await reportProgress({
                stage: "started", message: `Starting ${job}`, leaseOwner, metadata: slotMeta,
              });
              await reportProgress({
                stage: "lease-acquired", message: `Lease acquired for ${job}`, leaseOwner, metadata: slotMeta,
              });
              assertSlotDeadline(deadline, leaseSignal);
              childWork = fn(leaseSignal, reportProgress);
              return childWork;
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
            executionFence: runtime.executionFence,
            jobAttemptNo,
            deadline,
            producer: {
              ...getRuntimeProducerIdentity(runtime, job),
            },
          });
        } finally {
          // Contract C: drain this isolate's Dwellir credits after the job body
          // settles; flushing never throws, so it cannot change the job result.
          await settleAfterAbort(
            () => flushDwellirCredits(db, Math.floor(Date.now() / 1000)),
            combinedSlotSignal
              ? AbortSignal.any([combinedSlotSignal, AbortSignal.timeout(deadline.remainingMs())])
              : AbortSignal.timeout(deadline.remainingMs()),
            { platformDeadlineMs: deadline.platformDeadlineMs },
          );
          // A bounded caller may already have moved to DB-only snapshots.
          // Keep its connection weight until the real provider work drains.
          if (bounded && childWork) await childWork.catch(() => undefined);
        }
      });
      if (!bounded || !controller) return pending;
      try {
        // Bound the entire invocation, not just RPC or the leased callback.
        // The pending invocation retains its fetch reservation until settlement.
        const outcome = await settleAfterAbort(() => pending, controller.signal, {
          observer: true, platformDeadlineMs: bounded.deadline.platformDeadlineMs,
        });
        if (outcome.status === "fulfilled") return outcome.value;
        if (outcome.status === "rejected") throw outcome.error;
        // Terminal accounting may still be in flight. Keep its original fence
        // and lease-retention rules; never clear a live/unsettled lease here.
        runtime.ctx.waitUntil(retainUntilDeadline(
          pending.catch(() => undefined),
          runtime.deadline.platformDeadlineMs + SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS,
        ));
        return {
          status: "degraded",
          metadata: JSON.stringify({ reason: bounded.deferredReason, retryOnNextDueTail: true }),
          productivity: { productive: false, reason: bounded.deferredReason },
        };
      } finally {
        clearTimeout(timeout);
      }
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

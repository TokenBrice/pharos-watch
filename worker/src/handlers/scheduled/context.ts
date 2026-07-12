import type { CronScheduleKey } from "@shared/lib/cron-jobs";
import { getScheduledTaskDescriptor } from "@shared/lib/scheduled-runner-registry";
import {
  createLeaseOwner,
  getCronTimeoutBudgetMetadata,
  resolveCronTimeoutBudget,
  runCronWithLease,
  type CronLeaseOptions,
} from "../../lib/cron-lease";
import { logCronRun, type CronProgressReporter, type CronResult } from "../../lib/cron-logger";
import { normalizeWebhookUrl, sendAlert } from "../../lib/alerts";
import { normalizeCgApiKey } from "../../lib/coingecko";
import { buildChainRpcs, type ChainRpcConfig } from "../../lib/chain-registry";
import { normalizeCronMetadata, mergeCronMetadataWithLease } from "../../lib/cron-metadata";
import { parseCsvEnv, type Env } from "../../lib/env";
import {
  createWorkerJobAttempt,
  finishWorkerJobAttempt,
  heartbeatWorkerJobAttempt,
  normalizeWorkerJobLedgerMode,
  recordWorkerJobAttemptLease,
  shouldRecordWorkerJobAttempt,
  type WorkerJobAttemptIdentity,
} from "../../lib/job-ledger";
import {
  resolveMintBurnFreshnessConfig,
  type MintBurnFreshnessConfig,
} from "../../lib/mint-burn-health-config";
import { logWorkerEvent } from "../../lib/structured-log";
import type { ScheduledRecoveryCheckpoint } from "../../lib/scheduled-recovery-checkpoint";
import { utcCalendarMonth, type ProducerIdentity } from "../../lib/producer-history";
import { ScheduledFetchBudget } from "../../lib/scheduled-fetch-budget";

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
  "sync-dex-liquidity": LONG_RUNNING_LEASE_OPTIONS,
  "sync-dex-discovery": LONG_RUNNING_LEASE_OPTIONS,
  "sync-yield-data": LONG_RUNNING_LEASE_OPTIONS,
  "sync-yield-supplemental": LONG_RUNNING_LEASE_OPTIONS,
  "sync-blacklist": LONG_RUNNING_LEASE_OPTIONS,
  "sync-mint-burn": LONG_RUNNING_LEASE_OPTIONS,
  "sync-mint-burn-extended": LONG_RUNNING_LEASE_OPTIONS,
  "dispatch-telegram-alerts": LONG_RUNNING_LEASE_OPTIONS,
  "snapshot-public-dataset": LONG_RUNNING_LEASE_OPTIONS,
  "daily-digest": LONG_RUNNING_LEASE_OPTIONS,
  "weekly-recap": LONG_RUNNING_LEASE_OPTIONS,
};

function logJobLedgerWriteFailure(job: string, event: string, error: unknown): void {
  logWorkerEvent({
    scope: "lib",
    level: "warn",
    event,
    job,
    source: "worker_job_attempts",
    message: "Worker job attempt ledger write failed",
    error,
  });
}

export interface ScheduledRuntimeContext {
  db: D1Database;
  env: Env;
  ctx: ExecutionContext;
  cron: string;
  scheduleKey: CronScheduleKey;
  scheduledTimeMs: number | null;
  slotStartedAt: number;
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
  alertWebhookUrl: string | null;
  chainRpcs: Map<string, ChainRpcConfig>;
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
  if (runtime.getProducerIdentity) return runtime.getProducerIdentity(job);
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
  scheduledTimeMs: number | null;
  slotStartedAt: number;
  slotBudgetStartedAtMs?: number;
  parentSignal?: AbortSignal;
  jobAttemptNo?: number;
  producerKind?: string;
  recoveryCheckpoint?: ScheduledRecoveryCheckpoint;
}

export function createScheduledRuntimeContext(
  env: Env,
  ctx: ExecutionContext,
  scheduled: ScheduledRuntimeInit,
): ScheduledRuntimeContext {
  const db = env.DB;
  const mintBurnDisabledIds = parseCsvEnv(env.MINT_BURN_DISABLED_IDS);
  const mintBurnDisabledSymbols = parseCsvEnv(env.MINT_BURN_DISABLED_SYMBOLS);
  const mintBurnFreshnessConfig = resolveMintBurnFreshnessConfig(env);
  const coingeckoApiKey = normalizeCgApiKey(env.COINGECKO_API_KEY);
  const alertWebhookUrl = normalizeWebhookUrl(env.ALERT_WEBHOOK_URL);
  const chainRpcs = buildChainRpcs(env.ALCHEMY_API_KEY, env.DRPC_API_KEY);
  const workerJobLedgerMode = normalizeWorkerJobLedgerMode(env.WORKER_JOB_LEDGER_MODE);
  const workerJobLedgerAllowlist = parseCsvEnv(env.WORKER_JOB_LEDGER_ALLOWLIST);
  const slotBudgetStartedAtMs = scheduled.slotBudgetStartedAtMs ?? Date.now();
  const invocationId = createLeaseOwner(`scheduled:${scheduled.scheduleKey}`);
  const workerVersion = env.CF_VERSION_METADATA?.tag || env.CF_VERSION_METADATA?.id || null;
  const jobAttemptNo = scheduled.jobAttemptNo ?? 1;
  const producerKind = scheduled.producerKind ?? "scheduled-job";
  const fetchBudget = new ScheduledFetchBudget();
  const slotAbortSignal = scheduled.parentSignal;
  const getProducerIdentity = (job: string): ProducerIdentity => {
    const descriptor = getScheduledTaskDescriptor(scheduled.scheduleKey, job);
    return {
      scheduleKey: scheduled.scheduleKey,
      job,
      producerPath: descriptor.producerPath,
      producerKind: scheduled.producerKind ?? descriptor.producerKind,
      invocationId,
      workerVersion,
      slotStartedAt: scheduled.slotStartedAt,
      calendarPeriod: descriptor.calendarIdentity === "utc-month"
        ? utcCalendarMonth(scheduled.slotStartedAt)
        : null,
    };
  };

  const runtime: ScheduledRuntimeContext = {
    db,
    env,
    ctx,
    cron: scheduled.cron,
    scheduleKey: scheduled.scheduleKey,
    scheduledTimeMs: scheduled.scheduledTimeMs,
    slotStartedAt: scheduled.slotStartedAt,
    slotBudgetStartedAtMs,
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
    alertWebhookUrl,
    chainRpcs,
    runLeasedCron: async (job, fn) => {
      const descriptor = getScheduledTaskDescriptor(scheduled.scheduleKey, job);
      if (!descriptor.statusTracked) {
        throw new Error(`${scheduled.scheduleKey}/${job} is budget-only and cannot use runLeasedCron`);
      }
      const timeoutBudget = resolveCronTimeoutBudget(job, { slotBudgetStartedAtMs });
      const timeoutBudgetMetadata = getCronTimeoutBudgetMetadata(timeoutBudget);
      const ledgerEnabled = shouldRecordWorkerJobAttempt({
        mode: workerJobLedgerMode,
        allowlist: workerJobLedgerAllowlist,
        job,
      });
      const combinedSlotSignal = runtime.slotSignal && slotAbortSignal
        ? AbortSignal.any([runtime.slotSignal, slotAbortSignal])
        : runtime.slotSignal ?? slotAbortSignal;

      return fetchBudget.run(descriptor.maxConnections, combinedSlotSignal, async () => {
        const ledgerStartedAtMs = Date.now();
        let ledgerIdentity: WorkerJobAttemptIdentity | null = null;
        let ledgerBootstrapError: unknown = null;
        try {
          if (ledgerEnabled) {
            try {
              ledgerIdentity = await createWorkerJobAttempt(db, {
                scheduleKey: scheduled.scheduleKey,
                job,
                slotStartedAt: scheduled.slotStartedAt,
                producerPath: descriptor.producerPath,
                attemptNo: jobAttemptNo,
                producerKind,
                invocationId,
                workerVersion,
              });
            } catch (err) {
              logJobLedgerWriteFailure(job, "worker_job_attempt_create_failed", err);
              if (workerJobLedgerMode === "write") ledgerBootstrapError = err;
            }
          }
          const result = await logCronRun(db, job, async (signal, reportProgress): Promise<CronResult> => {
          if (ledgerBootstrapError) throw ledgerBootstrapError;
          const slotMeta = {
            slotStartedAt: scheduled.slotStartedAt,
            scheduleKey: scheduled.scheduleKey,
            producerPath: descriptor.producerPath,
            invocationId,
            workerVersion,
            attemptNo: jobAttemptNo,
            producerKind,
          };
          const leaseOwner = createLeaseOwner(job);
          let ledgerWriteTail = Promise.resolve();
          const enqueueLedgerWrite = (write: () => Promise<void>, event: string): Promise<void> => {
            const next = ledgerWriteTail.then(write);
            ledgerWriteTail = next.catch((err) => {
              logJobLedgerWriteFailure(job, event, err);
            });
            return workerJobLedgerMode === "write" ? next : ledgerWriteTail;
          };
          const reportProgressWithLedger: CronProgressReporter = (update) => {
            const progressWrite = reportProgress(update);
            if (!ledgerIdentity) return progressWrite;
            return progressWrite.then(() => enqueueLedgerWrite(
              () => heartbeatWorkerJobAttempt(db, {
                attemptId: ledgerIdentity!.attemptId,
                progress: update,
              }),
              "worker_job_attempt_heartbeat_failed",
            ));
          };
          const currentLedgerIdentity = ledgerIdentity;
          const recordLeaseState: CronLeaseOptions["onLeaseState"] | undefined = currentLedgerIdentity
            ? async (leaseState) => {
                await enqueueLedgerWrite(
                  () => recordWorkerJobAttemptLease(db, {
                    attemptId: currentLedgerIdentity.attemptId,
                    owner: leaseState.leaseOwner,
                    leaseUntil: leaseState.leaseUntil,
                  }),
                  "worker_job_attempt_lease_state_failed",
                );
              }
            : undefined;
          const finishLedgerResult = async (result: CronResult): Promise<void> => {
            if (!ledgerIdentity) return;
            try {
              await finishWorkerJobAttempt(db, {
                attemptId: ledgerIdentity.attemptId,
                startedAtMs: ledgerStartedAtMs,
                result,
              });
            } catch (err) {
              logJobLedgerWriteFailure(job, "worker_job_attempt_finish_failed", err);
              if (workerJobLedgerMode === "write") throw err;
            }
          };
          await reportProgressWithLedger({
            stage: "started",
            message: `Starting ${job}`,
            metadata: slotMeta,
          });
          const perJobLeaseOptions = PER_JOB_LEASE_OPTIONS[job] ?? {};
          const buildLeaseMeta = (lease: Awaited<ReturnType<typeof runCronWithLease>>) => ({
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
            ...(timeoutBudgetMetadata ? { timeoutBudget: timeoutBudgetMetadata } : {}),
            ...slotMeta,
          });
          const leaseOptions: CronLeaseOptions = {
            owner: leaseOwner,
            abortSignal: signal,
            timeoutBudget,
            ...(recordLeaseState
              ? {
                  onLeaseState: recordLeaseState,
                  leaseStateObserverMode: workerJobLedgerMode === "write" ? "required" as const : "best-effort" as const,
                }
              : {}),
            ...perJobLeaseOptions,
          };
          const lease = await runCronWithLease(db, job, async ({ signal: leaseSignal }) => {
            await reportProgressWithLedger({
              stage: "lease-acquired",
              message: `Lease acquired for ${job}`,
              leaseOwner,
              metadata: slotMeta,
            });
            return fn(leaseSignal, reportProgressWithLedger);
          }, leaseOptions);

          if (lease.status === "skipped_locked") {
            await reportProgressWithLedger({
              stage: "skipped-locked",
              message: `Lease already held for ${job}`,
              leaseOwner: lease.leaseOwner,
              metadata: slotMeta,
            });
            const terminalResult: CronResult = {
              status: "skipped_locked",
              metadata: JSON.stringify({
                reason: "lease-locked",
                ...buildLeaseMeta(lease),
              }),
            };
            await finishLedgerResult(terminalResult);
            return terminalResult;
          }

          const result = lease.result;
          if (!result) {
            const terminalResult: CronResult = {
              metadata: JSON.stringify({
                ...buildLeaseMeta(lease),
              }),
            };
            await finishLedgerResult(terminalResult);
            return terminalResult;
          }

          const leaseMeta = buildLeaseMeta(lease);

          const metadata = mergeCronMetadataWithLease(
            normalizeCronMetadata(result),
            leaseMeta,
          );

          await reportProgressWithLedger({
            stage: "completed",
            message: `Completed ${job}`,
            leaseOwner: lease.leaseOwner,
            metadata: slotMeta,
          });

          const terminalResult = { ...result, metadata };
          await finishLedgerResult(terminalResult);
          return terminalResult;
        }, (title, message) => sendAlert(alertWebhookUrl, title, message), {
          slotStartedAt: scheduled.slotStartedAt,
          timeoutBudget,
          abortSignal: combinedSlotSignal,
          producer: {
            ...getProducerIdentity(job),
          },
        });
        return result;
        } catch (err) {
          if (ledgerIdentity) {
            try {
              await finishWorkerJobAttempt(db, {
                attemptId: ledgerIdentity.attemptId,
                startedAtMs: ledgerStartedAtMs,
                error: err,
              });
            } catch (finishErr) {
              logJobLedgerWriteFailure(job, "worker_job_attempt_finish_failed", finishErr);
              if (workerJobLedgerMode === "write") {
                throw new AggregateError(
                  [err, finishErr],
                  `Cron ${job} failed and its terminal worker-job attempt could not be persisted`,
                );
              }
            }
          }
          throw err;
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
    getProducerIdentity,
  };
  return runtime;
}

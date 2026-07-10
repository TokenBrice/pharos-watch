import type { CronScheduleKey } from "@shared/lib/cron-jobs";
import {
  createLeaseOwner,
  getCronTimeoutBudgetMetadata,
  resolveCronTimeoutBudget,
  runCronWithLease,
  type CronLeaseOptions,
} from "../../lib/cron-lease";
import { logCronRun, type CronProgressReporter, type CronResult } from "../../lib/cron-logger";
import { sendAlert, normalizeWebhookUrl } from "../../lib/alerts";
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
  const producerKind = scheduled.producerKind ?? "scheduled-slot";

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
    ...(scheduled.recoveryCheckpoint ? { recoveryCheckpoint: scheduled.recoveryCheckpoint } : {}),
    mintBurnDisabledIds,
    mintBurnDisabledSymbols,
    mintBurnFreshnessConfig,
    coingeckoApiKey,
    alertWebhookUrl,
    chainRpcs,
    runLeasedCron: async (job, fn) => {
      const timeoutBudget = resolveCronTimeoutBudget(job, { slotBudgetStartedAtMs });
      const timeoutBudgetMetadata = getCronTimeoutBudgetMetadata(timeoutBudget);
      const ledgerEnabled = shouldRecordWorkerJobAttempt({
        mode: workerJobLedgerMode,
        allowlist: workerJobLedgerAllowlist,
        job,
      });
      const ledgerStartedAtMs = Date.now();
      let ledgerIdentity: WorkerJobAttemptIdentity | null = null;
      if (ledgerEnabled) {
        try {
          ledgerIdentity = await createWorkerJobAttempt(db, {
            scheduleKey: scheduled.scheduleKey,
            job,
            slotStartedAt: scheduled.slotStartedAt,
            attemptNo: jobAttemptNo,
            producerKind,
          });
        } catch (err) {
          logJobLedgerWriteFailure(job, "worker_job_attempt_create_failed", err);
        }
      }

      try {
        const result = await logCronRun(db, job, async (signal, reportProgress): Promise<CronResult> => {
          const slotMeta = {
            slotStartedAt: scheduled.slotStartedAt,
            scheduleKey: scheduled.scheduleKey,
            invocationId,
            workerVersion,
            attemptNo: jobAttemptNo,
            producerKind,
          };
          const leaseOwner = createLeaseOwner(job);
          const reportProgressWithLedger: CronProgressReporter = async (update) => {
            await reportProgress(update);
            if (!ledgerIdentity) return;
            try {
              await heartbeatWorkerJobAttempt(db, {
                attemptId: ledgerIdentity.attemptId,
                progress: update,
              });
            } catch (err) {
              logJobLedgerWriteFailure(job, "worker_job_attempt_heartbeat_failed", err);
            }
          };
          const currentLedgerIdentity = ledgerIdentity;
          const recordLeaseState: CronLeaseOptions["onLeaseState"] | undefined = currentLedgerIdentity
            ? async (leaseState) => {
                try {
                  await recordWorkerJobAttemptLease(db, {
                    attemptId: currentLedgerIdentity.attemptId,
                    owner: leaseState.leaseOwner,
                    leaseUntil: leaseState.leaseUntil,
                  });
                } catch (err) {
                  logJobLedgerWriteFailure(job, "worker_job_attempt_lease_state_failed", err);
                }
              }
            : undefined;
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
            ...(recordLeaseState ? { onLeaseState: recordLeaseState } : {}),
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

          return { ...result, metadata };
        }, (title, message) => sendAlert(alertWebhookUrl, title, message), {
          slotStartedAt: scheduled.slotStartedAt,
          timeoutBudget,
          abortSignal: runtime.slotSignal && scheduled.parentSignal
            ? AbortSignal.any([runtime.slotSignal, scheduled.parentSignal])
            : runtime.slotSignal ?? scheduled.parentSignal,
        });
        if (ledgerIdentity) {
          try {
            await finishWorkerJobAttempt(db, {
              attemptId: ledgerIdentity.attemptId,
              startedAtMs: ledgerStartedAtMs,
              result,
            });
          } catch (err) {
            logJobLedgerWriteFailure(job, "worker_job_attempt_finish_failed", err);
          }
        }
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
          }
        }
        throw err;
      }
    },
  };
  return runtime;
}

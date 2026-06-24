import type { CronScheduleKey } from "@shared/lib/cron-jobs";
import { createLeaseOwner, runCronWithLease, type CronLeaseOptions } from "../../lib/cron-lease";
import { logCronRun, type CronProgressReporter, type CronResult } from "../../lib/cron-logger";
import { sendAlert, normalizeWebhookUrl } from "../../lib/alerts";
import { normalizeCgApiKey } from "../../lib/coingecko";
import { buildChainRpcs, type ChainRpcConfig } from "../../lib/chain-registry";
import { normalizeCronMetadata, mergeCronMetadataWithLease } from "../../lib/cron-metadata";
import { parseCsvEnv, type Env } from "../../lib/env";
import {
  resolveMintBurnFreshnessConfig,
  type MintBurnFreshnessConfig,
} from "../../lib/mint-burn-health-config";

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

export interface ScheduledRuntimeContext {
  db: D1Database;
  env: Env;
  ctx: ExecutionContext;
  cron: string;
  scheduleKey: CronScheduleKey;
  scheduledTimeMs: number | null;
  slotStartedAt: number;
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

  return {
    db,
    env,
    ctx,
    cron: scheduled.cron,
    scheduleKey: scheduled.scheduleKey,
    scheduledTimeMs: scheduled.scheduledTimeMs,
    slotStartedAt: scheduled.slotStartedAt,
    mintBurnDisabledIds,
    mintBurnDisabledSymbols,
    mintBurnFreshnessConfig,
    coingeckoApiKey,
    alertWebhookUrl,
    chainRpcs,
    runLeasedCron: (job, fn) =>
      logCronRun(db, job, async (signal, reportProgress): Promise<CronResult> => {
        const slotMeta = { slotStartedAt: scheduled.slotStartedAt, scheduleKey: scheduled.scheduleKey };
        await reportProgress({
          stage: "started",
          message: `Starting ${job}`,
          metadata: slotMeta,
        });
        const leaseOwner = createLeaseOwner(job);
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
          ...slotMeta,
        });
        const lease = await runCronWithLease(db, job, async ({ signal: leaseSignal }) => {
          await reportProgress({
            stage: "lease-acquired",
            message: `Lease acquired for ${job}`,
            leaseOwner,
            metadata: slotMeta,
          });
          return fn(leaseSignal, reportProgress);
        }, { owner: leaseOwner, abortSignal: signal, ...perJobLeaseOptions });

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

        const metadata = mergeCronMetadataWithLease(
          normalizeCronMetadata(result),
          leaseMeta,
        );

        await reportProgress({
          stage: "completed",
          message: `Completed ${job}`,
          leaseOwner: lease.leaseOwner,
          metadata: slotMeta,
        });

        return { ...result, metadata };
      }, (title, message) => sendAlert(alertWebhookUrl, title, message), {
        slotStartedAt: scheduled.slotStartedAt,
      }),
  };
}

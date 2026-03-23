import type { CronScheduleKey } from "@shared/lib/cron-jobs";
import { createLeaseOwner, runCronWithLease } from "../../lib/cron-lease";
import { logCronRun, type CronProgressReporter, type CronResult } from "../../lib/cron-logger";
import { sendAlert, normalizeWebhookUrl } from "../../lib/alerts";
import { normalizeCgApiKey } from "../../lib/coingecko";
import { buildChainRpcs, type ChainRpcConfig } from "../../lib/chain-registry";
import { parseCsvEnv, type Env } from "../../lib/env";
import {
  resolveMintBurnFreshnessConfig,
  type MintBurnFreshnessConfig,
} from "../../lib/mint-burn-health-config";

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
    return {
      stablecoinsCache: false,
      depegPipeline: false,
    };
  }
}

function normalizeCronMetadata(result: CronResult): string | undefined {
  const parsed: Record<string, unknown> = {};
  if (result.metadata) {
    try {
      Object.assign(parsed, JSON.parse(result.metadata) as Record<string, unknown>);
    } catch {
      parsed.rawMetadata = result.metadata;
    }
  }

  const rowsWrittenDefault =
    typeof result.itemCount === "number" ? result.itemCount : null;

  return JSON.stringify({
    rowsRead: parsed.rowsRead ?? null,
    rowsWritten: parsed.rowsWritten ?? rowsWrittenDefault,
    rowsDropped: parsed.rowsDropped ?? 0,
    sourceCoverage: parsed.sourceCoverage ?? null,
    fallbackMode: parsed.fallbackMode ?? null,
    validationFailures: parsed.validationFailures ?? 0,
    ...parsed,
  });
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
        await reportProgress({
          stage: "started",
          message: `Starting ${job}`,
          metadata: {
            slotStartedAt: scheduled.slotStartedAt,
            scheduleKey: scheduled.scheduleKey,
          },
        });
        const leaseOwner = createLeaseOwner(job);
        const lease = await runCronWithLease(db, job, async ({ signal: leaseSignal }) => {
          await reportProgress({
            stage: "lease-acquired",
            message: `Lease acquired for ${job}`,
            leaseOwner,
            metadata: {
              slotStartedAt: scheduled.slotStartedAt,
              scheduleKey: scheduled.scheduleKey,
            },
          });
          return fn(leaseSignal, reportProgress);
        }, { owner: leaseOwner, abortSignal: signal });

        if (lease.status === "skipped_locked") {
          await reportProgress({
            stage: "skipped-locked",
            message: `Lease already held for ${job}`,
            leaseOwner: lease.leaseOwner,
            metadata: {
              slotStartedAt: scheduled.slotStartedAt,
              scheduleKey: scheduled.scheduleKey,
            },
          });
          return {
            status: "skipped_locked",
            metadata: JSON.stringify({
              reason: "lease-locked",
              leaseOwner: lease.leaseOwner,
              renewFailures: lease.renewFailures,
              slotStartedAt: scheduled.slotStartedAt,
              scheduleKey: scheduled.scheduleKey,
            }),
          };
        }

        const result = lease.result;
        if (!result) {
          return {
            metadata: JSON.stringify({
              leaseOwner: lease.leaseOwner,
              renewFailures: lease.renewFailures,
              slotStartedAt: scheduled.slotStartedAt,
              scheduleKey: scheduled.scheduleKey,
            }),
          };
        }

        const leaseMeta = {
          leaseOwner: lease.leaseOwner,
          renewFailures: lease.renewFailures,
          slotStartedAt: scheduled.slotStartedAt,
          scheduleKey: scheduled.scheduleKey,
        };

        const normalized = normalizeCronMetadata(result);
        let metadata = normalized;
        if (!metadata) {
          metadata = JSON.stringify(leaseMeta);
        } else {
          try {
            const parsed = JSON.parse(metadata) as Record<string, unknown>;
            metadata = JSON.stringify({ ...parsed, ...leaseMeta });
          } catch {
            metadata = `${metadata} | lease=${JSON.stringify(leaseMeta)}`;
          }
        }

        await reportProgress({
          stage: "completed",
          message: `Completed ${job}`,
          leaseOwner: lease.leaseOwner,
          metadata: {
            slotStartedAt: scheduled.slotStartedAt,
            scheduleKey: scheduled.scheduleKey,
          },
        });

        return { ...result, metadata };
      }, (title, message) => sendAlert(alertWebhookUrl, title, message), {
        slotStartedAt: scheduled.slotStartedAt,
      }),
  };
}

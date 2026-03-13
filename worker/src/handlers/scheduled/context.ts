import { createLeaseOwner, runCronWithLease } from "../../lib/cron-lease";
import { logCronRun, type CronProgressReporter, type CronResult } from "../../lib/cron-logger";
import { sendAlert } from "../../lib/alerts";
import { parseCsvEnv, type Env } from "../../lib/env";
import {
  resolveMintBurnFreshnessConfig,
  type MintBurnFreshnessConfig,
} from "../../lib/mint-burn-health-config";

export interface ScheduledRuntimeContext {
  db: D1Database;
  env: Env;
  ctx: ExecutionContext;
  mintBurnDisabledIds: string[];
  mintBurnDisabledSymbols: string[];
  mintBurnFreshnessConfig: MintBurnFreshnessConfig;
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

export function createScheduledRuntimeContext(
  env: Env,
  ctx: ExecutionContext,
): ScheduledRuntimeContext {
  const db = env.DB;
  const mintBurnDisabledIds = parseCsvEnv(env.MINT_BURN_DISABLED_IDS);
  const mintBurnDisabledSymbols = parseCsvEnv(env.MINT_BURN_DISABLED_SYMBOLS);
  const mintBurnFreshnessConfig = resolveMintBurnFreshnessConfig(env);

  return {
    db,
    env,
    ctx,
    mintBurnDisabledIds,
    mintBurnDisabledSymbols,
    mintBurnFreshnessConfig,
    runLeasedCron: (job, fn) =>
      logCronRun(db, job, async (signal, reportProgress): Promise<CronResult> => {
        const leaseOwner = createLeaseOwner(job);
        const lease = await runCronWithLease(db, job, async ({ signal: leaseSignal }) => {
          const mergedSignal = typeof AbortSignal.any === "function"
            ? AbortSignal.any([signal, leaseSignal])
            : signal;
          await reportProgress({
            stage: "lease-acquired",
            message: `Lease acquired for ${job}`,
            leaseOwner,
          });
          return fn(mergedSignal, reportProgress);
        }, { owner: leaseOwner });

        if (lease.status === "skipped_locked") {
          return {
            status: "skipped_locked",
            metadata: JSON.stringify({
              reason: "lease-locked",
              leaseOwner: lease.leaseOwner,
              renewFailures: lease.renewFailures,
            }),
          };
        }

        const result = lease.result;
        if (!result) {
          return {
            metadata: JSON.stringify({
              leaseOwner: lease.leaseOwner,
              renewFailures: lease.renewFailures,
            }),
          };
        }

        const leaseMeta = {
          leaseOwner: lease.leaseOwner,
          renewFailures: lease.renewFailures,
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

        return { ...result, metadata };
      }, sendAlert),
  };
}

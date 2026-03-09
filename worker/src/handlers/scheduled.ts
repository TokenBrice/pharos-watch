import {
  logCronRun,
  getCache,
  setCache,
  runCronWithLease,
  buildInClause,
  type CronProgressReporter,
  type CronResult,
} from "../lib/db";
import { syncStablecoins } from "../cron/sync-stablecoins";
import { syncStablecoinCharts } from "../cron/sync-stablecoin-charts";
import { syncBlacklist } from "../cron/sync-blacklist";
import { syncMintBurn } from "../cron/sync-mint-burn";
import { syncDexDiscovery } from "../cron/dex-discovery";
import { createRateLimiter } from "../lib/evm-logs";
import { syncUsdsStatus } from "../cron/sync-usds-status";
import { syncBluechip } from "../cron/sync-bluechip";
import { syncFxRates } from "../cron/sync-fx-rates";
import { syncDexLiquidity } from "../cron/dex-liquidity";
import { snapshotSupply } from "../cron/snapshot-supply";
import { snapshotSafetyGradeHistory } from "../cron/snapshot-safety-grade-history";
import { generateDailyDigest } from "../cron/daily-digest";
import { computeAndStoreStabilityIndex } from "../cron/stability-index";
import { snapshotPsiDaily } from "../cron/snapshot-psi";
import { syncYieldData } from "../cron/sync-yield-data";
import { fetchTbillRate } from "../cron/fetch-tbill-rate";
import { computeAndStoreDEWS } from "../cron/compute-dews";
import { dispatchTelegramAlerts } from "../cron/dispatch-telegram-alerts";
import { runStatusSelfCheck } from "../cron/status-self-check";
import { initChainRpcs } from "../lib/chain-registry";
import { initAlerts, sendAlert } from "../lib/alerts";
import { initCoinGecko } from "../lib/coingecko";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../lib/constants";
import {
  evaluateMintBurnFreshness,
  resolveMintBurnFreshnessConfig,
} from "../lib/mint-burn-health-config";
import { CRON_SCHEDULES } from "../lib/cron-schedule";
import { parseCsvEnv, type Env } from "../lib/env";

export async function handleScheduledEvent(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  initChainRpcs(env.ALCHEMY_API_KEY, env.DRPC_API_KEY);
  initAlerts(env.ALERT_WEBHOOK_URL);
  initCoinGecko(env.COINGECKO_API_KEY);
  const db = env.DB;
  const cron = event.cron;
  const mintBurnDisabledIds = parseCsvEnv(env.MINT_BURN_DISABLED_IDS);
  const mintBurnDisabledSymbols = parseCsvEnv(env.MINT_BURN_DISABLED_SYMBOLS);
  const mintBurnFreshnessConfig = resolveMintBurnFreshnessConfig(env);
  const parseStablecoinsCapabilities = (
    result: CronResult | null | void,
  ): { stablecoinsCache: boolean; depegPipeline: boolean } => {
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
  };
  const normalizeCronMetadata = (result: CronResult): string | undefined => {
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
  };
  const createLeaseOwner = (job: string): string => {
    const cryptoObj = globalThis as typeof globalThis & { crypto?: { randomUUID?: () => string } };
    if (typeof cryptoObj.crypto?.randomUUID === "function") return cryptoObj.crypto.randomUUID();
    return `${job}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  };
  const runLeasedCron = (
    job: string,
    fn: (signal: AbortSignal, reportProgress: CronProgressReporter) => Promise<CronResult | void>,
  ) =>
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
    }, sendAlert);

  switch (cron) {
    case CRON_SCHEDULES.quarterHourly: {
      ctx.waitUntil((async () => {
        const runQuarterHourlyJob = async (
          job: string,
          fn: (signal: AbortSignal, reportProgress: CronProgressReporter) => Promise<CronResult | void>,
        ): Promise<CronResult | null> => {
          try {
            return (await runLeasedCron(job, fn)) ?? null;
          } catch (err) {
            console.error(`[cron] ${job} failed in quarter-hour slot:`, err);
            return null;
          }
        };

        // All jobs in this trigger share one Workers 6-connection fetch pool.
        // Run sequentially in-slot to avoid cross-job connection spikes.
        const stablecoinsResult = await runQuarterHourlyJob(
          "sync-stablecoins",
          (signal) => syncStablecoins(db, env.CMC_API_KEY, signal),
        );
        const stablecoinsCapabilities = parseStablecoinsCapabilities(stablecoinsResult);
        const stablecoinsCacheSafe = stablecoinsCapabilities.stablecoinsCache;
        const depegPipelineSafe = stablecoinsCapabilities.depegPipeline;
        if (stablecoinsResult && !stablecoinsCacheSafe) {
          console.warn("[cron] sync-stablecoins completed without downstream-safe cache write — skipping dependent jobs");
        }

        if (stablecoinsCacheSafe) {
          // Retry daily supply snapshots throughout the day so a stale-cache skip at 08:00
          // cannot permanently leave a missing date.
          await runQuarterHourlyJob("snapshot-supply", (signal) => snapshotSupply(db, signal));
        }

        await runQuarterHourlyJob("sync-fx-rates", (signal) => syncFxRates(db, signal));

        let dewsResult: CronResult | null = null;
        if (stablecoinsCacheSafe && depegPipelineSafe) {
          // PSI depends on stablecoins cache + fresh depeg events.
          await runQuarterHourlyJob("stability-index", (signal) => computeAndStoreStabilityIndex(db, signal));
        } else if (stablecoinsCacheSafe && !depegPipelineSafe) {
          console.warn("[cron] sync-stablecoins completed without a safe depeg pipeline — skipping stability-index");
        }

        if (stablecoinsCacheSafe) {
          // DEWS depends on stablecoins cache + dex data — run after sync
          dewsResult = await runQuarterHourlyJob("compute-dews", (signal) => computeAndStoreDEWS(db, signal));
        }

        // Status system self-check: persists hysteresis state and probes critical endpoints.
        await runQuarterHourlyJob(
          "status-self-check",
          (signal) => runStatusSelfCheck(
            db,
            env.ADMIN_KEY,
            env.SELF_URL,
            signal,
            ctx,
            mintBurnFreshnessConfig,
          ),
        );

        // Telegram alert dispatch — must run LAST, after sync-stablecoins + compute-dews
        if (env.TELEGRAM_BOT_TOKEN && stablecoinsCacheSafe && depegPipelineSafe && dewsResult !== null) {
          await runQuarterHourlyJob("dispatch-telegram-alerts", (signal) =>
            dispatchTelegramAlerts(db, env.TELEGRAM_BOT_TOKEN!, signal),
          );
        }

        // Periodic health alert: warn if stablecoins cache is stale for 30+ minutes
        try {
          const cached = await getCache(db, "stablecoins");
          if (cached) {
            const age = Math.floor(Date.now() / 1000) - cached.updatedAt;
            if (age > 1800) {
              await sendAlert("Data stale", `Stablecoins cache is ${Math.round(age / 60)}min old (expected <20min)`);
            }
          }
        } catch {
          /* non-blocking */
        }
      })());
      break;
    }
    // Blacklist on dedicated 20-min trigger (:03/:23/:43)
    case CRON_SCHEDULES.twentyMinuteOffset: {
      const etherscanAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.ETHERSCAN);
      if (etherscanAllowed) {
        const etherscanRL = createRateLimiter(4);
        const etherscanKey = env.ETHERSCAN_API_KEY ?? null;
        const blacklistJob = runLeasedCron("sync-blacklist", (signal, reportProgress) =>
          syncBlacklist(
            db,
            etherscanKey,
            env.TRONGRID_API_KEY ?? null,
            env.DRPC_API_KEY ?? null,
            etherscanRL,
            signal,
            reportProgress,
          )
        );
        ctx.waitUntil(blacklistJob);
        ctx.waitUntil(blacklistJob.then(
          () => recordOutcome(db, CIRCUIT_SOURCE.ETHERSCAN, true),
          () => recordOutcome(db, CIRCUIT_SOURCE.ETHERSCAN, false),
        ));
      } else {
        console.warn("[cron] Etherscan circuit open — skipping blacklist sync");
      }
      break;
    }
    // Mint/burn critical lane on dedicated 20-min trigger (:04/:24/:44)
    case CRON_SCHEDULES.twentyMinuteMintBurn: {
      const alchemyAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.ALCHEMY);
      if (alchemyAllowed) {
        const mintBurnJob = runLeasedCron("sync-mint-burn", (signal, reportProgress) =>
          syncMintBurn(db, env.ALCHEMY_API_KEY ?? null, {
            signal,
            disabledConfigIds: mintBurnDisabledIds,
            disabledSymbols: mintBurnDisabledSymbols,
            lane: "critical",
            jobName: "sync-mint-burn",
            onProgress: reportProgress,
          })
        );
        ctx.waitUntil(mintBurnJob);
        ctx.waitUntil(mintBurnJob.then(
          (result) => recordOutcome(
            db,
            CIRCUIT_SOURCE.ALCHEMY,
            (result?.status ?? "ok") !== "error",
          ),
          () => recordOutcome(db, CIRCUIT_SOURCE.ALCHEMY, false),
        ));
        ctx.waitUntil(mintBurnJob.then(async () => {
          try {
            const symbols = mintBurnFreshnessConfig.majorSymbols;
            if (symbols.length === 0) return;
            const symbolInClause = buildInClause(symbols);
            const now = Math.floor(Date.now() / 1000);
            const rows = await db
              .prepare(
                `SELECT symbol, MAX(timestamp) as latest_ts
                   FROM mint_burn_events
                   WHERE symbol IN (${symbolInClause.sql})
                   GROUP BY symbol`,
              )
              .bind(...symbolInClause.binds)
              .all<{ symbol: string; latest_ts: number | null }>();

            const latestBySymbol = new Map<string, number | null>();
            for (const row of rows.results ?? []) {
              latestBySymbol.set(row.symbol, row.latest_ts ?? null);
            }

            const freshness = evaluateMintBurnFreshness(now, latestBySymbol, mintBurnFreshnessConfig);

            const emitAlert = async (severity: "warn" | "crit", details: string[]): Promise<void> => {
              if (details.length === 0) return;
              const cacheKey = `alert:mint-burn-stale:${severity}`;
              const prior = await getCache(db, cacheKey);
              if (prior && now - prior.updatedAt < mintBurnFreshnessConfig.alertCooldownSec) return;
              const threshold = severity === "crit"
                ? mintBurnFreshnessConfig.staleCritSec
                : mintBurnFreshnessConfig.staleWarnSec;
              await sendAlert(
                `Mint/burn staleness (${severity.toUpperCase()})`,
                `Threshold=${Math.round(threshold / 3600)}h, symbols=${details.join(", ")}`,
              );
              await setCache(db, cacheKey, JSON.stringify({ symbols: details, at: now }));
            };

            await emitAlert("warn", freshness.warnDetails);
            await emitAlert("crit", freshness.critDetails);
          } catch {
            // Non-blocking alert path.
          }
        }));
      } else {
        console.warn("[cron] Alchemy circuit open - skipping mint/burn sync");
      }
      break;
    }
    // Stablecoin charts on dedicated 30-min trigger (:05/:35)
    case CRON_SCHEDULES.halfHourlyCharts: {
      ctx.waitUntil(runLeasedCron("sync-stablecoin-charts", (signal) => syncStablecoinCharts(db, signal)));
      break;
    }
    // DEX pool discovery on dedicated 20-min trigger (:06/:26/:46)
    case CRON_SCHEDULES.twentyMinuteDexDiscovery: {
      ctx.waitUntil(runLeasedCron("sync-dex-discovery", (signal, reportProgress) =>
        syncDexDiscovery(db, env.COINGECKO_API_KEY ?? null, signal, reportProgress)
      ));
      break;
    }
    case CRON_SCHEDULES.twentyMinuteExtendedOffset: {
      const alchemyAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.ALCHEMY);
      if (!alchemyAllowed) {
        console.warn("[cron] Alchemy circuit open - skipping extended mint/burn sync");
        break;
      }

      const extendedJob = runLeasedCron("sync-mint-burn-extended", (signal, reportProgress) =>
        syncMintBurn(db, env.ALCHEMY_API_KEY ?? null, {
          signal,
          disabledConfigIds: mintBurnDisabledIds,
          disabledSymbols: mintBurnDisabledSymbols,
          lane: "extended",
          jobName: "sync-mint-burn-extended",
          onProgress: reportProgress,
        })
      );
      ctx.waitUntil(extendedJob);
      ctx.waitUntil(extendedJob.then(
        (result) => recordOutcome(
          db,
          CIRCUIT_SOURCE.ALCHEMY,
          (result?.status ?? "ok") !== "error",
        ),
        () => recordOutcome(db, CIRCUIT_SOURCE.ALCHEMY, false),
      ));
      break;
    }
    // DEX liquidity + yield data on a 30-min cycle (offset at :10/:40)
    // Yield depends on dex_liquidity for safety scores — chain after DEX sync
    case CRON_SCHEDULES.halfHourlyOffset: {
      const dexSync = runLeasedCron("sync-dex-liquidity", (signal) => syncDexLiquidity(db, env.GRAPH_API_KEY ?? null, signal));
      ctx.waitUntil(dexSync);
      ctx.waitUntil(dexSync.then(() =>
        runLeasedCron("sync-yield-data", (signal) => syncYieldData(db, signal))
      ));
      break;
    }
    case CRON_SCHEDULES.daily0800Utc: {
      ctx.waitUntil(runLeasedCron("snapshot-supply", (signal) => snapshotSupply(db, signal)));
      const safetyGradePromise = runLeasedCron("snapshot-safety-grade-history", (signal) => snapshotSafetyGradeHistory(db, signal));
      ctx.waitUntil(safetyGradePromise);
      if (env.TELEGRAM_BOT_TOKEN) {
        ctx.waitUntil(safetyGradePromise.then(() =>
          runLeasedCron("dispatch-telegram-alerts-daily", (signal) =>
            dispatchTelegramAlerts(db, env.TELEGRAM_BOT_TOKEN!, signal),
          ),
        ));
      }
      ctx.waitUntil(runLeasedCron("fetch-tbill-rate", (signal) => fetchTbillRate(db, signal)));
      const psiPromise = runLeasedCron("snapshot-psi", (signal) => snapshotPsiDaily(db, signal));
      ctx.waitUntil(psiPromise);
      ctx.waitUntil(runLeasedCron("sync-usds-status", (signal) => syncUsdsStatus(db, env.ETHERSCAN_API_KEY ?? null, signal)));
      ctx.waitUntil(runLeasedCron("sync-bluechip", (signal) => syncBluechip(db, signal)));
      ctx.waitUntil(psiPromise.then(() => runLeasedCron("daily-digest", (signal) => {
        const twitterCreds =
          env.TWITTER_API_KEY &&
          env.TWITTER_API_SECRET &&
          env.TWITTER_ACCESS_TOKEN &&
          env.TWITTER_ACCESS_TOKEN_SECRET
            ? {
              apiKey: env.TWITTER_API_KEY,
              apiSecret: env.TWITTER_API_SECRET,
              accessToken: env.TWITTER_ACCESS_TOKEN,
              accessTokenSecret: env.TWITTER_ACCESS_TOKEN_SECRET,
            }
            : null;
        const telegramCreds =
          env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
            ? { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID }
            : null;
        return generateDailyDigest(db, env.ANTHROPIC_API_KEY ?? null, twitterCreds, false, telegramCreds, signal);
      })));
      break;
    }
  }
}

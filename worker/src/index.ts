import { route } from "./router";
import { logCronRun, getCache, setCache, runCronWithLease, type CronResult } from "./lib/db";
import { syncStablecoins } from "./cron/sync-stablecoins";
import { syncStablecoinCharts } from "./cron/sync-stablecoin-charts";
import { syncBlacklist } from "./cron/sync-blacklist";
import { syncMintBurn } from "./cron/sync-mint-burn";
import { createRateLimiter } from "./lib/evm-logs";
import { syncUsdsStatus } from "./cron/sync-usds-status";
import { syncBluechip } from "./cron/sync-bluechip";
import { syncFxRates } from "./cron/sync-fx-rates";
import { syncDexLiquidity } from "./cron/dex-liquidity";
import { snapshotSupply } from "./cron/snapshot-supply";
import { generateDailyDigest } from "./cron/daily-digest";
import { computeAndStoreStabilityIndex } from "./cron/stability-index";
import { snapshotPsiDaily } from "./cron/snapshot-psi";
import { syncYieldData } from "./cron/sync-yield-data";
import { fetchTbillRate } from "./cron/fetch-tbill-rate";
import { computeAndStoreDEWS } from "./cron/compute-dews";
import { runStatusSelfCheck } from "./cron/status-self-check";
import { initChainRpcs } from "./lib/chain-rpcs";
import { initAlerts, sendAlert } from "./lib/alerts";
import { initCoinGecko } from "./lib/coingecko";
import { shouldAttemptFetch, recordOutcome } from "./lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "./lib/constants";
import { runIdempotentAdminAction } from "./lib/idempotency";
import {
  MINT_BURN_MAJOR_SYMBOLS,
  MINT_BURN_STALE_WARN_SEC,
  MINT_BURN_STALE_CRIT_SEC,
} from "./lib/mint-burn-health-config";
import { isMutatingAdminPath, isCacheBypassPath } from "../../src/lib/api-endpoints";

interface Env {
  DB: D1Database;
  CORS_ORIGIN: string;
  ETHERSCAN_API_KEY?: string;
  TRONGRID_API_KEY?: string;
  DRPC_API_KEY?: string;
  ALCHEMY_API_KEY?: string;
  ADMIN_KEY?: string;
  GRAPH_API_KEY?: string;
  ALERT_WEBHOOK_URL?: string;
  ANTHROPIC_API_KEY?: string;
  CMC_API_KEY?: string;
  COINGECKO_API_KEY?: string;
  GITHUB_PAT?: string;
  GITHUB_REPO_NODE_ID?: string;
  GITHUB_DISCUSSION_CATEGORY_ID?: string;
  FEEDBACK_IP_SALT?: string;
  TWITTER_API_KEY?: string;
  TWITTER_API_SECRET?: string;
  TWITTER_ACCESS_TOKEN?: string;
  TWITTER_ACCESS_TOKEN_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  MINT_BURN_DISABLED_IDS?: string;
  MINT_BURN_DISABLED_SYMBOLS?: string;
  MINT_BURN_MAJOR_SYMBOLS?: string;
  MINT_BURN_STALE_WARN_SEC?: string;
  MINT_BURN_STALE_CRIT_SEC?: string;
  MINT_BURN_ALERT_COOLDOWN_SEC?: string;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key, Idempotency-Key",
    "Access-Control-Expose-Headers": "X-Data-Age, Warning",
    "Access-Control-Max-Age": "86400",
    "X-Content-Type-Options": "nosniff",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  };
}

function addCorsHeaders(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(origin))) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function parseCsvEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const DEFAULT_MINT_BURN_ALERT_COOLDOWN_SEC = 3600;

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    initCoinGecko(env.COINGECKO_API_KEY);
    initAlerts(env.ALERT_WEBHOOK_URL);
    initChainRpcs(env.ALCHEMY_API_KEY, env.DRPC_API_KEY);
    const origin = env.CORS_ORIGIN;

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    const mutatingAdminPath = isMutatingAdminPath(url.pathname);
    const allowAuditDryRunGet =
      url.pathname === "/api/audit-depeg-history" && url.searchParams.get("dry-run") === "true";

    // POST /api/feedback — in-app feedback submission (public, no edge cache)
    if (request.method === "POST" && url.pathname === "/api/feedback") {
      const { handleFeedback } = await import("./api/feedback");
      const feedbackEnv = {
        GITHUB_PAT: env.GITHUB_PAT,
        GITHUB_REPO_NODE_ID: env.GITHUB_REPO_NODE_ID,
        GITHUB_DISCUSSION_CATEGORY_ID: env.GITHUB_DISCUSSION_CATEGORY_ID,
        FEEDBACK_IP_SALT: env.FEEDBACK_IP_SALT,
      };
      return addCorsHeaders(
        await handleFeedback(env.DB, request, feedbackEnv),
        origin
      );
    }

    if (request.method === "GET" && mutatingAdminPath && !allowAuditDryRunGet) {
      return addCorsHeaders(
        new Response(JSON.stringify({ error: "Method not allowed. Use POST for this endpoint." }), {
          status: 405,
          headers: { "Content-Type": "application/json", "Allow": "POST" },
        }),
        origin
      );
    }

    if (request.method === "POST" && !mutatingAdminPath) {
      return addCorsHeaders(
        new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405,
          headers: { "Content-Type": "application/json", "Allow": "GET" },
        }),
        origin
      );
    }

    if (request.method !== "GET" && request.method !== "POST") {
      return addCorsHeaders(
        new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405,
          headers: { "Content-Type": "application/json", "Allow": "GET, POST" },
        }),
        origin
      );
    }

    // Admin-only: trigger digest regeneration on demand (bypasses 1h dedup check)
    if (url.pathname === "/api/trigger-digest") {
      const authError = await (await import("./lib/auth")).requireAdmin(request, env.ADMIN_KEY);
      if (authError) return addCorsHeaders(authError, origin);
      const twitterCreds =
        env.TWITTER_API_KEY && env.TWITTER_API_SECRET && env.TWITTER_ACCESS_TOKEN && env.TWITTER_ACCESS_TOKEN_SECRET
          ? { apiKey: env.TWITTER_API_KEY, apiSecret: env.TWITTER_API_SECRET, accessToken: env.TWITTER_ACCESS_TOKEN, accessTokenSecret: env.TWITTER_ACCESS_TOKEN_SECRET }
          : null;
      const telegramCreds =
        env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
          ? { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID }
          : null;
      try {
        const response = await runIdempotentAdminAction(
          env.DB,
          "trigger-digest",
          request,
          async () => {
            const result = await generateDailyDigest(
              env.DB,
              env.ANTHROPIC_API_KEY ?? null,
              twitterCreds,
              true,
              telegramCreds,
            );
            return new Response(JSON.stringify({ ok: true, result }), {
              headers: { "Content-Type": "application/json" },
            });
          },
        );
        return addCorsHeaders(response, origin);
      } catch (err) {
        return addCorsHeaders(new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } }), origin);
      }
    }

    // Admin-only: roll back blacklist sync state to re-scan missed events.
    // EVM: rolls back 50000 blocks (~7d Ethereum, ~3.5h Arbitrum).
    // Tron: rolls back 7 days of timestamps.
    // INSERT OR IGNORE in the cron prevents duplicate insertion.
    if (url.pathname === "/api/reset-blacklist-sync") {
      const authError = await (await import("./lib/auth")).requireAdmin(request, env.ADMIN_KEY);
      if (authError) return addCorsHeaders(authError, origin);
      try {
        const response = await runIdempotentAdminAction(
          env.DB,
          "reset-blacklist-sync",
          request,
          async () => {
            const result = await env.DB.batch([
              env.DB.prepare("UPDATE blacklist_sync_state SET last_block = MAX(last_block - 50000, 0) WHERE config_key NOT LIKE 'tron-%'"),
              env.DB.prepare("UPDATE blacklist_sync_state SET last_block = MAX(last_block - 604800000, 0) WHERE config_key LIKE 'tron-%'"),
            ]);
            const evmChanged = result[0]?.meta?.changes ?? 0;
            const tronChanged = result[1]?.meta?.changes ?? 0;
            return new Response(
              JSON.stringify({ ok: true, evmReset: evmChanged, tronReset: tronChanged }),
              { headers: { "Content-Type": "application/json" } },
            );
          },
        );
        return addCorsHeaders(response, origin);
      } catch (err) {
        return addCorsHeaders(new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } }), origin);
      }
    }

    // Admin-only: debug sync state
    if (url.pathname === "/api/debug-sync-state") {
      const authError = await (await import("./lib/auth")).requireAdmin(request, env.ADMIN_KEY);
      if (authError) return addCorsHeaders(authError, origin);
      const rows = await env.DB.prepare("SELECT config_key, last_block FROM blacklist_sync_state ORDER BY config_key").all();
      return addCorsHeaders(new Response(JSON.stringify(rows.results), { headers: { "Content-Type": "application/json" } }), origin);
    }

    const skipCache =
      request.method !== "GET" ||
      isCacheBypassPath(url.pathname);

    // Check edge cache first
    const cache = caches.default;
    const cacheKey = new Request(request.url, { method: "GET" });
    if (!skipCache) {
      const cached = await cache.match(cacheKey);
      if (cached) {
        return addCorsHeaders(cached, origin);
      }
    }

    const response = await route(url, env.DB, ctx, request, env.ADMIN_KEY, env.ALCHEMY_API_KEY ?? null);

    if (!response) {
      return addCorsHeaders(
        new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
        origin
      );
    }

    // Store in edge cache without CORS headers (CORS added per-request)
    if (!skipCache) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }

    return addCorsHeaders(response, origin);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    initChainRpcs(env.ALCHEMY_API_KEY, env.DRPC_API_KEY);
    initAlerts(env.ALERT_WEBHOOK_URL);
    initCoinGecko(env.COINGECKO_API_KEY);
    const db = env.DB;
    const cron = event.cron;
    const mintBurnDisabledIds = parseCsvEnv(env.MINT_BURN_DISABLED_IDS);
    const mintBurnDisabledSymbols = parseCsvEnv(env.MINT_BURN_DISABLED_SYMBOLS);
    const mintBurnMajorSymbols = parseCsvEnv(env.MINT_BURN_MAJOR_SYMBOLS);
    const mintBurnWarnSec = parsePositiveInt(env.MINT_BURN_STALE_WARN_SEC, MINT_BURN_STALE_WARN_SEC);
    const mintBurnCritSec = parsePositiveInt(env.MINT_BURN_STALE_CRIT_SEC, MINT_BURN_STALE_CRIT_SEC);
    const mintBurnAlertCooldownSec = parsePositiveInt(
      env.MINT_BURN_ALERT_COOLDOWN_SEC,
      DEFAULT_MINT_BURN_ALERT_COOLDOWN_SEC,
    );
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
    const runLeasedCron = (job: string, fn: (signal: AbortSignal) => Promise<CronResult | void>) =>
      logCronRun(db, job, async (signal): Promise<CronResult> => {
        const lease = await runCronWithLease(db, job, async ({ signal: leaseSignal }) => {
          const mergedSignal = typeof AbortSignal.any === "function"
            ? AbortSignal.any([signal, leaseSignal])
            : signal;
          return fn(mergedSignal);
        });
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
      });

    switch (cron) {
      case "*/15 * * * *": {
        const stablecoinsSync = runLeasedCron("sync-stablecoins", (signal) => syncStablecoins(db, env.CMC_API_KEY, signal));
        ctx.waitUntil(stablecoinsSync);
        // Retry daily supply snapshots throughout the day so a stale-cache skip at 08:00
        // cannot permanently leave a missing date.
        ctx.waitUntil(stablecoinsSync.then(() =>
          runLeasedCron("snapshot-supply", (signal) => snapshotSupply(db, signal))
        ));
        ctx.waitUntil(runLeasedCron("sync-stablecoin-charts", (signal) => syncStablecoinCharts(db, signal)));
        ctx.waitUntil(runLeasedCron("sync-fx-rates", (signal) => syncFxRates(db, signal)));
        // PSI depends on stablecoins cache + depeg_events — run after sync completes
        ctx.waitUntil(stablecoinsSync.then(() =>
          runLeasedCron("stability-index", (signal) => computeAndStoreStabilityIndex(db, signal))
        ));
        // DEWS depends on stablecoins cache + dex data — run after sync
        ctx.waitUntil(stablecoinsSync.then(() =>
          runLeasedCron("compute-dews", (signal) => computeAndStoreDEWS(db, signal))
        ));
        // Status system self-check: persists hysteresis state and probes critical endpoints.
        ctx.waitUntil(runLeasedCron("status-self-check", (signal) => runStatusSelfCheck(db, env.ADMIN_KEY, signal)));
        // Periodic health alert: warn if stablecoins cache is stale for 30+ minutes
        ctx.waitUntil((async () => {
          try {
            const cached = await getCache(db, "stablecoins");
            if (cached) {
              const age = Math.floor(Date.now() / 1000) - cached.updatedAt;
              if (age > 1800) {
                await sendAlert("Data stale", `Stablecoins cache is ${Math.round(age / 60)}min old (expected <20min)`);
              }
            }
          } catch { /* non-blocking */ }
        })());
        break;
      }
      // Blacklist + mint/burn on a 20-min cycle (offset at :03/:23/:43 to avoid colliding with the 15-min trigger)
      // Blacklist uses Etherscan; mint/burn uses Alchemy (independent providers, independent circuit breakers).
      case "3,23,43 * * * *": {
        // Blacklist — gated by Etherscan circuit breaker
        const etherscanAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.ETHERSCAN);
        if (etherscanAllowed) {
          const etherscanRL = createRateLimiter(4);
          const etherscanKey = env.ETHERSCAN_API_KEY ?? null;
          const blacklistJob = runLeasedCron("sync-blacklist", (signal) =>
            syncBlacklist(db, etherscanKey, env.TRONGRID_API_KEY ?? null, env.DRPC_API_KEY ?? null, etherscanRL, signal)
          );
          ctx.waitUntil(blacklistJob);
          ctx.waitUntil(blacklistJob.then(
            () => recordOutcome(db, CIRCUIT_SOURCE.ETHERSCAN, true),
            () => recordOutcome(db, CIRCUIT_SOURCE.ETHERSCAN, false),
          ));
        } else {
          console.warn("[cron] Etherscan circuit open — skipping blacklist sync");
        }

        // Mint/burn — gated by Alchemy circuit breaker
        const alchemyAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.ALCHEMY);
        if (alchemyAllowed) {
          const mintBurnJob = runLeasedCron("sync-mint-burn", (signal) =>
            syncMintBurn(db, env.ALCHEMY_API_KEY ?? null, {
              signal,
              disabledConfigIds: mintBurnDisabledIds,
              disabledSymbols: mintBurnDisabledSymbols,
            })
          );
          ctx.waitUntil(mintBurnJob);
          ctx.waitUntil(mintBurnJob.then(
            (result) => recordOutcome(
              db,
              CIRCUIT_SOURCE.ALCHEMY,
              (result?.status ?? "ok") === "ok",
            ),
            () => recordOutcome(db, CIRCUIT_SOURCE.ALCHEMY, false),
          ));
          ctx.waitUntil(mintBurnJob.then(async () => {
            try {
              const symbols = mintBurnMajorSymbols.length > 0 ? mintBurnMajorSymbols : [...MINT_BURN_MAJOR_SYMBOLS];
              if (symbols.length === 0) return;
              const now = Math.floor(Date.now() / 1000);
              const rows = await db
                .prepare(
                  `SELECT symbol, MAX(timestamp) as latest_ts
                   FROM mint_burn_events
                   WHERE symbol IN (${symbols.map(() => "?").join(",")})
                   GROUP BY symbol`,
                )
                .bind(...symbols)
                .all<{ symbol: string; latest_ts: number | null }>();

              const latestBySymbol = new Map<string, number>();
              for (const row of rows.results ?? []) {
                if (row.latest_ts != null) latestBySymbol.set(row.symbol, row.latest_ts);
              }

              const warn: string[] = [];
              const crit: string[] = [];
              for (const symbol of symbols) {
                const latest = latestBySymbol.get(symbol);
                const ageSec = latest == null ? Number.POSITIVE_INFINITY : now - latest;
                if (ageSec >= mintBurnCritSec) {
                  crit.push(`${symbol}:${latest == null ? "missing" : Math.round(ageSec / 3600) + "h"}`);
                } else if (ageSec >= mintBurnWarnSec) {
                  warn.push(`${symbol}:${Math.round(ageSec / 3600)}h`);
                }
              }

              const emitAlert = async (severity: "warn" | "crit", details: string[]): Promise<void> => {
                if (details.length === 0) return;
                const cacheKey = `alert:mint-burn-stale:${severity}`;
                const prior = await getCache(db, cacheKey);
                if (prior && now - prior.updatedAt < mintBurnAlertCooldownSec) return;
                const threshold = severity === "crit" ? mintBurnCritSec : mintBurnWarnSec;
                await sendAlert(
                  `Mint/burn staleness (${severity.toUpperCase()})`,
                  `Threshold=${Math.round(threshold / 3600)}h, symbols=${details.join(", ")}`,
                );
                await setCache(db, cacheKey, JSON.stringify({ symbols: details, at: now }));
              };

              await emitAlert("warn", warn);
              await emitAlert("crit", crit);
            } catch {
              // Non-blocking alert path.
            }
          }));
        } else {
          console.warn("[cron] Alchemy circuit open - skipping mint/burn sync");
        }
        break;
      }
      // DEX liquidity + yield data on a 30-min cycle (offset at :10/:40)
      // Yield depends on dex_liquidity for safety scores — chain after DEX sync
      case "10,40 * * * *": {
        const dexSync = runLeasedCron("sync-dex-liquidity", (signal) => syncDexLiquidity(db, env.GRAPH_API_KEY ?? null, env.COINGECKO_API_KEY ?? null, signal));
        ctx.waitUntil(dexSync);
        ctx.waitUntil(dexSync.then(() =>
          runLeasedCron("sync-yield-data", (signal) => syncYieldData(db, signal))
        ));
        break;
      }
      case "0 8 * * *": {
        ctx.waitUntil(runLeasedCron("snapshot-supply", (signal) => snapshotSupply(db, signal)));
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
  },
};

export default worker;

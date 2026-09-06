import { computeCentralizedCustodyFraction } from "@shared/lib/centralized-custody";
import {
  STATUS_COINGECKO_PRICE_DIFF_THRESHOLD_PCT,
} from "@shared/lib/status-thresholds";
import { ACTIVE_IDS, ACTIVE_META_BY_ID, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { isRecord } from "@shared/lib/type-guards";
import type {
  CanaryStatus,
  ClassificationWarning,
  CoinGeckoPriceDiff,
  LiquidityHealth,
  MintBurnReconciliationSummary,
  PublicationHealth,
  PriceSourceHealth,
  ProviderCircuitHealth,
  ReserveDriftEntry,
  StatusResponse,
  StatusSectionError,
  StatusSectionErrors,
  TelegramDispatchCronMetadata,
  TelegramHealthSummary,
  YieldHealthSummary,
} from "@shared/types/status";
import { parseTelegramDispatchCronMetadata } from "@shared/lib/status-metadata";
import { cgHeaders, cgSimplePricePath, cgUrl } from "../coingecko";
import { USER_AGENT } from "../constants";
import { summarizeCollateralDriftFromLiveReserveMap } from "../collateral-drift";
import { cancelResponseBodyQuietly } from "../response-body";
import {
  hasAnyCloudflareD1StatusBinding,
  resolveCloudflareD1StatusConfig,
  type CloudflareD1StatusBindings,
} from "../env";
import { loadFreshIndependentLiveReserveMap } from "../live-reserves/store";
import { validatePricingSourceFreshness } from "../pricing-source-freshness";
import {
  hasUsableStablecoinsPayload,
  loadStablecoinsCache,
  type StablecoinsCacheLoadResult,
} from "../stablecoins-cache";
import {
  getD1UsageSummary,
  type D1UsageSummaryWithTableGrowth,
} from "./d1-usage";
import { getMintBurnReconciliation } from "./derived-data";
import { loadSourceDepthDistribution } from "./price-source-depth";
import { loadYieldHealthSummary } from "./yield-health";
import { logWorkerEvent } from "../structured-log";
import { loadPublicationHealth } from "../publication-contract";
import { loadProviderCircuitHealth } from "../provider-circuit-health";
import { readTelegramPendingCapacity } from "../telegram/pending-capacity";
import { loadCanaryStatus } from "../canary-checks";
import type { WorkerCanaryMode } from "../canary-checks";
import type { StatusSupplements } from "./raw-snapshot";
export type { StatusSupplements } from "./raw-snapshot";

const SECTION_ERROR_MESSAGES: Record<string, string> = {
  liquidity_health_extraction_failed: "Liquidity health data unavailable.",
  publication_health_partial_failure: "Publication health partially unavailable.",
  publication_health_query_failed: "Publication health unavailable.",
  provider_circuit_health_query_failed: "Provider circuit health unavailable.",
  canary_status_query_failed: "Data-invariant canaries unavailable.",
  price_source_health_extraction_failed: "Price source health data unavailable.",
  coingecko_price_diff_query_failed: "CoinGecko price diff unavailable.",
  d1_usage_query_failed: "D1 usage metrics unavailable.",
  mint_burn_reconciliation_query_failed: "Mint/burn reconciliation unavailable.",
  reserve_drift_computation_failed: "Reserve drift diagnostics unavailable.",
  classification_warnings_computation_failed: "Classification warnings unavailable.",
};

function sectionError(code: string, message?: string): StatusSectionError {
  const safeMessage = message ?? SECTION_ERROR_MESSAGES[code] ?? "Section unavailable.";
  return { code, message: safeMessage };
}

function logStatusSupplementWarning(
  event: string,
  message: string,
  error: unknown,
  metadata?: Record<string, unknown>,
): void {
  logWorkerEvent({
    scope: "status",
    level: "warn",
    event,
    route: "status",
    message,
    error,
    ...(metadata ? { metadata } : {}),
  });
}
async function loadTelegramHealthSummary(
  db: D1Database,
  now: number,
): Promise<TelegramHealthSummary | null> {
  try {
    const [chatCount, pendingCapacity, lastDispatch] = await Promise.all([
      db.prepare("SELECT COUNT(*) AS n FROM telegram_subscribers").first<{ n: number }>(),
      readTelegramPendingCapacity(db, now),
      db
        .prepare(
          "SELECT started_at, status, metadata FROM cron_runs WHERE job = 'dispatch-telegram-alerts' ORDER BY started_at DESC LIMIT 1",
        )
        .first<{ started_at: number; status: string; metadata: string | null }>(),
    ]);
    let dispatchMeta: TelegramDispatchCronMetadata | null = null;
    if (lastDispatch?.metadata) {
      try {
        dispatchMeta = parseTelegramDispatchCronMetadata(JSON.parse(lastDispatch.metadata));
      } catch (error) {
        logStatusSupplementWarning(
          "telegram_dispatch_metadata_unavailable",
          "Telegram dispatch metadata unavailable",
          error,
        );
      }
    }
    return {
      totalChats: chatCount?.n ?? 0,
      pendingDeliveries: pendingCapacity.status === "available" ? pendingCapacity.value.active : null,
      pendingDeliveryLifecycleStatus: pendingCapacity.status,
      pendingDeliveryBacklog: pendingCapacity.status === "available"
        ? {
            claimable: pendingCapacity.value.due,
            due: pendingCapacity.value.due,
            deferred: pendingCapacity.value.deferred,
            expired: pendingCapacity.value.expired,
            nearTtl: pendingCapacity.value.nearTtl,
            sending: pendingCapacity.value.sending,
            pendingSending: pendingCapacity.value.pendingSending,
            freshSending: pendingCapacity.value.freshSending,
            executionUnknown: pendingCapacity.value.executionUnknown,
            pendingExecutionUnknown: pendingCapacity.value.pendingExecutionUnknown,
            freshExecutionUnknown: pendingCapacity.value.freshExecutionUnknown,
            oldestExecutionUnknownAgeSec: pendingCapacity.value.oldestExecutionUnknownAgeSec,
            executionUnknownSampleLimit: pendingCapacity.value.executionUnknownSampleLimit,
            executionUnknownLowerBound: pendingCapacity.value.executionUnknownLowerBound,
            sentCleanup: pendingCapacity.value.sentCleanup,
          }
        : undefined,
      lastDispatchAt: lastDispatch?.started_at ?? null,
      lastDispatchStatus: lastDispatch?.status ?? null,
      safetyAlertSourceState: dispatchMeta?.safetyAlertSourceState ?? null,
      safetyAlertSourceAgeSeconds: dispatchMeta?.safetyAlertSourceAgeSeconds ?? null,
      safetyAlertsSuppressed: dispatchMeta?.safetyAlertsSuppressed ?? false,
      safetyAlertSourceGeneration: dispatchMeta?.safetyAlertSourceGeneration ?? null,
      reserveAlertSourceState: dispatchMeta?.reserveAlertSourceState ?? null,
      reserveAlertSourceAgeSeconds: dispatchMeta?.reserveAlertSourceAgeSeconds ?? null,
      reserveAlertsSuppressed: dispatchMeta?.reserveAlertsSuppressed ?? false,
      reserveAlertSourceGeneration: dispatchMeta?.reserveAlertSourceGeneration ?? null,
    };
  } catch (error) {
    logStatusSupplementWarning(
      "telegram_summary_unavailable",
      "Telegram summary unavailable",
      error,
    );
    return null;
  }
}


type CoverageClassCounts = Record<"primary" | "mixed" | "fallback" | "legacy" | "unobserved", number>;

function finiteOr0(raw: unknown): number {
  try {
    const value = Number(raw ?? 0);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function objectValue(raw: unknown, key: string): unknown {
  if (raw == null || typeof raw !== "object") return undefined;
  return Reflect.get(raw, key);
}

function coverageClasses(raw: unknown): CoverageClassCounts {
  return {
    primary: finiteOr0(objectValue(raw, "primary")),
    mixed: finiteOr0(objectValue(raw, "mixed")),
    fallback: finiteOr0(objectValue(raw, "fallback")),
    legacy: finiteOr0(objectValue(raw, "legacy")),
    unobserved: finiteOr0(objectValue(raw, "unobserved")),
  };
}

async function fetchCoinGeckoUsdPrices(
  geckoIds: string[],
  coingeckoApiKey: string,
  now: number,
): Promise<Map<string, number>> {
  const BATCH_SIZE = 250;
  const prices = new Map<string, number>();

  for (let index = 0; index < geckoIds.length; index += BATCH_SIZE) {
    const batch = geckoIds.slice(index, index + BATCH_SIZE);
    const params = new URLSearchParams({
      ids: batch.join(","),
      vs_currencies: "usd",
      include_last_updated_at: "true",
    });
    const response = await fetch(cgUrl(cgSimplePricePath(params), coingeckoApiKey), {
      headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, coingeckoApiKey),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      await cancelResponseBodyQuietly(response);
      throw new Error(`CoinGecko simple price fetch failed (${response.status})`);
    }

    let payload: Record<string, { usd?: number; last_updated_at?: number }> | null;
    try {
      payload = await response.json();
    } catch {
      logWorkerEvent({
        scope: "status",
        level: "warn",
        event: "coingecko_price_response_parse_failed",
        route: "status",
        provider: "coingecko",
        message: "CoinGecko price response parse failed; skipping batch",
        metadata: { batchSize: batch.length },
      });
      continue;
    }
    if (!payload || typeof payload !== "object") continue;
    for (const [geckoId, quote] of Object.entries(payload)) {
      if (typeof quote?.usd !== "number" || !Number.isFinite(quote.usd) || quote.usd <= 0) continue;
      const freshness = validatePricingSourceFreshness({
        source: "coingecko",
        observedAt: quote.last_updated_at,
        observedAtMode: "upstream",
        nowSec: now,
        requireObservedAt: true,
      });
      if (!freshness.accepted) continue;

      prices.set(geckoId, quote.usd);
    }
  }

  return prices;
}

async function loadCoinGeckoPriceDiff(
  db: D1Database,
  now: number,
  coingeckoApiKey: string,
  preloadedCache?: StablecoinsCacheLoadResult,
): Promise<CoinGeckoPriceDiff> {
  const stablecoinsCache = preloadedCache
    ?? (await loadStablecoinsCache(db, { mode: "lenient" }));
  if (!hasUsableStablecoinsPayload(stablecoinsCache)) {
    throw new Error(`stablecoins cache ${stablecoinsCache.reason}`);
  }

  const trackedWithGeckoId = stablecoinsCache.payload.peggedAssets.filter(
    (asset) => ACTIVE_IDS.has(asset.id) && typeof asset.geckoId === "string" && asset.geckoId.length > 0,
  );
  if (trackedWithGeckoId.length === 0) {
    return {
      checkedAt: now,
      trackedWithGeckoId: 0,
      comparedCoins: 0,
      mismatchedCount: 0,
      thresholdPct: STATUS_COINGECKO_PRICE_DIFF_THRESHOLD_PCT,
      rows: [],
    };
  }

  const geckoIds = [...new Set(trackedWithGeckoId.map((asset) => asset.geckoId).filter((value): value is string => Boolean(value)))];
  const coingeckoPrices = await fetchCoinGeckoUsdPrices(geckoIds, coingeckoApiKey, now);

  let comparedCoins = 0;
  const rows = trackedWithGeckoId.flatMap((asset) => {
    const meta = ACTIVE_META_BY_ID.get(asset.id);
    const ourPrice = typeof asset.price === "number" && Number.isFinite(asset.price) && asset.price > 0
      ? asset.price
      : null;
    const geckoId = asset.geckoId;
    const coinGeckoPrice = geckoId ? coingeckoPrices.get(geckoId) ?? null : null;
    if (ourPrice == null || geckoId == null || coinGeckoPrice == null) {
      return [];
    }

    comparedCoins++;
    const diffPct = Math.abs(ourPrice - coinGeckoPrice) / coinGeckoPrice * 100;
    if (diffPct <= STATUS_COINGECKO_PRICE_DIFF_THRESHOLD_PCT) {
      return [];
    }

    return [{
      stablecoinId: asset.id,
      symbol: meta?.symbol ?? asset.symbol,
      name: meta?.name ?? asset.name ?? asset.symbol,
      geckoId,
      ourPrice,
      coinGeckoPrice,
      diffPct,
      priceSource: asset.priceSource ?? "unknown",
      priceConfidence: asset.priceConfidence ?? null,
    }];
  });

  rows.sort((left, right) => right.diffPct - left.diffPct);

  return {
    checkedAt: now,
    trackedWithGeckoId: trackedWithGeckoId.length,
    comparedCoins,
    mismatchedCount: rows.length,
    thresholdPct: STATUS_COINGECKO_PRICE_DIFF_THRESHOLD_PCT,
    rows,
  };
}

export async function loadStatusSupplements(
  db: D1Database,
  now: number,
  crons: StatusResponse["crons"],
  coingeckoApiKey?: string | null,
  cloudflareD1StatusBindings?: CloudflareD1StatusBindings,
  workerCanaryMode: WorkerCanaryMode = "off",
): Promise<StatusSupplements> {
  const sectionErrors: StatusSectionErrors = {};
  const telegramSummary = await loadTelegramHealthSummary(db, now);

  // Load the large stablecoins cache blob once per request; loadCoinGeckoPriceDiff,
  // loadSourceDepthDistribution, and getMintBurnReconciliation all consume it, so a
  // single read avoids three D1 round-trips for the same row (audit S-018). Keep
  // read/runtime failures contained so optional status supplements preserve the
  // endpoint's partial-failure behavior.
  let stablecoinsCache: StablecoinsCacheLoadResult;
  try {
    stablecoinsCache = await loadStablecoinsCache(db, { mode: "lenient" });
  } catch (err) {
    logStatusSupplementWarning(
      "stablecoins_cache_preload_failed",
      "Stablecoins cache preload failed",
      err,
      { source: "stablecoins-cache" },
    );
    stablecoinsCache = { kind: "error", reason: "cache-read-failed", updatedAt: null };
  }

  let liquidityHealth: LiquidityHealth | null = null;
  try {
    const dexLiquidityCron = crons["sync-dex-liquidity"];
    const metadata = dexLiquidityCron?.lastRun?.metadata;
    const sourceCoverage = metadata?.sourceCoverage as Record<string, unknown> | undefined;
    if (dexLiquidityCron?.lastRun && sourceCoverage) {
      liquidityHealth = {
        lastRunStatus: dexLiquidityCron.lastRun.status,
        currentCoverage: Number(sourceCoverage.currentCoverage ?? 0),
        previousCoverage: sourceCoverage.previousCoverage != null ? Number(sourceCoverage.previousCoverage) : null,
        currentGlobalTvl: sourceCoverage.currentGlobalTvl != null ? Number(sourceCoverage.currentGlobalTvl) : null,
        previousGlobalTvl: sourceCoverage.previousGlobalTvl != null ? Number(sourceCoverage.previousGlobalTvl) : null,
        currentTop10CoveredTvl: sourceCoverage.currentTop10CoveredTvl != null ? Number(sourceCoverage.currentTop10CoveredTvl) : null,
        previousTop10CoveredTvl: sourceCoverage.previousTop10CoveredTvl != null ? Number(sourceCoverage.previousTop10CoveredTvl) : null,
        currentTop10GuardTvl: sourceCoverage.currentTop10GuardTvl != null ? Number(sourceCoverage.currentTop10GuardTvl) : null,
        previousTop10GuardTvl: sourceCoverage.previousTop10GuardTvl != null ? Number(sourceCoverage.previousTop10GuardTvl) : null,
        failedSources: Array.isArray(metadata?.failedSources) ? metadata.failedSources.filter((v): v is string => typeof v === "string") : [],
        nearCoverageGuard: Boolean(sourceCoverage.nearCoverageGuard),
        nearValueGuard: Boolean(sourceCoverage.nearValueGuard),
        nearMajorCoverageGuard: Boolean(sourceCoverage.nearMajorCoverageGuard),
        currentCoverageClasses: coverageClasses(sourceCoverage.currentCoverageClasses),
        previousCoverageClasses: coverageClasses(sourceCoverage.previousCoverageClasses),
      };
    }
  } catch (err) {
    logStatusSupplementWarning(
      "liquidity_health_extraction_failed",
      "Liquidity health extraction failed",
      err,
    );
    sectionErrors.liquidityHealth = sectionError(
      "liquidity_health_extraction_failed",
    );
  }

  let yieldHealth: YieldHealthSummary | null = null;
  try {
    yieldHealth = await loadYieldHealthSummary(db, now, crons);
  } catch (err) {
    logStatusSupplementWarning(
      "yield_health_summary_failed",
      "Yield health summary failed",
      err,
    );
    sectionErrors.yieldHealth = sectionError(
      "yield_health_summary_failed",
      "Yield health summary unavailable.",
    );
  }

  let publicationHealth: PublicationHealth | null = null;
  try {
    publicationHealth = await loadPublicationHealth(db, now);
    if ((publicationHealth.failedSurfaces?.length ?? 0) > 0) {
      sectionErrors.publicationHealth = sectionError(
        "publication_health_partial_failure",
      );
    }
  } catch (err) {
    logStatusSupplementWarning(
      "publication_health_query_failed",
      "Publication health query failed",
      err,
    );
    sectionErrors.publicationHealth = sectionError(
      "publication_health_query_failed",
    );
  }

  let providerCircuitHealth: ProviderCircuitHealth | null = null;
  try {
    providerCircuitHealth = await loadProviderCircuitHealth(db, now);
  } catch (err) {
    logStatusSupplementWarning(
      "provider_circuit_health_query_failed",
      "Provider circuit health query failed",
      err,
    );
    sectionErrors.providerCircuitHealth = sectionError(
      "provider_circuit_health_query_failed",
    );
  }

  let canaries: CanaryStatus | null = null;
  try {
    canaries = await loadCanaryStatus(db, now, workerCanaryMode);
  } catch (err) {
    logStatusSupplementWarning(
      "canary_status_query_failed",
      "Data-invariant canary status query failed",
      err,
    );
    sectionErrors.canaries = sectionError(
      "canary_status_query_failed",
    );
  }

  let priceSourceHealth: PriceSourceHealth | null = null;
  try {
    const syncStablecoinsCron = crons["sync-stablecoins"];
    const metadata = syncStablecoinsCron?.lastRun?.metadata;
    if (metadata?.priceSourceHealth) {
      priceSourceHealth = metadata.priceSourceHealth as PriceSourceHealth;
      try {
        const sourceDepthDistribution = await loadSourceDepthDistribution(db, stablecoinsCache);
        if (sourceDepthDistribution) {
          priceSourceHealth = {
            ...priceSourceHealth,
            sourceDepthDistribution: priceSourceHealth.sourceDepthDistribution ?? sourceDepthDistribution,
          };
        }
      } catch (err) {
        logStatusSupplementWarning(
          "price_source_depth_distribution_unavailable",
          "Price source depth distribution unavailable",
          err,
        );
      }
    }
  } catch (err) {
    logStatusSupplementWarning(
      "price_source_health_extraction_failed",
      "Price source health extraction failed",
      err,
    );
    sectionErrors.priceSourceHealth = sectionError(
      "price_source_health_extraction_failed",
    );
  }

  let coingeckoPriceDiff: CoinGeckoPriceDiff | null = null;
  if (coingeckoApiKey) {
    try {
      coingeckoPriceDiff = await loadCoinGeckoPriceDiff(db, now, coingeckoApiKey, stablecoinsCache);
    } catch (err) {
      logWorkerEvent({
        scope: "status",
        level: "warn",
        event: "coingecko_price_diff_query_failed",
        route: "status",
        provider: "coingecko",
        message: "CoinGecko price diff query failed",
        error: err,
      });
      sectionErrors.coingeckoPriceDiff = sectionError(
        "coingecko_price_diff_query_failed",
      );
    }
  }

  let d1Usage: D1UsageSummaryWithTableGrowth | null = null;
  try {
    const d1StatusConfig = cloudflareD1StatusBindings
      ? resolveCloudflareD1StatusConfig(cloudflareD1StatusBindings)
      : null;
    if (d1StatusConfig) {
      d1Usage = await getD1UsageSummary(d1StatusConfig, now, db);
    } else if (cloudflareD1StatusBindings && hasAnyCloudflareD1StatusBinding(cloudflareD1StatusBindings)) {
      sectionErrors.d1Usage = sectionError(
        "cloudflare_d1_status_config_incomplete",
        "CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_STATUS_API_TOKEN, and CLOUDFLARE_D1_DATABASE_ID must be configured together for admin D1 metrics.",
      );
    }
  } catch (err) {
    logStatusSupplementWarning(
      "d1_usage_loader_failed",
      "D1 usage loader failed",
      err,
      { source: "cloudflare-d1-status" },
    );
    sectionErrors.d1Usage = sectionError(
      "d1_usage_query_failed",
    );
  }


  let mintBurnReconciliation: MintBurnReconciliationSummary | null = null;
  try {
    mintBurnReconciliation = await getMintBurnReconciliation(db, now, stablecoinsCache);
  } catch (err) {
    logStatusSupplementWarning(
      "mint_burn_reconciliation_query_failed",
      "Mint/burn reconciliation query failed",
      err,
    );
    sectionErrors.mintBurnReconciliation = sectionError(
      "mint_burn_reconciliation_query_failed",
    );
  }

  let reserveDrift: ReserveDriftEntry[] | undefined;
  try {
    const liveReserveMap = await loadFreshIndependentLiveReserveMap(db, now);
    const { driftCoins } = summarizeCollateralDriftFromLiveReserveMap(liveReserveMap, ACTIVE_STABLECOINS);
    const driftEntries: ReserveDriftEntry[] = driftCoins.map((entry) => ({
      coinId: entry.id,
      liveCollateralScore: entry.liveScore,
      curatedCollateralScore: entry.curatedScore,
      delta: entry.delta,
    }));
    driftEntries.sort((a, b) => b.delta - a.delta);
    if (driftEntries.length > 0) reserveDrift = driftEntries;
  } catch (err) {
    logStatusSupplementWarning(
      "reserve_drift_computation_failed",
      "Reserve drift computation failed",
      err,
      { source: "live-reserves" },
    );
    sectionErrors.reserveDrift = sectionError(
      "reserve_drift_computation_failed",
    );
  }

  let classificationWarnings: ClassificationWarning[] | undefined;
  try {
    const threshold = 0.50;
    const warnings: ClassificationWarning[] = [];
    const defiCoins = ACTIVE_STABLECOINS.filter((c) => c.flags.governance === "decentralized");
    for (const coin of defiCoins) {
      const fraction = computeCentralizedCustodyFraction(coin.id, ACTIVE_STABLECOINS);
      if (fraction > threshold) {
        warnings.push({
          coinId: coin.id,
          governance: coin.flags.governance,
          centralizedCustodyPct: Math.round(fraction * 100),
          threshold: threshold * 100,
        });
      }
    }
    if (warnings.length > 0) classificationWarnings = warnings;
  } catch (err) {
    logStatusSupplementWarning(
      "classification_warnings_computation_failed",
      "Classification warnings computation failed",
      err,
    );
    sectionErrors.classificationWarnings = sectionError(
      "classification_warnings_computation_failed",
    );
  }

  return {
    liquidityHealth,
    yieldHealth,
    publicationHealth,
    providerCircuitHealth,
    canaries,
    priceSourceHealth,
    coingeckoPriceDiff,
    d1Usage,
    mintBurnReconciliation,
    reserveDrift,
    classificationWarnings,
    telegramSummary,
    sectionErrors,
  };
}

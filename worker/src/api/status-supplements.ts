import { computeCentralizedCustodyFraction } from "@shared/lib/centralized-custody";
import {
  STATUS_COINGECKO_PRICE_DIFF_THRESHOLD_PCT,
} from "@shared/lib/status-thresholds";
import { ACTIVE_IDS, ACTIVE_META_BY_ID, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { isRecord } from "@shared/lib/type-guards";
import type {
  ClassificationWarning,
  CanaryStatus,
  CoinGeckoPriceDiff,
  D1UsageSummary,
  LiquidityHealth,
  MintBurnReconciliationSummary,
  PublicationHealth,
  PriceSourceHealth,
  ProviderCircuitHealth,
  ReserveDriftEntry,
  StatusResponse,
  StatusSectionError,
  StatusSectionErrors,
  YieldHealthSummary,
} from "@shared/types/status";
import { cgHeaders, cgUrl } from "../lib/coingecko";
import { USER_AGENT } from "../lib/constants";
import { summarizeCollateralDriftFromLiveReserveMap } from "../lib/collateral-drift";
import { cancelResponseBodyQuietly } from "../lib/response-body";
import {
  hasAnyCloudflareD1StatusBinding,
  resolveCloudflareD1StatusConfig,
  type CloudflareD1StatusBindings,
} from "../lib/env";
import { loadFreshIndependentLiveReserveMap } from "../lib/live-reserves-store";
import { validatePricingSourceFreshness } from "../lib/pricing-source-freshness";
import {
  hasUsableStablecoinsPayload,
  loadStablecoinsCache,
  type StablecoinsCacheLoadResult,
} from "../lib/stablecoins-cache";
import { getCacheBlobSizes, getD1UsageSummary } from "../lib/status/d1-usage";
import { getMintBurnReconciliation } from "../lib/status/derived-data";
import { loadSourceDepthDistribution } from "../lib/status/price-source-depth";
import { loadYieldHealthSummary } from "../lib/status/yield-health";
import { logWorkerEvent } from "../lib/structured-log";
import { loadPublicationHealth } from "../lib/publication-contract";
import { loadProviderCircuitHealth } from "../lib/provider-circuit-health";
import { loadCanaryStatus } from "../lib/canary-checks";
import type { WorkerCanaryMode } from "../lib/canary-checks";

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

export interface StatusSupplements {
  liquidityHealth: LiquidityHealth | null;
  yieldHealth: YieldHealthSummary | null;
  publicationHealth: PublicationHealth | null;
  providerCircuitHealth: ProviderCircuitHealth | null;
  canaries: CanaryStatus | null;
  priceSourceHealth: PriceSourceHealth | null;
  priceProviderDiagnostics: Array<Record<string, unknown>> | null;
  gtProbe: Record<string, unknown> | null;
  coingeckoPriceDiff: CoinGeckoPriceDiff | null;
  d1Usage: D1UsageSummary | null;
  cacheBlobSizes?: Record<string, number>;
  mintBurnReconciliation: MintBurnReconciliationSummary | null;
  reserveDrift?: ReserveDriftEntry[];
  classificationWarnings?: ClassificationWarning[];
  sectionErrors: StatusSectionErrors;
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
    const response = await fetch(cgUrl(`/simple/price?${params.toString()}`, coingeckoApiKey), {
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
    ?? (await loadStablecoinsCache(db, { mode: "lenient", allowLegacyArray: true }));
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

  // Load the large stablecoins cache blob once per request; loadCoinGeckoPriceDiff,
  // loadSourceDepthDistribution, and getMintBurnReconciliation all consume it, so a
  // single read avoids three D1 round-trips for the same row (audit S-018). Keep
  // read/runtime failures contained so optional status supplements preserve the
  // endpoint's partial-failure behavior.
  let stablecoinsCache: StablecoinsCacheLoadResult;
  try {
    stablecoinsCache = await loadStablecoinsCache(db, { mode: "lenient", allowLegacyArray: true });
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
  let priceProviderDiagnostics: Array<Record<string, unknown>> | null = null;
  let gtProbe: Record<string, unknown> | null = null;
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
    if (Array.isArray(metadata?.providerDiagnostics)) {
      priceProviderDiagnostics = metadata.providerDiagnostics.filter(
        (entry): entry is Record<string, unknown> => isRecord(entry),
      );
    }
    const rawGtProbe = metadata?.gtProbe;
    if (isRecord(rawGtProbe)) {
      gtProbe = rawGtProbe;
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

  let d1Usage: D1UsageSummary | null = null;
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

  let cacheBlobSizes: Record<string, number> | undefined;
  try {
    cacheBlobSizes = await getCacheBlobSizes(db);
  } catch (err) {
    logStatusSupplementWarning(
      "cache_blob_sizes_query_failed",
      "Cache blob sizes query failed",
      err,
      { source: "cache" },
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
    priceProviderDiagnostics,
    gtProbe,
    coingeckoPriceDiff,
    d1Usage,
    cacheBlobSizes,
    mintBurnReconciliation,
    reserveDrift,
    classificationWarnings,
    sectionErrors,
  };
}

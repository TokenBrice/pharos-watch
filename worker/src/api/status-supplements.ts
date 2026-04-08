import { computeCentralizedCustodyFraction } from "@shared/lib/centralized-custody";
import {
  isReserveDriftThresholdExceeded,
  STATUS_COINGECKO_PRICE_DIFF_THRESHOLD_PCT,
} from "@shared/lib/status-thresholds";
import { ACTIVE_IDS, ACTIVE_META_BY_ID, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import type {
  ClassificationWarning,
  CoinGeckoPriceDiff,
  D1UsageSummary,
  DiscoveryCandidate,
  LiquidityHealth,
  MintBurnReconciliationSummary,
  PriceSourceHealth,
  ReserveDriftEntry,
  StatusResponse,
  StatusSectionError,
  StatusSectionErrors,
} from "@shared/types/status";
import { computeCollateralQualityFromReserves } from "@shared/lib/report-cards";
import { cgHeaders, cgUrl } from "../lib/coingecko";
import { USER_AGENT } from "../lib/constants";
import { cancelResponseBodyQuietly } from "../lib/response-body";
import {
  hasAnyCloudflareD1StatusBinding,
  resolveCloudflareD1StatusConfig,
  type CloudflareD1StatusBindings,
} from "../lib/env";
import {
  DISCOVERY_CANDIDATE_SELECT_COLUMNS,
  mapDiscoveryCandidateRow,
  type DiscoveryCandidateRow,
} from "../lib/discovery-candidates";
import { loadFreshIndependentLiveReserveMap } from "../lib/live-reserves-store";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../lib/stablecoins-cache";
import { getCacheBlobSizes, getD1UsageSummary } from "../lib/status/d1-usage";
import { getMintBurnReconciliation } from "../lib/status/derived-data";

function sectionError(code: string, message?: string): StatusSectionError {
  const safeMessage = message ?? (
    code === "discovery_candidates_query_failed"
      ? "Discovery candidates unavailable."
      : code === "liquidity_health_extraction_failed"
        ? "Liquidity health data unavailable."
        : code === "price_source_health_extraction_failed"
          ? "Price source health data unavailable."
          : code === "coingecko_price_diff_query_failed"
            ? "CoinGecko price diff unavailable."
            : code === "d1_usage_query_failed"
              ? "D1 usage metrics unavailable."
              : code === "mint_burn_reconciliation_query_failed"
                ? "Mint/burn reconciliation unavailable."
                : code === "reserve_drift_computation_failed"
                  ? "Reserve drift diagnostics unavailable."
                  : code === "classification_warnings_computation_failed"
                    ? "Classification warnings unavailable."
                    : "Section unavailable."
  );
  return { code, message: safeMessage };
}

export interface StatusSupplements {
  liquidityHealth: LiquidityHealth | null;
  priceSourceHealth: PriceSourceHealth | null;
  coingeckoPriceDiff: CoinGeckoPriceDiff | null;
  d1Usage: D1UsageSummary | null;
  cacheBlobSizes?: Record<string, number>;
  discoveryCandidates: DiscoveryCandidate[] | null;
  mintBurnReconciliation: MintBurnReconciliationSummary | null;
  reserveDrift?: ReserveDriftEntry[];
  classificationWarnings?: ClassificationWarning[];
  sectionErrors: StatusSectionErrors;
}

async function fetchCoinGeckoUsdPrices(
  geckoIds: string[],
  coingeckoApiKey: string,
): Promise<Map<string, number>> {
  const BATCH_SIZE = 250;
  const prices = new Map<string, number>();

  for (let index = 0; index < geckoIds.length; index += BATCH_SIZE) {
    const batch = geckoIds.slice(index, index + BATCH_SIZE);
    const params = new URLSearchParams({
      ids: batch.join(","),
      vs_currencies: "usd",
    });
    const response = await fetch(cgUrl(`/simple/price?${params.toString()}`, coingeckoApiKey), {
      headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, coingeckoApiKey),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      await cancelResponseBodyQuietly(response);
      throw new Error(`CoinGecko simple price fetch failed (${response.status})`);
    }

    let payload: Record<string, { usd?: number }> | null;
    try {
      payload = await response.json();
    } catch {
      console.warn("[status-supplements] CoinGecko price response parse failed — skipping batch");
      continue;
    }
    if (!payload || typeof payload !== "object") continue;
    for (const [geckoId, quote] of Object.entries(payload)) {
      if (typeof quote?.usd === "number" && Number.isFinite(quote.usd) && quote.usd > 0) {
        prices.set(geckoId, quote.usd);
      }
    }
  }

  return prices;
}

async function loadCoinGeckoPriceDiff(
  db: D1Database,
  now: number,
  coingeckoApiKey: string,
): Promise<CoinGeckoPriceDiff> {
  const stablecoinsCache = await loadStablecoinsCache(db, { mode: "lenient", allowLegacyArray: true });
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
  const coingeckoPrices = await fetchCoinGeckoUsdPrices(geckoIds, coingeckoApiKey);

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
): Promise<StatusSupplements> {
  const sectionErrors: StatusSectionErrors = {};

  let discoveryCandidates: DiscoveryCandidate[] | null = null;
  try {
    const discRows = await db.prepare(
      `SELECT ${DISCOVERY_CANDIDATE_SELECT_COLUMNS} FROM discovery_candidates WHERE dismissed = 0 ORDER BY market_cap DESC LIMIT 20`,
    ).all<DiscoveryCandidateRow>();
    discoveryCandidates = (discRows.results ?? []).map((row) => mapDiscoveryCandidateRow(row, now));
  } catch (err) {
    console.warn("[status] Discovery candidates query failed:", err);
    sectionErrors.discoveryCandidates = sectionError(
      "discovery_candidates_query_failed",
    );
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
        failedSources: Array.isArray(metadata?.failedSources) ? metadata.failedSources.filter((v): v is string => typeof v === "string") : [],
        nearCoverageGuard: Boolean(sourceCoverage.nearCoverageGuard),
        nearValueGuard: Boolean(sourceCoverage.nearValueGuard),
        nearMajorCoverageGuard: Boolean(sourceCoverage.nearMajorCoverageGuard),
        currentCoverageClasses: {
          primary: Number((sourceCoverage.currentCoverageClasses as Record<string, unknown> | undefined)?.primary ?? 0),
          mixed: Number((sourceCoverage.currentCoverageClasses as Record<string, unknown> | undefined)?.mixed ?? 0),
          fallback: Number((sourceCoverage.currentCoverageClasses as Record<string, unknown> | undefined)?.fallback ?? 0),
          legacy: Number((sourceCoverage.currentCoverageClasses as Record<string, unknown> | undefined)?.legacy ?? 0),
          unobserved: Number((sourceCoverage.currentCoverageClasses as Record<string, unknown> | undefined)?.unobserved ?? 0),
        },
        previousCoverageClasses: {
          primary: Number((sourceCoverage.previousCoverageClasses as Record<string, unknown> | undefined)?.primary ?? 0),
          mixed: Number((sourceCoverage.previousCoverageClasses as Record<string, unknown> | undefined)?.mixed ?? 0),
          fallback: Number((sourceCoverage.previousCoverageClasses as Record<string, unknown> | undefined)?.fallback ?? 0),
          legacy: Number((sourceCoverage.previousCoverageClasses as Record<string, unknown> | undefined)?.legacy ?? 0),
          unobserved: Number((sourceCoverage.previousCoverageClasses as Record<string, unknown> | undefined)?.unobserved ?? 0),
        },
      };
    }
  } catch (err) {
    console.warn("[status] Liquidity health extraction failed:", err);
    sectionErrors.liquidityHealth = sectionError(
      "liquidity_health_extraction_failed",
    );
  }

  let priceSourceHealth: PriceSourceHealth | null = null;
  try {
    const syncStablecoinsCron = crons["sync-stablecoins"];
    const metadata = syncStablecoinsCron?.lastRun?.metadata;
    if (metadata?.priceSourceHealth) {
      priceSourceHealth = metadata.priceSourceHealth as PriceSourceHealth;
    }
  } catch (err) {
    console.warn("[status] Price source health extraction failed:", err);
    sectionErrors.priceSourceHealth = sectionError(
      "price_source_health_extraction_failed",
    );
  }

  let coingeckoPriceDiff: CoinGeckoPriceDiff | null = null;
  if (coingeckoApiKey) {
    try {
      coingeckoPriceDiff = await loadCoinGeckoPriceDiff(db, now, coingeckoApiKey);
    } catch (err) {
      console.warn("[status] CoinGecko price diff query failed:", err);
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
      d1Usage = await getD1UsageSummary(d1StatusConfig, now);
    } else if (cloudflareD1StatusBindings && hasAnyCloudflareD1StatusBinding(cloudflareD1StatusBindings)) {
      sectionErrors.d1Usage = sectionError(
        "cloudflare_d1_status_config_incomplete",
        "CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_STATUS_API_TOKEN, and CLOUDFLARE_D1_DATABASE_ID must be configured together for admin D1 metrics.",
      );
    }
  } catch (err) {
    console.warn("[status] D1 usage loader failed:", err);
    sectionErrors.d1Usage = sectionError(
      "d1_usage_query_failed",
    );
  }

  let cacheBlobSizes: Record<string, number> | undefined;
  try {
    cacheBlobSizes = await getCacheBlobSizes(db);
  } catch (err) {
    console.warn("[status] Cache blob sizes query failed:", err);
  }

  let mintBurnReconciliation: MintBurnReconciliationSummary | null = null;
  try {
    mintBurnReconciliation = await getMintBurnReconciliation(db, now);
  } catch (err) {
    console.warn("[status] Mint/burn reconciliation query failed:", err);
    sectionErrors.mintBurnReconciliation = sectionError(
      "mint_burn_reconciliation_query_failed",
    );
  }

  let reserveDrift: ReserveDriftEntry[] | undefined;
  try {
    const liveReserveMap = await loadFreshIndependentLiveReserveMap(db, now);
    const driftEntries: ReserveDriftEntry[] = [];
    for (const [coinId, liveSlices] of liveReserveMap) {
      const meta = ACTIVE_STABLECOINS.find((c) => c.id === coinId);
      if (!meta?.reserves?.length) continue;
      const liveScore = computeCollateralQualityFromReserves(liveSlices);
      const curatedScore = computeCollateralQualityFromReserves(meta.reserves);
      const delta = Math.abs(liveScore - curatedScore);
      if (isReserveDriftThresholdExceeded(delta)) {
        driftEntries.push({ coinId, liveCollateralScore: liveScore, curatedCollateralScore: curatedScore, delta });
      }
    }
    driftEntries.sort((a, b) => b.delta - a.delta);
    if (driftEntries.length > 0) reserveDrift = driftEntries;
  } catch (err) {
    console.warn("[status] Reserve drift computation failed:", err);
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
    console.warn("[status] Classification warnings computation failed:", err);
    sectionErrors.classificationWarnings = sectionError(
      "classification_warnings_computation_failed",
    );
  }

  return {
    liquidityHealth,
    priceSourceHealth,
    coingeckoPriceDiff,
    d1Usage,
    cacheBlobSizes,
    discoveryCandidates,
    mintBurnReconciliation,
    reserveDrift,
    classificationWarnings,
    sectionErrors,
  };
}

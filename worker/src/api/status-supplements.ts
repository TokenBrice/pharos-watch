import { computeCentralizedCustodyFraction } from "@shared/lib/centralized-custody";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import type {
  ClassificationWarning,
  DiscoveryCandidate,
  LiquidityHealth,
  MintBurnReconciliationSummary,
  PriceSourceHealth,
  ReserveDriftEntry,
  StatusResponse,
  StatusSectionError,
  StatusSectionErrors,
} from "@shared/types";
import { computeCollateralQualityFromReserves } from "@shared/lib/report-cards";
import { loadFreshLiveReserveMap } from "../lib/live-reserves-store";
import { getMintBurnReconciliation } from "../lib/status/derived-data";

function sectionError(code: string, message: string): StatusSectionError {
  return { code, message };
}

export interface StatusSupplements {
  liquidityHealth: LiquidityHealth | null;
  priceSourceHealth: PriceSourceHealth | null;
  discoveryCandidates: DiscoveryCandidate[] | null;
  mintBurnReconciliation: MintBurnReconciliationSummary | null;
  reserveDrift?: ReserveDriftEntry[];
  classificationWarnings?: ClassificationWarning[];
  sectionErrors: StatusSectionErrors;
}

export async function loadStatusSupplements(
  db: D1Database,
  now: number,
  crons: StatusResponse["crons"],
): Promise<StatusSupplements> {
  const sectionErrors: StatusSectionErrors = {};

  let discoveryCandidates: DiscoveryCandidate[] | null = null;
  try {
    const discRows = await db.prepare(
      "SELECT id, gecko_id, llama_id, name, symbol, market_cap, source, first_seen, last_seen, dismissed FROM discovery_candidates WHERE dismissed = 0 ORDER BY market_cap DESC LIMIT 20",
    ).all();
    discoveryCandidates = (discRows.results ?? []).map((row: Record<string, unknown>) => ({
      id: row.id as number,
      geckoId: row.gecko_id as string | null,
      llamaId: row.llama_id as number | null,
      name: row.name as string,
      symbol: row.symbol as string,
      marketCap: row.market_cap as number | null,
      source: row.source as "defillama" | "coingecko" | "both",
      firstSeen: row.first_seen as number,
      lastSeen: row.last_seen as number,
      daysSeen: Math.max(1, Math.floor((now - (row.first_seen as number)) / 86400)),
      dismissed: false,
    }));
  } catch (err) {
    console.warn("[status] Discovery candidates query failed:", err);
    sectionErrors.discoveryCandidates = sectionError(
      "discovery_candidates_query_failed",
      err instanceof Error ? err.message : String(err),
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
      err instanceof Error ? err.message : String(err),
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
      err instanceof Error ? err.message : String(err),
    );
  }

  let mintBurnReconciliation: MintBurnReconciliationSummary | null = null;
  try {
    mintBurnReconciliation = await getMintBurnReconciliation(db, now);
  } catch (err) {
    console.warn("[status] Mint/burn reconciliation query failed:", err);
    sectionErrors.mintBurnReconciliation = sectionError(
      "mint_burn_reconciliation_query_failed",
      err instanceof Error ? err.message : String(err),
    );
  }

  let reserveDrift: ReserveDriftEntry[] | undefined;
  try {
    const liveReserveMap = await loadFreshLiveReserveMap(db, now);
    const driftEntries: ReserveDriftEntry[] = [];
    for (const [coinId, liveSlices] of liveReserveMap) {
      const meta = ACTIVE_STABLECOINS.find((c) => c.id === coinId);
      if (!meta?.reserves?.length) continue;
      const liveScore = computeCollateralQualityFromReserves(liveSlices);
      const curatedScore = computeCollateralQualityFromReserves(meta.reserves);
      const delta = Math.abs(liveScore - curatedScore);
      if (delta > 5) {
        driftEntries.push({ coinId, liveCollateralScore: liveScore, curatedCollateralScore: curatedScore, delta });
      }
    }
    driftEntries.sort((a, b) => b.delta - a.delta);
    if (driftEntries.length > 0) reserveDrift = driftEntries;
  } catch (err) {
    console.warn("[status] Reserve drift computation failed:", err);
    sectionErrors.reserveDrift = sectionError(
      "reserve_drift_computation_failed",
      err instanceof Error ? err.message : String(err),
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
      err instanceof Error ? err.message : String(err),
    );
  }

  return {
    liquidityHealth,
    priceSourceHealth,
    discoveryCandidates,
    mintBurnReconciliation,
    reserveDrift,
    classificationWarnings,
    sectionErrors,
  };
}

import { BACKING_LABELS_SHORT, GOVERNANCE_LABELS_SHORT, PEG_LABELS_SHORT } from "@shared/lib/classification";
import type { BlacklistStatus } from "@shared/lib/report-cards";
import { COVERAGE_FEATURES } from "@/lib/coverage-features";
import { resolveBlacklistCoverage } from "@/lib/coverage/blacklist";
import { resolveDependencyCoverage } from "@/lib/coverage/dependency";
import { resolveDexCoverage } from "@/lib/coverage/dex";
import { resolveFlowCoverage } from "@/lib/coverage/flows";
import { resolvePriceCoverage } from "@/lib/coverage/price";
import { resolveRedemptionCoverage } from "@/lib/coverage/redemption";
import { resolveReserveCoverage } from "@/lib/coverage/reserves";
import { resolveSafetyCoverage } from "@/lib/coverage/safety";
import { resolveYieldCoverage } from "@/lib/coverage/yield";
import type {
  CoverageFeatureDefinition,
  CoverageFeatureKey,
  CoverageFeatureSummary,
  CoverageRow,
  CoverageStatus,
  CoverageTone,
} from "@/lib/coverage-types";
import type {
  LiquidityCoverageClass,
  MintBurnCoverageStatus,
  RedemptionBackstopEntry,
  StablecoinMeta,
} from "@shared/types";

export type {
  CoverageBreakdownItem,
  CoverageFeatureDefinition,
  CoverageFeatureKey,
  CoverageFeatureSummary,
  CoverageRow,
  CoverageStatus,
  CoverageTone,
} from "@/lib/coverage-types";

// Per-feature resolver re-exports (preserve existing public API).
export { resolveBlacklistCoverage } from "@/lib/coverage/blacklist";
export { resolveDependencyCoverage } from "@/lib/coverage/dependency";
export { DEX_STATUS_PRESETS, resolveDexCoverage } from "@/lib/coverage/dex";
export { FLOW_STATUS_PRESETS, resolveFlowCoverage } from "@/lib/coverage/flows";
export { resolvePriceCoverage } from "@/lib/coverage/price";
export { REDEMPTION_ROUTE_STATUS_PRESETS, resolveRedemptionCoverage } from "@/lib/coverage/redemption";
export { resolveReserveCoverage } from "@/lib/coverage/reserves";
export { resolveSafetyCoverage, SAFETY_STATUS_PRESETS } from "@/lib/coverage/safety";
export { resolveYieldCoverage } from "@/lib/coverage/yield";

export { COVERAGE_FEATURES };

interface BuildCoverageRowInput {
  coin: StablecoinMeta;
  marketCapUsd: number;
  hasPegCoverage: boolean;
  consensusSources?: string[];
  priceConfidence?: string;
  safetyScore: number | null | undefined;
  dexCoverageClass: LiquidityCoverageClass | null | undefined;
  redemptionEntry?: RedemptionBackstopEntry | null | undefined;
  hasYieldCoverage: boolean;
  flowCoverageStatus: MintBurnCoverageStatus | null | undefined;
  hasDependencyCoverage: boolean;
  blacklistStatus?: BlacklistStatus | null;
  liveReserveFresh?: boolean | null;
  dataAvailability?: Partial<Record<CoverageFeatureKey, boolean>>;
}

export const COVERAGE_BADGE_TONE_CLASS: Record<CoverageTone, string> = {
  emerald: "border-emerald-500/22 bg-emerald-500/8 text-emerald-800 dark:text-emerald-300",
  sky: "border-sky-500/24 bg-sky-500/8 text-sky-800 dark:text-sky-300",
  amber: "border-amber-500/30 bg-amber-500/12 text-amber-800 dark:text-amber-300",
  violet: "border-violet-500/28 bg-violet-500/10 text-violet-800 dark:text-violet-300",
  rose: "border-rose-500/35 bg-rose-500/12 text-rose-800 dark:text-rose-300",
  slate: "border-border/70 bg-muted/70 text-muted-foreground",
};

export function buildCoverageFeatureSummary(
  feature: CoverageFeatureDefinition,
  rows: CoverageRow[],
  totalMcapUsd: number,
): CoverageFeatureSummary {
  const scopedRows = feature.scopeFilter ? rows.filter((row) => feature.scopeFilter!(row)) : rows;
  const availableRows = scopedRows.filter((row) => row.statuses[feature.key].available);
  const primaryRows = feature.headlineFilter
    ? scopedRows.filter((row) => feature.headlineFilter!(row))
    : feature.headlineKinds?.length
      ? scopedRows.filter((row) => feature.headlineKinds?.includes(row.statuses[feature.key].kind))
      : availableRows;
  const coveredMcapUsd = primaryRows.reduce((sum, row) => sum + row.marketCapUsd, 0);
  const scopedMcapUsd = feature.scopeFilter
    ? scopedRows.reduce((sum, row) => sum + row.marketCapUsd, 0)
    : totalMcapUsd;
  const breakdownMap = new Map<string, number>();
  const coveragePct = scopedRows.length > 0 ? (primaryRows.length / scopedRows.length) * 100 : 0;

  for (const row of scopedRows) {
    const kind = row.statuses[feature.key].kind;
    breakdownMap.set(kind, (breakdownMap.get(kind) ?? 0) + 1);
  }

  return {
    feature,
    availableCount: primaryRows.length,
    totalCount: scopedRows.length,
    coveragePct,
    coveredMcapUsd,
    mcapSharePct: scopedMcapUsd > 0 ? (coveredMcapUsd / scopedMcapUsd) * 100 : null,
    countLabel: feature.headlineCountLabel ?? "Coin count",
    coverageLabel: feature.headlineCoverageLabel?.(coveragePct) ?? `${coveragePct.toFixed(0)}% of active coins`,
    shareLabel: feature.headlineShareLabel ?? "Active market-cap reach",
    breakdown: feature.formatBreakdown(scopedRows, breakdownMap),
  };
}

export function countAvailableFeatures(
  statuses: Record<CoverageFeatureKey, CoverageStatus>,
  keys?: readonly CoverageFeatureKey[],
): number {
  const targetKeys = keys ?? (Object.keys(statuses) as CoverageFeatureKey[]);
  return targetKeys.reduce((count, key) => count + (statuses[key].available ? 1 : 0), 0);
}

function isHeadlineFeatureCovered(featureKey: CoverageFeatureKey, status: CoverageStatus): boolean {
  if (featureKey === "price") {
    return (status.sourceCount ?? 0) >= 3;
  }
  if (featureKey === "reserves") {
    return status.kind === "live";
  }
  return status.available;
}

function countHeadlineFeatures(
  statuses: Record<CoverageFeatureKey, CoverageStatus>,
  keys?: readonly CoverageFeatureKey[],
): number {
  const targetKeys = keys ?? (Object.keys(statuses) as CoverageFeatureKey[]);
  return targetKeys.reduce((count, key) => count + (isHeadlineFeatureCovered(key, statuses[key]) ? 1 : 0), 0);
}

export function buildCoverageRow({
  coin,
  marketCapUsd,
  hasPegCoverage,
  consensusSources,
  priceConfidence,
  safetyScore,
  dexCoverageClass,
  redemptionEntry,
  hasYieldCoverage,
  flowCoverageStatus,
  hasDependencyCoverage,
  blacklistStatus = null,
  liveReserveFresh = true,
  dataAvailability,
}: BuildCoverageRowInput): CoverageRow {
  const hasData = (key: CoverageFeatureKey) => dataAvailability?.[key] !== false;
  const statuses = {
    price: resolvePriceCoverage(coin, hasPegCoverage, consensusSources, priceConfidence, hasData("price")),
    safety: resolveSafetyCoverage(safetyScore, hasData("safety")),
    dex: resolveDexCoverage(dexCoverageClass, hasData("dex")),
    reserves: resolveReserveCoverage(coin, liveReserveFresh, hasData("reserves")),
    redemption: resolveRedemptionCoverage(redemptionEntry, hasData("redemption")),
    yield: resolveYieldCoverage(hasYieldCoverage, hasData("yield")),
    flows: resolveFlowCoverage(flowCoverageStatus, hasData("flows")),
    blacklist: resolveBlacklistCoverage(coin, blacklistStatus),
    dependency: resolveDependencyCoverage(hasDependencyCoverage, hasData("dependency")),
  } satisfies Record<CoverageFeatureKey, CoverageStatus>;

  return {
    id: coin.id,
    symbol: coin.symbol,
    name: coin.name,
    marketCapUsd,
    pegLabel: PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency,
    backingLabel: BACKING_LABELS_SHORT[coin.flags.backing] ?? coin.flags.backing,
    governanceLabel: GOVERNANCE_LABELS_SHORT[coin.flags.governance] ?? coin.flags.governance,
    blacklistStatus,
    coverageCount: countAvailableFeatures(statuses),
    headlineCoverageCount: countHeadlineFeatures(statuses),
    advancedCoverageCount: countAvailableFeatures(statuses, [
      "safety",
      "dex",
      "reserves",
      "redemption",
      "yield",
      "flows",
      "blacklist",
      "dependency",
    ]),
    statuses,
  };
}

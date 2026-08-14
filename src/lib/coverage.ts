import { BACKING_LABELS_SHORT, GOVERNANCE_LABELS_SHORT, PEG_LABELS_SHORT } from "@shared/lib/classification";
import type { BlacklistStatus } from "@shared/lib/report-cards";
import { COVERAGE_FEATURES } from "@/lib/coverage-features";
import { coverageFeature as blacklistFeature } from "@/lib/coverage/blacklist";
import { coverageFeature as dependencyFeature } from "@/lib/coverage/dependency";
import { coverageFeature as dexFeature } from "@/lib/coverage/dex";
import { coverageFeature as flowsFeature } from "@/lib/coverage/flows";
import { coverageFeature as geniusFeature } from "@/lib/coverage/genius";
import { coverageFeature as mintAuthorityFeature } from "@/lib/coverage/mint-authority";
import { coverageFeature as micaFeature } from "@/lib/coverage/mica";
import { coverageFeature as priceFeature } from "@/lib/coverage/price";
import { coverageFeature as redemptionFeature } from "@/lib/coverage/redemption";
import { coverageFeature as reservesFeature } from "@/lib/coverage/reserves";
import { coverageFeature as safetyFeature } from "@/lib/coverage/safety";
import { coverageFeature as yieldFeature } from "@/lib/coverage/yield";
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
import type { GeniusClientProfile, MintAuthorityCoverageSummary } from "@shared/types/stablecoin-client-meta";
import type { DependencyCoverageFact } from "@/lib/dependency-coverage-facts";
import type { PublishedMintComponent } from "@/lib/mint-authority-display";

export type {
  CoverageBreakdownItem,
  CoverageFeatureDefinition,
  CoverageFeatureKey,
  CoverageFeatureSummary,
  CoverageRow,
  CoverageStatus,
  CoverageTone,
} from "@/lib/coverage-types";

export { COVERAGE_FEATURES };

/**
 * Minimal coin shape consumed by `buildCoverageRow` and the per-feature
 * resolvers. Both the fat registry meta and the slim client-registry meta
 * satisfy this without casting; resolvers that need a field not listed here
 * must add it (and ensure the client registry actually carries it).
 */
export type CoverageCoinMeta = Pick<
  StablecoinMeta,
  "id" | "name" | "symbol" | "flags" | "reserves" | "collateralQuality" | "mica"
> & {
  genius?: GeniusClientProfile;
  liveReservesConfig?: StablecoinMeta["liveReservesConfig"];
  liveReserveAdapter?: NonNullable<StablecoinMeta["liveReservesConfig"]>["adapter"];
  mintAuthoritySummary?: MintAuthorityCoverageSummary | null;
};

interface BuildCoverageRowInput {
  coin: CoverageCoinMeta;
  marketCapUsd: number;
  hasPegCoverage: boolean;
  consensusSources?: string[];
  priceConfidence?: string;
  safetyScore: number | null | undefined;
  dexCoverageClass: LiquidityCoverageClass | null | undefined;
  redemptionEntry?: RedemptionBackstopEntry | null | undefined;
  hasYieldCoverage: boolean;
  flowCoverageStatus: MintBurnCoverageStatus | null | undefined;
  dependencyCoverage?: DependencyCoverageFact | null;
  hasDependencyCoverage?: boolean;
  blacklistStatus?: BlacklistStatus | null;
  /** Published V9 mint component; absent publications render a not-rated mint band. */
  publishedMint?: PublishedMintComponent | null;
  liveReserveFresh?: boolean | null;
  dataAvailability?: Partial<Record<CoverageFeatureKey, boolean>>;
}

export const COVERAGE_BADGE_TONE_CLASS: Record<CoverageTone, string> = {
  emerald: "border-emerald-500/22 bg-emerald-500/8 text-emerald-800 dark:text-emerald-300",
  sky: "border-sky-500/24 bg-sky-500/8 text-sky-800 dark:text-sky-300",
  amber: "border-amber-500/30 bg-amber-500/12 text-amber-800 dark:text-amber-300",
  violet: "border-violet-500/28 bg-violet-500/10 text-violet-800 dark:text-violet-300",
  rose: "border-rose-500/35 bg-rose-500/12 text-rose-800 dark:text-rose-300",
  slate:
    "border-border/70 bg-muted/70 text-muted-foreground bg-[repeating-linear-gradient(135deg,transparent_0_5px,oklch(1_0_0_/0.04)_5px_10px)]",
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

function countAvailableFeatures(
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
  dependencyCoverage,
  hasDependencyCoverage,
  blacklistStatus = null,
  publishedMint = null,
  liveReserveFresh = null,
  dataAvailability,
}: BuildCoverageRowInput): CoverageRow {
  const hasData = (key: CoverageFeatureKey) => dataAvailability?.[key] !== false;
  const statuses = {
    price: priceFeature.resolve(coin, hasPegCoverage, consensusSources, priceConfidence, hasData("price")),
    safety: safetyFeature.resolve(safetyScore, hasData("safety")),
    dex: dexFeature.resolve(dexCoverageClass, hasData("dex")),
    reserves: reservesFeature.resolve(coin, liveReserveFresh, hasData("reserves")),
    redemption: redemptionFeature.resolve(redemptionEntry, hasData("redemption")),
    yield: yieldFeature.resolve(hasYieldCoverage, hasData("yield")),
    flows: flowsFeature.resolve(flowCoverageStatus, hasData("flows")),
    blacklist: blacklistFeature.resolve(coin, blacklistStatus),
    mica: micaFeature.resolve(coin.mica),
    genius: geniusFeature.resolve(coin.genius),
    dependency: dependencyFeature.resolve(dependencyCoverage ?? hasDependencyCoverage, hasData("dependency")),
    mintAuthority: mintAuthorityFeature.resolve(coin.mintAuthoritySummary, publishedMint, hasData("mintAuthority")),
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
      "mica",
      "genius",
      "dependency",
      "mintAuthority",
    ]),
    statuses,
  };
}

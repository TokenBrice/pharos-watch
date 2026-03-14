import {
  BACKING_LABELS_SHORT,
  GOVERNANCE_LABELS_SHORT,
  PEG_LABELS_SHORT,
} from "@shared/lib/classification";
import { getReserves } from "@shared/lib/reserve-templates";
import type {
  LiquidityCoverageClass,
  MintBurnCoverageStatus,
  StablecoinMeta,
} from "@shared/types";
import { BLACKLIST_STABLECOINS } from "@shared/types";

export type CoverageFeatureKey =
  | "price"
  | "safety"
  | "dex"
  | "reserves"
  | "yield"
  | "flows"
  | "blacklist"
  | "dependency";

export type CoverageTone =
  | "emerald"
  | "sky"
  | "amber"
  | "violet"
  | "rose"
  | "slate";

export interface CoverageStatus {
  kind: string;
  label: string;
  spokenLabel: string;
  tone: CoverageTone;
  available: boolean;
  sortRank: number;
  detail: string;
  sourceCount?: number;
  sourceNames?: string[];
  priceConfidence?: string;
}

export interface CoverageFeatureDefinition {
  key: CoverageFeatureKey;
  label: string;
  shortLabel: string;
  description: string;
  headlineKinds?: readonly string[];
  headlineCountLabel?: string;
  headlineCoverageLabel?: (coveragePct: number) => string;
  headlineShareLabel?: string;
  href?: string;
  external?: boolean;
}

export interface CoverageFeatureSummary {
  feature: CoverageFeatureDefinition;
  availableCount: number;
  coveragePct: number;
  coveredMcapUsd: number;
  mcapSharePct: number | null;
  countLabel: string;
  coverageLabel: string;
  shareLabel: string;
  breakdown: string;
}

export interface CoverageRow {
  id: string;
  symbol: string;
  name: string;
  marketCapUsd: number;
  pegLabel: string;
  backingLabel: string;
  governanceLabel: string;
  coverageCount: number;
  advancedCoverageCount: number;
  statuses: Record<CoverageFeatureKey, CoverageStatus>;
}

interface BuildCoverageRowInput {
  coin: StablecoinMeta;
  marketCapUsd: number;
  hasPegCoverage: boolean;
  consensusSources?: string[];
  priceConfidence?: string;
  safetyScore: number | null | undefined;
  dexCoverageClass: LiquidityCoverageClass | null | undefined;
  hasYieldCoverage: boolean;
  flowCoverageStatus: MintBurnCoverageStatus | null | undefined;
  hasDependencyCoverage: boolean;
}

const BLACKLIST_SYMBOLS = new Set<string>(BLACKLIST_STABLECOINS);

export const COVERAGE_FEATURES: readonly CoverageFeatureDefinition[] = [
  {
    key: "price",
    label: "Price & Depeg",
    shortLabel: "Price",
    description: "Live price monitoring, peg summary coverage, and depeg event detection.",
    href: "/depeg/",
  },
  {
    key: "safety",
    label: "Safety Score",
    shortLabel: "Safety",
    description: "Overall report-card grade on the Safety Scores surface.",
    href: "/safety-scores/",
  },
  {
    key: "dex",
    label: "DEX Price",
    shortLabel: "DEX",
    description: "DEX liquidity observation and price verification confidence.",
    href: "/liquidity/",
  },
  {
    key: "reserves",
    label: "Reserves",
    shortLabel: "Reserves",
    description: "Reserve composition availability on the stablecoin detail page.",
    headlineKinds: ["live"],
    headlineCountLabel: "Live tracking",
    headlineCoverageLabel: (coveragePct) =>
      `${coveragePct.toFixed(0)}% with live reserve tracking`,
    headlineShareLabel: "Live reserve market-cap reach",
  },
  {
    key: "yield",
    label: "Yield",
    shortLabel: "Yield",
    description: "Current presence in the Yield Intelligence rankings.",
    href: "/yield/",
  },
  {
    key: "flows",
    label: "Flows",
    shortLabel: "Flows",
    description: "Ethereum mint/burn flow tracking and coverage state.",
    href: "/flows/",
  },
  {
    key: "blacklist",
    label: "Blacklist",
    shortLabel: "Blacklist",
    description: "Freeze / blacklist event tracking for issuers with supported event coverage.",
    href: "/blacklist/",
  },
  {
    key: "dependency",
    label: "Dependency Map",
    shortLabel: "Dependency",
    description: "Reserve or mechanism dependency edges in the report-card graph.",
    href: "/dependency-map/",
  },
] as const;

export const COVERAGE_BADGE_TONE_CLASS: Record<CoverageTone, string> = {
  emerald:
    "border-emerald-500/22 bg-emerald-500/8 text-emerald-800 dark:text-emerald-300",
  sky: "border-sky-500/24 bg-sky-500/8 text-sky-800 dark:text-sky-300",
  amber:
    "border-amber-500/30 bg-amber-500/12 text-amber-800 dark:text-amber-300",
  violet:
    "border-violet-500/28 bg-violet-500/10 text-violet-800 dark:text-violet-300",
  rose: "border-rose-500/35 bg-rose-500/12 text-rose-800 dark:text-rose-300",
  slate: "border-border/70 bg-muted/70 text-muted-foreground",
};

function createStatus(
  kind: string,
  label: string,
  tone: CoverageTone,
  available: boolean,
  sortRank: number,
  detail: string,
  spokenLabel = label,
): CoverageStatus {
  return {
    kind,
    label,
    spokenLabel,
    tone,
    available,
    sortRank,
    detail,
  };
}

export function resolvePriceCoverage(
  coin: StablecoinMeta,
  hasPegCoverage: boolean,
  consensusSources?: string[],
  priceConfidence?: string,
): CoverageStatus {
  if (coin.flags.navToken) {
    return createStatus(
      "price-only",
      "Price only",
      "sky",
      true,
      2,
      "NAV-priced token. Price tracking is available, but peg/depeg logic is not applicable.",
    );
  }

  if (hasPegCoverage) {
    const status = createStatus(
      "tracked",
      "Tracked",
      "emerald",
      true,
      3,
      "Live peg monitoring, peg score coverage, and depeg-event history are available.",
    );
    if (consensusSources !== undefined) {
      status.sourceCount = consensusSources.length;
      status.sourceNames = consensusSources;
    }
    if (priceConfidence !== undefined) {
      status.priceConfidence = priceConfidence;
    }
    return status;
  }

  return createStatus(
    "missing",
    "Missing",
    "rose",
    false,
    0,
    "No peg-summary row is currently available for this asset.",
  );
}

export function resolveSafetyCoverage(
  safetyScore: number | null | undefined,
): CoverageStatus {
  if (safetyScore != null) {
    return createStatus(
      "rated",
      "Rated",
      "emerald",
      true,
      2,
      "This asset currently receives an overall Safety Score.",
    );
  }

  return createStatus(
    "nr",
    "NR",
    "slate",
    false,
    0,
    "No overall Safety Score is currently assigned.",
    "Not rated",
  );
}

export function resolveDexCoverage(
  coverageClass: LiquidityCoverageClass | null | undefined,
): CoverageStatus {
  switch (coverageClass) {
    case "primary":
      return createStatus(
        "primary",
        "Primary",
        "emerald",
        true,
        4,
        "Observed with primary DEX-liquidity source coverage.",
      );
    case "mixed":
      return createStatus(
        "mixed",
        "Mixed",
        "sky",
        true,
        3,
        "Observed across a mix of primary and fallback DEX-liquidity sources.",
      );
    case "fallback":
      return createStatus(
        "fallback",
        "Fallback",
        "amber",
        true,
        2,
        "Observed via fallback DEX-liquidity discovery only.",
      );
    case "legacy":
      return createStatus(
        "legacy",
        "Legacy",
        "violet",
        true,
        1,
        "Legacy liquidity history exists, but the row predates the current coverage model.",
      );
    case "unobserved":
      return createStatus(
        "unobserved",
        "NR",
        "slate",
        false,
        0,
        "No observed DEX-liquidity row is currently available.",
        "Not rated",
      );
    default:
      return createStatus(
        "unknown",
        "Unknown",
        "slate",
        false,
        0,
        "DEX-liquidity coverage data is unavailable right now.",
      );
  }
}

export function resolveReserveCoverage(coin: StablecoinMeta): CoverageStatus {
  if (coin.liveReservesConfig) {
    return createStatus(
      "live",
      "Live",
      "emerald",
      true,
      3,
      "Detail-page reserve composition is backed by a live reserve-sync adapter.",
    );
  }

  const reserves = getReserves(coin);
  if (!reserves) {
    return createStatus(
      "unavailable",
      "None",
      "slate",
      false,
      0,
      "No reserve-composition view is currently available.",
      "No reserves view",
    );
  }

  if (reserves.estimated) {
    return createStatus(
      "estimated",
      "Estimated",
      "amber",
      true,
      1,
      "Reserve composition falls back to a classification-based estimate.",
    );
  }

  return createStatus(
    "curated",
    "Curated",
    "sky",
    true,
    2,
    "Reserve composition is manually curated in stablecoin metadata.",
  );
}

export function resolveYieldCoverage(
  hasYieldCoverage: boolean,
): CoverageStatus {
  if (hasYieldCoverage) {
    return createStatus(
      "ranked",
      "Ranked",
      "emerald",
      true,
      1,
      "This asset currently appears in the Yield Intelligence rankings.",
    );
  }

  return createStatus(
    "none",
    "—",
    "slate",
    false,
    0,
    "This asset is not currently present in the Yield Intelligence rankings.",
    "Not ranked",
  );
}

export function resolveFlowCoverage(
  flowCoverageStatus: MintBurnCoverageStatus | null | undefined,
): CoverageStatus {
  switch (flowCoverageStatus) {
    case "full":
      return createStatus(
        "full",
        "Full",
        "emerald",
        true,
        4,
        "Ethereum mint/burn tracking has full 30-day baseline coverage.",
      );
    case "partial-history":
      return createStatus(
        "partial-history",
        "Partial",
        "sky",
        true,
        3,
        "Ethereum mint/burn tracking exists, but the full history window is not yet complete.",
      );
    case "lagging":
      return createStatus(
        "lagging",
        "Lagging",
        "amber",
        true,
        2,
        "Ethereum mint/burn tracking exists, but sync progress is currently lagging.",
      );
    case "bootstrapping":
      return createStatus(
        "bootstrapping",
        "Bootstr.",
        "violet",
        true,
        1,
        "Ethereum mint/burn tracking is configured, but coverage is still bootstrapping.",
        "Bootstrapping",
      );
    case "disabled":
      return createStatus(
        "disabled",
        "Disabled",
        "rose",
        false,
        0,
        "Mint/burn tracking is configured in principle but currently disabled.",
      );
    default:
      return createStatus(
        "none",
        "—",
        "slate",
        false,
        0,
        "No Ethereum mint/burn flow tracking is currently configured.",
        "Not tracked",
      );
  }
}

export function resolveBlacklistCoverage(
  coin: StablecoinMeta,
): CoverageStatus {
  if (BLACKLIST_SYMBOLS.has(coin.symbol)) {
    return createStatus(
      "tracked",
      "Tracked",
      "amber",
      true,
      1,
      "Freeze / blacklist events are tracked for this issuer contract family.",
    );
  }

  return createStatus(
    "none",
    "—",
    "slate",
    false,
    0,
    "No dedicated blacklist / freeze tracker coverage is configured for this asset.",
    "Not tracked",
  );
}

export function resolveDependencyCoverage(
  hasDependencyCoverage: boolean,
): CoverageStatus {
  if (hasDependencyCoverage) {
    return createStatus(
      "node",
      "Node",
      "amber",
      true,
      1,
      "This asset participates in the report-card dependency graph.",
    );
  }

  return createStatus(
    "none",
    "—",
    "slate",
    false,
    0,
    "This asset currently has no dependency-graph edge coverage.",
    "Not included",
  );
}

function buildCoverageBreakdown(
  featureKey: CoverageFeatureKey,
  breakdownMap: Map<string, number>,
  availableCount: number,
  totalCount: number,
  rows?: CoverageRow[],
) {
  if (featureKey === "price") {
    const base = `tracked ${breakdownMap.get("tracked") ?? 0} · price-only ${breakdownMap.get("price-only") ?? 0}`;
    if (!rows) return base;

    // Source-depth distribution
    let deep = 0; // 5+ sources
    let mid = 0; // 3-4 sources
    let shallow = 0; // 1-2 sources
    for (const row of rows) {
      const count = row.statuses.price.sourceCount;
      if (count == null) continue;
      if (count >= 5) deep++;
      else if (count >= 3) mid++;
      else shallow++;
    }
    if (deep + mid + shallow > 0) {
      return `${base} · 5+ sources: ${deep} · 3-4: ${mid} · 1-2: ${shallow}`;
    }
    return base;
  }
  if (featureKey === "dex") {
    return `primary ${breakdownMap.get("primary") ?? 0} · mixed ${breakdownMap.get("mixed") ?? 0} · fallback ${breakdownMap.get("fallback") ?? 0}`;
  }
  if (featureKey === "reserves") {
    return `live ${breakdownMap.get("live") ?? 0} · curated ${breakdownMap.get("curated") ?? 0} · estimated ${breakdownMap.get("estimated") ?? 0}`;
  }
  if (featureKey === "flows") {
    return `full ${breakdownMap.get("full") ?? 0} · partial ${breakdownMap.get("partial-history") ?? 0} · bootstrapping ${breakdownMap.get("bootstrapping") ?? 0}`;
  }
  if (featureKey === "safety") {
    return `rated ${breakdownMap.get("rated") ?? 0} · NR ${breakdownMap.get("nr") ?? 0}`;
  }

  return `${availableCount} covered · ${totalCount - availableCount} uncovered`;
}

export function buildCoverageFeatureSummary(
  feature: CoverageFeatureDefinition,
  rows: CoverageRow[],
  totalMcapUsd: number,
): CoverageFeatureSummary {
  const availableRows = rows.filter((row) => row.statuses[feature.key].available);
  const primaryRows = feature.headlineKinds?.length
    ? rows.filter((row) => feature.headlineKinds?.includes(row.statuses[feature.key].kind))
    : availableRows;
  const coveredMcapUsd = primaryRows.reduce((sum, row) => sum + row.marketCapUsd, 0);
  const breakdownMap = new Map<string, number>();
  const coveragePct = rows.length > 0 ? (primaryRows.length / rows.length) * 100 : 0;

  for (const row of rows) {
    const kind = row.statuses[feature.key].kind;
    breakdownMap.set(kind, (breakdownMap.get(kind) ?? 0) + 1);
  }

  return {
    feature,
    availableCount: primaryRows.length,
    coveragePct,
    coveredMcapUsd,
    mcapSharePct: totalMcapUsd > 0 ? (coveredMcapUsd / totalMcapUsd) * 100 : null,
    countLabel: feature.headlineCountLabel ?? "Coin count",
    coverageLabel:
      feature.headlineCoverageLabel?.(coveragePct) ??
      `${coveragePct.toFixed(0)}% of tracked coins`,
    shareLabel: feature.headlineShareLabel ?? "Tracked market-cap reach",
    breakdown: buildCoverageBreakdown(
      feature.key,
      breakdownMap,
      availableRows.length,
      rows.length,
      rows,
    ),
  };
}

export function countAvailableFeatures(
  statuses: Record<CoverageFeatureKey, CoverageStatus>,
  keys?: readonly CoverageFeatureKey[],
): number {
  const targetKeys = keys ?? (Object.keys(statuses) as CoverageFeatureKey[]);
  return targetKeys.reduce(
    (count, key) => count + (statuses[key].available ? 1 : 0),
    0,
  );
}

export function buildCoverageRow({
  coin,
  marketCapUsd,
  hasPegCoverage,
  consensusSources,
  priceConfidence,
  safetyScore,
  dexCoverageClass,
  hasYieldCoverage,
  flowCoverageStatus,
  hasDependencyCoverage,
}: BuildCoverageRowInput): CoverageRow {
  const statuses = {
    price: resolvePriceCoverage(coin, hasPegCoverage, consensusSources, priceConfidence),
    safety: resolveSafetyCoverage(safetyScore),
    dex: resolveDexCoverage(dexCoverageClass),
    reserves: resolveReserveCoverage(coin),
    yield: resolveYieldCoverage(hasYieldCoverage),
    flows: resolveFlowCoverage(flowCoverageStatus),
    blacklist: resolveBlacklistCoverage(coin),
    dependency: resolveDependencyCoverage(hasDependencyCoverage),
  } satisfies Record<CoverageFeatureKey, CoverageStatus>;

  return {
    id: coin.id,
    symbol: coin.symbol,
    name: coin.name,
    marketCapUsd,
    pegLabel: PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency,
    backingLabel: BACKING_LABELS_SHORT[coin.flags.backing] ?? coin.flags.backing,
    governanceLabel:
      GOVERNANCE_LABELS_SHORT[coin.flags.governance] ?? coin.flags.governance,
    coverageCount: countAvailableFeatures(statuses),
    advancedCoverageCount: countAvailableFeatures(statuses, [
      "safety",
      "dex",
      "reserves",
      "yield",
      "flows",
      "blacklist",
      "dependency",
    ]),
    statuses,
  };
}

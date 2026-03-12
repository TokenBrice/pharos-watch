import {
  BACKING_LABELS_SHORT,
  GOVERNANCE_LABELS_SHORT,
  PEG_LABELS_SHORT,
} from "@shared/lib/classification";
import { getReserves } from "@shared/lib/reserve-templates";
import type {
  BluechipGrade,
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
  | "bluechip"
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
  tone: CoverageTone;
  available: boolean;
  sortRank: number;
  detail: string;
}

export interface CoverageFeatureDefinition {
  key: CoverageFeatureKey;
  label: string;
  description: string;
  href?: string;
  external?: boolean;
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
  safetyScore: number | null | undefined;
  dexCoverageClass: LiquidityCoverageClass | null | undefined;
  hasYieldCoverage: boolean;
  flowCoverageStatus: MintBurnCoverageStatus | null | undefined;
  bluechipGrade: BluechipGrade | null | undefined;
  hasDependencyCoverage: boolean;
}

const BLACKLIST_SYMBOLS = new Set<string>(BLACKLIST_STABLECOINS);

export const COVERAGE_FEATURES: readonly CoverageFeatureDefinition[] = [
  {
    key: "price",
    label: "Price & Depeg",
    description: "Live price monitoring, peg summary coverage, and depeg event detection.",
    href: "/depeg/",
  },
  {
    key: "safety",
    label: "Safety Score",
    description: "Overall report-card grade on the Safety Scores surface.",
    href: "/safety-scores/",
  },
  {
    key: "dex",
    label: "DEX Price",
    description: "DEX liquidity observation and price verification confidence.",
    href: "/liquidity/",
  },
  {
    key: "reserves",
    label: "Reserves",
    description: "Reserve composition availability on the stablecoin detail page.",
  },
  {
    key: "yield",
    label: "Yield",
    description: "Current presence in the Yield Intelligence rankings.",
    href: "/yield/",
  },
  {
    key: "flows",
    label: "Flows",
    description: "Ethereum mint/burn flow tracking and coverage state.",
    href: "/flows/",
  },
  {
    key: "blacklist",
    label: "Blacklist",
    description: "Freeze / blacklist event tracking for issuers with supported event coverage.",
    href: "/blacklist/",
  },
  {
    key: "bluechip",
    label: "Bluechip",
    description: "External Bluechip rating coverage where Bluechip publishes a grade.",
    href: "https://bluechip.org/en/coins",
    external: true,
  },
  {
    key: "dependency",
    label: "Dependency Map",
    description: "Reserve or mechanism dependency edges in the report-card graph.",
    href: "/dependency-map/",
  },
] as const;

function createStatus(
  kind: string,
  label: string,
  tone: CoverageTone,
  available: boolean,
  sortRank: number,
  detail: string,
): CoverageStatus {
  return {
    kind,
    label,
    tone,
    available,
    sortRank,
    detail,
  };
}

export function resolvePriceCoverage(
  coin: StablecoinMeta,
  hasPegCoverage: boolean,
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
    return createStatus(
      "tracked",
      "Tracked",
      "emerald",
      true,
      3,
      "Live peg monitoring, peg score coverage, and depeg-event history are available.",
    );
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
  );
}

export function resolveBluechipCoverage(
  bluechipGrade: BluechipGrade | null | undefined,
): CoverageStatus {
  if (bluechipGrade) {
    return createStatus(
      bluechipGrade,
      bluechipGrade,
      "sky",
      true,
      1,
      "Bluechip publishes an external safety rating for this asset.",
    );
  }

  return createStatus(
    "none",
    "—",
    "slate",
    false,
    0,
    "No Bluechip rating is currently available for this asset.",
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
  );
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
  safetyScore,
  dexCoverageClass,
  hasYieldCoverage,
  flowCoverageStatus,
  bluechipGrade,
  hasDependencyCoverage,
}: BuildCoverageRowInput): CoverageRow {
  const statuses = {
    price: resolvePriceCoverage(coin, hasPegCoverage),
    safety: resolveSafetyCoverage(safetyScore),
    dex: resolveDexCoverage(dexCoverageClass),
    reserves: resolveReserveCoverage(coin),
    yield: resolveYieldCoverage(hasYieldCoverage),
    flows: resolveFlowCoverage(flowCoverageStatus),
    blacklist: resolveBlacklistCoverage(coin),
    bluechip: resolveBluechipCoverage(bluechipGrade),
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
      "bluechip",
      "dependency",
    ]),
    statuses,
  };
}

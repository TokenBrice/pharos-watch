import { BACKING_LABELS_SHORT, GOVERNANCE_LABELS_SHORT, PEG_LABELS_SHORT } from "@shared/lib/classification";
import { getReserveDisplayBadgeKindForAdapter } from "@shared/lib/live-reserve-display";
import type { BlacklistStatus } from "@shared/lib/report-cards";
import { getReserves } from "@shared/lib/reserve-templates";
import type {
  LiquidityCoverageClass,
  MintBurnCoverageStatus,
  RedemptionBackstopEntry,
  StablecoinMeta,
} from "@shared/types";
import { BLACKLIST_STABLECOINS } from "@shared/types";

export type CoverageFeatureKey =
  | "price"
  | "safety"
  | "dex"
  | "reserves"
  | "redemption"
  | "yield"
  | "flows"
  | "blacklist"
  | "dependency";

export type CoverageTone = "emerald" | "sky" | "amber" | "violet" | "rose" | "slate";

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
  scopeFilter?: (row: CoverageRow) => boolean;
  headlineKinds?: readonly string[];
  headlineFilter?: (row: CoverageRow) => boolean;
  headlineCountLabel?: string;
  headlineCoverageLabel?: (coveragePct: number) => string;
  headlineShareLabel?: string;
  href?: string;
  external?: boolean;
}

export interface CoverageFeatureSummary {
  feature: CoverageFeatureDefinition;
  availableCount: number;
  totalCount: number;
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
  blacklistStatus: BlacklistStatus | null;
  coverageCount: number;
  headlineCoverageCount: number;
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
  redemptionEntry?: RedemptionBackstopEntry | null | undefined;
  hasYieldCoverage: boolean;
  flowCoverageStatus: MintBurnCoverageStatus | null | undefined;
  hasDependencyCoverage: boolean;
  blacklistStatus?: BlacklistStatus | null;
  liveReserveFresh?: boolean | null;
  dataAvailability?: Partial<Record<CoverageFeatureKey, boolean>>;
}

const BLACKLIST_SYMBOLS = new Set<string>(BLACKLIST_STABLECOINS);

function hasBlacklistTrackerCoverage(coin: StablecoinMeta, blacklistStatus: BlacklistStatus | null = null): boolean {
  if (blacklistStatus !== null && blacklistStatus !== true) {
    return false;
  }
  return BLACKLIST_SYMBOLS.has(coin.symbol.toUpperCase());
}

export const COVERAGE_FEATURES: readonly CoverageFeatureDefinition[] = [
  {
    key: "price",
    label: "Price & Depeg",
    shortLabel: "Price",
    description: "Live price monitoring, peg summary coverage, and depeg event detection.",
    headlineCountLabel: "≥3 sources",
    headlineCoverageLabel: (coveragePct) => `${coveragePct.toFixed(0)}% with ≥3 price sources`,
    headlineFilter: (row) => (row.statuses.price.sourceCount ?? 0) >= 3,
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
    label: "Reserve View",
    shortLabel: "Reserves",
    description:
      "Detail-page reserve views are separated from score-grade live reserve inputs. The headline counts assets whose current report-card snapshot used fresh independent live reserve data.",
    headlineKinds: ["live"],
    headlineCountLabel: "Score-grade live",
    headlineCoverageLabel: (coveragePct) => `${coveragePct.toFixed(0)}% with score-grade live reserves`,
    headlineShareLabel: "Score-grade live reserve market-cap reach",
  },
  {
    key: "redemption",
    label: "Redemption Backstop",
    shortLabel: "Backstop",
    description:
      "Modeled issuer or protocol exit routes beyond secondary-market DEX liquidity. Heuristic supply-based routes are broken out separately below.",
    headlineCountLabel: "Strong coverage",
    headlineCoverageLabel: (coveragePct) => `${coveragePct.toFixed(0)}% with strong redemption coverage`,
    headlineShareLabel: "Strong redemption market-cap reach",
    href: "/methodology/#safety-scores-methodology",
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
    description: "Configured issuance-chain mint/burn flow tracking and coverage state.",
    href: "/flows/",
  },
  {
    key: "blacklist",
    label: "Blacklist",
    shortLabel: "Blacklist",
    description: "Freeze / blacklist event tracking for issuers with supported event coverage.",
    scopeFilter: (row) => row.blacklistStatus === true,
    headlineCountLabel: "Blacklistable coins",
    headlineCoverageLabel: (coveragePct) => `${coveragePct.toFixed(0)}% of blacklistable coins`,
    headlineShareLabel: "Blacklistable market-cap reach",
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
  emerald: "border-emerald-500/22 bg-emerald-500/8 text-emerald-800 dark:text-emerald-300",
  sky: "border-sky-500/24 bg-sky-500/8 text-sky-800 dark:text-sky-300",
  amber: "border-amber-500/30 bg-amber-500/12 text-amber-800 dark:text-amber-300",
  violet: "border-violet-500/28 bg-violet-500/10 text-violet-800 dark:text-violet-300",
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

function createDataUnavailableStatus(featureLabel: string): CoverageStatus {
  return createStatus(
    "data-unavailable",
    "Data n/a",
    "amber",
    false,
    -1,
    `${featureLabel} coverage data is unavailable right now, so this state is not counted as a coverage gap.`,
    "Data unavailable",
  );
}

interface CoverageStatusPreset {
  kind: string;
  label: string;
  tone: CoverageTone;
  available: boolean;
  sortRank: number;
  detail: string;
  spokenLabel?: string;
}

function createPresetStatus(preset: CoverageStatusPreset): CoverageStatus {
  return createStatus(
    preset.kind,
    preset.label,
    preset.tone,
    preset.available,
    preset.sortRank,
    preset.detail,
    preset.spokenLabel,
  );
}

const SAFETY_STATUS_PRESETS = {
  rated: {
    kind: "rated",
    label: "Rated",
    tone: "emerald",
    available: true,
    sortRank: 2,
    detail: "This asset currently receives an overall Safety Score.",
  },
  nr: {
    kind: "nr",
    label: "NR",
    tone: "slate",
    available: false,
    sortRank: 0,
    detail: "No overall Safety Score is currently assigned.",
    spokenLabel: "Not rated",
  },
} satisfies Record<string, CoverageStatusPreset>;

const DEX_STATUS_PRESETS = {
  primary: {
    kind: "primary",
    label: "Primary",
    tone: "emerald",
    available: true,
    sortRank: 4,
    detail: "Observed with primary DEX-liquidity source coverage.",
  },
  mixed: {
    kind: "mixed",
    label: "Mixed",
    tone: "sky",
    available: true,
    sortRank: 3,
    detail: "Observed across a mix of primary and fallback DEX-liquidity sources.",
  },
  fallback: {
    kind: "fallback",
    label: "Fallback",
    tone: "amber",
    available: true,
    sortRank: 2,
    detail: "Observed via fallback DEX-liquidity discovery only.",
  },
  legacy: {
    kind: "legacy",
    label: "Legacy",
    tone: "violet",
    available: true,
    sortRank: 1,
    detail: "Legacy liquidity history exists, but the row predates the current coverage model.",
  },
  unobserved: {
    kind: "unobserved",
    label: "NR",
    tone: "slate",
    available: false,
    sortRank: 0,
    detail: "No observed DEX-liquidity row is currently available.",
    spokenLabel: "Not rated",
  },
  unknown: {
    kind: "unknown",
    label: "Unknown",
    tone: "slate",
    available: false,
    sortRank: 0,
    detail: "DEX-liquidity coverage data is unavailable right now.",
  },
} satisfies Record<string, CoverageStatusPreset>;

const FLOW_STATUS_PRESETS = {
  full: {
    kind: "full",
    label: "Full",
    tone: "emerald",
    available: true,
    sortRank: 4,
    detail: "Configured issuance-chain mint/burn tracking has full 30-day baseline coverage.",
  },
  "partial-history": {
    kind: "partial-history",
    label: "Partial",
    tone: "sky",
    available: true,
    sortRank: 3,
    detail: "Configured issuance-chain mint/burn tracking exists, but the full history window is not yet complete.",
  },
  lagging: {
    kind: "lagging",
    label: "Lagging",
    tone: "amber",
    available: true,
    sortRank: 2,
    detail: "Configured issuance-chain mint/burn tracking exists, but sync progress is currently lagging.",
  },
  bootstrapping: {
    kind: "bootstrapping",
    label: "Bootstr.",
    tone: "violet",
    available: true,
    sortRank: 1,
    detail: "Configured issuance-chain mint/burn tracking is configured, but coverage is still bootstrapping.",
    spokenLabel: "Bootstrapping",
  },
  disabled: {
    kind: "disabled",
    label: "Disabled",
    tone: "rose",
    available: false,
    sortRank: 0,
    detail: "Mint/burn tracking is configured in principle but currently disabled.",
  },
  none: {
    kind: "none",
    label: "—",
    tone: "slate",
    available: false,
    sortRank: 0,
    detail: "No issuance-chain mint/burn flow tracking is currently configured.",
    spokenLabel: "Not tracked",
  },
} satisfies Record<string, CoverageStatusPreset>;

const REDEMPTION_ROUTE_STATUS_PRESETS = {
  "offchain-issuer": {
    kind: "offchain-issuer",
    label: "Issuer",
    tone: "amber",
    available: true,
    sortRank: 2,
    detail: "Issuer or institutional redemption path is modeled.",
  },
  "psm-swap": {
    kind: "psm-swap",
    label: "PSM",
    tone: "sky",
    available: true,
    sortRank: 3,
    detail: "Protocol swap or PSM-style redemption floor is modeled.",
  },
  "queue-redeem": {
    kind: "queue-redeem",
    label: "Queue",
    tone: "violet",
    available: true,
    sortRank: 1,
    detail: "Queued protocol redemption path is modeled.",
  },
  "collateral-redeem": {
    kind: "collateral-redeem",
    label: "Collat.",
    tone: "sky",
    available: true,
    sortRank: 3,
    detail: "Direct collateral redemption path is modeled.",
    spokenLabel: "Collateral redeem",
  },
  "stablecoin-redeem": {
    kind: "stablecoin-redeem",
    label: "Stable",
    tone: "emerald",
    available: true,
    sortRank: 3,
    detail: "Direct stablecoin redemption path is modeled.",
    spokenLabel: "Stablecoin redeem",
  },
  "basket-redeem": {
    kind: "basket-redeem",
    label: "Basket",
    tone: "sky",
    available: true,
    sortRank: 2,
    detail: "Basket redemption path is modeled.",
  },
  modeled: {
    kind: "modeled",
    label: "Modeled",
    tone: "rose",
    available: true,
    sortRank: 1,
    detail: "Redemption-backstop route is modeled.",
  },
} satisfies Record<string, CoverageStatusPreset>;

function resolveBooleanCoverageStatus(
  enabled: boolean,
  availablePreset: CoverageStatusPreset,
  missingPreset: CoverageStatusPreset,
): CoverageStatus {
  return createPresetStatus(enabled ? availablePreset : missingPreset);
}

export function resolvePriceCoverage(
  coin: StablecoinMeta,
  hasPegCoverage: boolean,
  consensusSources?: string[],
  priceConfidence?: string,
  dataAvailable = true,
): CoverageStatus {
  if (!dataAvailable) {
    return createDataUnavailableStatus("Price and depeg");
  }

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

export function resolveSafetyCoverage(safetyScore: number | null | undefined, dataAvailable = true): CoverageStatus {
  if (!dataAvailable) {
    return createDataUnavailableStatus("Safety Score");
  }

  return createPresetStatus(safetyScore != null ? SAFETY_STATUS_PRESETS.rated : SAFETY_STATUS_PRESETS.nr);
}

export function resolveDexCoverage(
  coverageClass: LiquidityCoverageClass | null | undefined,
  dataAvailable = true,
): CoverageStatus {
  if (!dataAvailable) {
    return createDataUnavailableStatus("DEX liquidity");
  }

  return createPresetStatus(DEX_STATUS_PRESETS[coverageClass ?? "unknown"] ?? DEX_STATUS_PRESETS.unknown);
}

export function resolveReserveCoverage(coin: StablecoinMeta, liveReserveFresh: boolean | null = true): CoverageStatus {
  if (coin.liveReservesConfig) {
    const badgeKind = getReserveDisplayBadgeKindForAdapter(coin.liveReservesConfig.adapter);
    if (badgeKind === "live") {
      if (liveReserveFresh === null) {
        return createStatus(
          "checking",
          "Checking",
          "amber",
          false,
          0,
          "Live reserve sync is configured, but current live reserve freshness has not loaded yet.",
          "Checking live reserve sync",
        );
      }

      if (!liveReserveFresh) {
        return createStatus(
          "live-configured",
          "Configured",
          "amber",
          false,
          1,
          "A live reserve adapter is configured, but the current report-card snapshot did not use it for collateral scoring.",
          "Configured reserve view",
        );
      }

      return createStatus(
        "live",
        "Score-grade",
        "emerald",
        true,
        4,
        "The current report-card snapshot used a fresh independent live reserve snapshot for collateral scoring.",
        "Score-grade live reserve",
      );
    }

    if (badgeKind === "curated-validated") {
      return createStatus(
        "curated-validated",
        "Curated-Validated",
        "sky",
        true,
        3,
        "Detail-page reserve composition uses a reviewed reserve baseline kept current through live validation.",
        "Curated validated",
      );
    }

    return createStatus(
      "proof",
      "Proof",
      "violet",
      true,
      2,
      "Detail-page reserve composition is backed by a proof, attestation, or liveness path rather than a full live reserve mix.",
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

export function resolveYieldCoverage(hasYieldCoverage: boolean, dataAvailable = true): CoverageStatus {
  if (!dataAvailable) {
    return createDataUnavailableStatus("Yield");
  }

  return resolveBooleanCoverageStatus(
    hasYieldCoverage,
    {
      kind: "ranked",
      label: "Ranked",
      tone: "emerald",
      available: true,
      sortRank: 1,
      detail: "This asset currently appears in the Yield Intelligence rankings.",
    },
    {
      kind: "none",
      label: "—",
      tone: "slate",
      available: false,
      sortRank: 0,
      detail: "This asset is not currently present in the Yield Intelligence rankings.",
      spokenLabel: "Not ranked",
    },
  );
}

export function resolveRedemptionCoverage(
  entry: RedemptionBackstopEntry | null | undefined,
  dataAvailable = true,
): CoverageStatus {
  if (!dataAvailable) {
    return createDataUnavailableStatus("Redemption backstop");
  }

  if (!entry) {
    return createStatus(
      "none",
      "—",
      "slate",
      false,
      0,
      "No modeled redemption-backstop route is currently configured.",
      "Not tracked",
    );
  }

  const routeStatus = entry.routeStatus ?? "unknown";
  if (
    entry.resolutionState === "impaired" ||
    routeStatus === "degraded" ||
    routeStatus === "paused" ||
    routeStatus === "cohort-limited"
  ) {
    return createStatus(
      "configured-unrated",
      "Impaired",
      "amber",
      false,
      1,
      entry.routeStatusReason ??
        "A redemption route is configured, but current market or route-availability evidence contradicts strong redemption coverage.",
      "Impaired route",
    );
  }

  if (entry.resolutionState !== "resolved") {
    return createStatus(
      "configured-unrated",
      "Config.",
      "amber",
      false,
      1,
      "A redemption route is configured, but the current snapshot could not resolve a usable score.",
      "Configured, unrated",
    );
  }

  if (entry.modelConfidence === "low") {
    return createStatus(
      "modeled-heuristic",
      "Heur.",
      "amber",
      false,
      1,
      "A redemption route is modeled, but the current snapshot is still heuristic / low-confidence and does not count as strong redemption coverage.",
      "Heuristic route",
    );
  }

  return createPresetStatus(
    REDEMPTION_ROUTE_STATUS_PRESETS[entry.routeFamily] ?? REDEMPTION_ROUTE_STATUS_PRESETS.modeled,
  );
}

export function resolveFlowCoverage(
  flowCoverageStatus: MintBurnCoverageStatus | null | undefined,
  dataAvailable = true,
): CoverageStatus {
  if (!dataAvailable) {
    return createDataUnavailableStatus("Mint/burn flow");
  }

  return createPresetStatus(FLOW_STATUS_PRESETS[flowCoverageStatus ?? "none"] ?? FLOW_STATUS_PRESETS.none);
}

export function resolveBlacklistCoverage(
  coin: StablecoinMeta,
  blacklistStatus: BlacklistStatus | null = null,
): CoverageStatus {
  return resolveBooleanCoverageStatus(
    hasBlacklistTrackerCoverage(coin, blacklistStatus),
    {
      kind: "tracked",
      label: "Tracked",
      tone: "amber",
      available: true,
      sortRank: 1,
      detail: "Freeze / blacklist events are tracked for this issuer contract family.",
    },
    {
      kind: "none",
      label: "—",
      tone: "slate",
      available: false,
      sortRank: 0,
      detail: "No dedicated blacklist / freeze tracker coverage is configured for this asset.",
      spokenLabel: "Not tracked",
    },
  );
}

export function resolveDependencyCoverage(hasDependencyCoverage: boolean, dataAvailable = true): CoverageStatus {
  if (!dataAvailable) {
    return createDataUnavailableStatus("Dependency map");
  }

  return resolveBooleanCoverageStatus(
    hasDependencyCoverage,
    {
      kind: "node",
      label: "Node",
      tone: "amber",
      available: true,
      sortRank: 1,
      detail: "This asset participates in the report-card dependency graph.",
    },
    {
      kind: "none",
      label: "—",
      tone: "slate",
      available: false,
      sortRank: 0,
      detail: "This asset currently has no dependency-graph edge coverage.",
      spokenLabel: "Not included",
    },
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
    const unavailable = breakdownMap.get("data-unavailable") ?? 0;
    const baseWithAvailability = unavailable > 0 ? `${base} · data n/a ${unavailable}` : base;
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
      return `${baseWithAvailability} · 5+ sources: ${deep} · 3-4: ${mid} · 1-2: ${shallow}`;
    }
    return baseWithAvailability;
  }
  if (featureKey === "dex") {
    return `primary ${breakdownMap.get("primary") ?? 0} · mixed ${breakdownMap.get("mixed") ?? 0} · fallback ${breakdownMap.get("fallback") ?? 0} · data n/a ${breakdownMap.get("data-unavailable") ?? 0}`;
  }
  if (featureKey === "reserves") {
    return `score-grade ${breakdownMap.get("live") ?? 0} · configured ${breakdownMap.get("live-configured") ?? 0} · checking ${breakdownMap.get("checking") ?? 0} · curated-validated ${breakdownMap.get("curated-validated") ?? 0} · proof ${breakdownMap.get("proof") ?? 0} · curated ${breakdownMap.get("curated") ?? 0} · estimated ${breakdownMap.get("estimated") ?? 0}`;
  }
  if (featureKey === "redemption") {
    return `heuristic ${breakdownMap.get("modeled-heuristic") ?? 0} · configured ${breakdownMap.get("configured-unrated") ?? 0} · issuer ${breakdownMap.get("offchain-issuer") ?? 0} · psm ${breakdownMap.get("psm-swap") ?? 0} · queue ${breakdownMap.get("queue-redeem") ?? 0} · collateral ${breakdownMap.get("collateral-redeem") ?? 0} · stable ${breakdownMap.get("stablecoin-redeem") ?? 0} · basket ${breakdownMap.get("basket-redeem") ?? 0} · data n/a ${breakdownMap.get("data-unavailable") ?? 0}`;
  }
  if (featureKey === "flows") {
    return `full ${breakdownMap.get("full") ?? 0} · partial ${breakdownMap.get("partial-history") ?? 0} · lagging ${breakdownMap.get("lagging") ?? 0} · bootstrapping ${breakdownMap.get("bootstrapping") ?? 0} · data n/a ${breakdownMap.get("data-unavailable") ?? 0}`;
  }
  if (featureKey === "safety") {
    return `rated ${breakdownMap.get("rated") ?? 0} · NR ${breakdownMap.get("nr") ?? 0} · data n/a ${breakdownMap.get("data-unavailable") ?? 0}`;
  }

  return `${availableCount} covered · ${totalCount - availableCount} uncovered`;
}

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
    breakdown: buildCoverageBreakdown(feature.key, breakdownMap, availableRows.length, scopedRows.length, scopedRows),
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
    reserves: resolveReserveCoverage(coin, liveReserveFresh),
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

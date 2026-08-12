import { formatWholeUnitDurationSeconds } from "@shared/lib/relative-time";
import type { OracleRiskConfidence, OracleRiskRole, OracleRiskTier, StablecoinLink, StablecoinMeta } from "@shared/types";

/**
 * Client-safe projection of the server-only `oracleRisk` review, in the
 * `projectBridgeRouteRiskClientSummary` pattern: bounded labels, per-branch
 * rows, and formatted figures only. Feed addresses and observation blocks
 * stay server-side; the path/provider/chain triple plus heartbeat and
 * staleness bounds are what the module renders.
 */
export interface OracleFeedClientRow {
  key: string;
  provider: string;
  path: string;
  chain: string;
  heartbeatLabel: string | null;
  stalenessLabel: string | null;
}

export interface OracleCollateralParameterClientRow {
  key: string;
  asset: string;
  maxLtvLabel: string | null;
  minCrLabel: string | null;
  shutdownCrLabel: string | null;
  note: string | null;
}

export interface OracleBranchClientRow {
  id: string;
  label: string;
  tierLabel: string;
  summary: string;
  debtSharePct: number | null;
  feeds: OracleFeedClientRow[];
  collateralParameters: OracleCollateralParameterClientRow[];
  liquidationMechanism: string | null;
  liquidationDelayLabel: string | null;
  backstop: string | null;
  fallbackBehavior: string | null;
  shutdownOrBadDebtBehavior: string | null;
}

export interface OracleRiskClientSummary {
  role: OracleRiskRole;
  /** Module heading, so the two roles never share one title. */
  title: string;
  /** One line naming what the reviewed price authority is for and who it hurts when it fails. */
  roleNote: string;
  tier: OracleRiskTier;
  tierLabel: string;
  tierToneClass: string;
  summary: string;
  confidenceLabel: string | null;
  reviewedAt: string | null;
  branchCount: number;
  feedCount: number;
  worstMaxLtvPct: number | null;
  worstMinCrPct: number | null;
  maxLiquidationDelayLabel: string | null;
  branches: OracleBranchClientRow[];
  sources: StablecoinLink[];
}

const TIER_LABELS: Record<OracleRiskTier, string> = {
  "oracleless": "Oracleless",
  "privileged-internal-pricing": "Privileged internal pricing",
  "redundant-with-failover": "Redundant + failover",
  "medianized-with-delay": "Medianized + delay",
  "standard-external": "Standard external",
  "single-source-or-laggy": "Single-source / laggy",
  "opaque-or-unknown": "Opaque / unknown",
};

// Tone strings match the bridge-client TIER_TONES palette byte-for-byte.
const TIER_TONES: Record<OracleRiskTier, string> = {
  "oracleless": "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  "privileged-internal-pricing": "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  "redundant-with-failover": "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  "medianized-with-delay": "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400",
  "standard-external": "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400",
  "single-source-or-laggy": "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  "opaque-or-unknown": "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
};

const ROLE_TITLES: Record<OracleRiskRole, string> = {
  "collateral-pricing": "Collateral pricing & liquidation",
  "coin-price-feed": "Price feed",
};

/**
 * Mirrors the curated backfill rule, so a profile that predates the `role`
 * field — or a new one that omits it — still titles itself correctly:
 * reviewed liquidation branches, or an unresolved crypto-backed CDP, price
 * borrower collateral; everything else prices the coin or its backing.
 */
function resolveOracleRiskRole(coin: StablecoinMeta): OracleRiskRole {
  const profile = coin.oracleRisk;
  if (profile?.role) return profile.role;
  if (profile?.branchApplicability?.disposition === "branches-required") return "collateral-pricing";
  if (
    profile?.branchApplicability == null &&
    coin.mechanismArchetype === "cdp" &&
    coin.flags.backing === "crypto-backed"
  ) {
    return "collateral-pricing";
  }
  return "coin-price-feed";
}

function roleNote(role: OracleRiskRole, symbol: string): string {
  return role === "collateral-pricing"
    ? `Prices the collateral behind ${symbol} and drives liquidations. A wrong or stale price leaves debt undercollateralized, so this is core solvency machinery.`
    : `Covers how ${symbol} and the assets behind it are priced, not borrower collateral in a liquidation engine. Failure here hits whoever consumes the price — including third-party integrators — rather than an internal liquidation path.`;
}

const CONFIDENCE_LABELS: Record<OracleRiskConfidence, string> = {
  verified: "Verified",
  probable: "Probable",
  limited: "Limited",
  unknown: "Unknown",
};

/** "None" for zero, then the largest whole natural unit: 1d / 4h / 5m / 45s. */
export function formatOracleDurationSec(seconds: number | null | undefined): string | null {
  if (seconds == null || seconds < 0) return null;
  if (seconds === 0) return "None";
  return formatWholeUnitDurationSeconds(seconds);
}

/** Rounds to at most 2 decimals and trims trailing zeros, e.g. 66.6667 -> "66.67%", 110 -> "110%". */
export function formatOraclePct(value: number): string {
  return `${Number(value.toFixed(2))}%`;
}

function formatPct(value: number | null | undefined): string | null {
  return value != null ? formatOraclePct(value) : null;
}

export function projectOracleRiskClientSummary(coin: StablecoinMeta): OracleRiskClientSummary | null {
  const profile = coin.oracleRisk;
  if (!profile) return null;

  const branches: OracleBranchClientRow[] = (profile.branches ?? []).map((branch) => ({
    id: branch.id,
    label: branch.label,
    tierLabel: TIER_LABELS[branch.tier] ?? branch.tier,
    summary: branch.summary,
    debtSharePct: branch.debtSharePct ?? null,
    feeds: (branch.feeds ?? []).map((feed, index) => ({
      key: `${feed.provider}:${feed.path}:${feed.chain}:${index}`,
      provider: feed.provider,
      path: feed.path,
      chain: feed.chain,
      // Zero heartbeat/staleness reads as "unset" (nothing meaningful to show),
      // but a zero liquidationDelaySec below is a real, load-bearing fact —
      // instant liquidation — so it renders as "None" rather than being hidden.
      heartbeatLabel: feed.heartbeatSec != null && feed.heartbeatSec > 0 ? formatOracleDurationSec(feed.heartbeatSec) : null,
      stalenessLabel:
        feed.stalenessBoundSec != null && feed.stalenessBoundSec > 0
          ? formatOracleDurationSec(feed.stalenessBoundSec)
          : null,
    })),
    collateralParameters: (branch.collateralParameters ?? []).map((parameter, index) => ({
      key: `${parameter.asset}:${index}`,
      asset: parameter.asset,
      maxLtvLabel: formatPct(parameter.maximumLtvPct),
      minCrLabel: formatPct(parameter.minimumCollateralRatioPct),
      shutdownCrLabel: formatPct(parameter.shutdownCollateralRatioPct),
      note: parameter.note ?? null,
    })),
    liquidationMechanism: branch.liquidationMechanism ?? null,
    liquidationDelayLabel: formatOracleDurationSec(branch.liquidationDelaySec),
    backstop: branch.backstop ?? null,
    fallbackBehavior: branch.fallbackBehavior ?? null,
    shutdownOrBadDebtBehavior: branch.shutdownOrBadDebtBehavior ?? null,
  }));

  const allParameters = (profile.branches ?? []).flatMap((branch) => branch.collateralParameters ?? []);
  const maxLtvValues = allParameters
    .map((parameter) => parameter.maximumLtvPct)
    .filter((value): value is number => value != null);
  const minCrValues = allParameters
    .map((parameter) => parameter.minimumCollateralRatioPct)
    .filter((value): value is number => value != null);
  const delayValues = (profile.branches ?? [])
    .map((branch) => branch.liquidationDelaySec)
    .filter((value): value is number => value != null);

  const sources: StablecoinLink[] = [];
  const seen = new Set<string>();
  for (const source of [
    ...(profile.sources ?? []),
    ...(profile.branches ?? []).flatMap((branch) => branch.sources ?? []),
  ]) {
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    sources.push(source);
  }

  const notApplicable = profile.branchApplicability?.disposition === "not-applicable";
  const role = resolveOracleRiskRole(coin);

  return {
    role,
    title: ROLE_TITLES[role],
    roleNote: roleNote(role, coin.symbol),
    tier: profile.tier,
    tierLabel: notApplicable ? "No liquidation oracle · not scored" : TIER_LABELS[profile.tier] ?? profile.tier,
    tierToneClass: notApplicable
      ? "border-border/60 bg-muted/30 text-muted-foreground"
      : TIER_TONES[profile.tier] ?? "border-border/60 bg-muted/30 text-muted-foreground",
    summary: profile.summary,
    confidenceLabel: profile.confidence ? CONFIDENCE_LABELS[profile.confidence] : null,
    reviewedAt: profile.reviewedAt ?? null,
    branchCount: branches.length,
    feedCount: branches.reduce((count, branch) => count + branch.feeds.length, 0),
    worstMaxLtvPct: maxLtvValues.length > 0 ? Math.max(...maxLtvValues) : null,
    worstMinCrPct: minCrValues.length > 0 ? Math.min(...minCrValues) : null,
    maxLiquidationDelayLabel: delayValues.length > 0 ? formatOracleDurationSec(Math.max(...delayValues)) : null,
    branches,
    sources,
  };
}

import { formatWholeUnitDurationSeconds } from "@shared/lib/relative-time";
import type { OracleRiskConfidence, OracleRiskRole, OracleRiskTier, StablecoinLink, StablecoinMeta } from "@shared/types";
import { CHAIN_META, normalizeChainId } from "@shared/types/chain-identity";
import { SEVERITY_TONE_CLASS, type SeverityTone } from "@/lib/severity-tone";
import { dedupeStablecoinLinksByUrl } from "@/lib/stablecoin-detail-links-client";
import { titleCaseSlug } from "@/lib/title-case-slug";

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
  /** Display name of `chain` ("Ethereum"), never the slug. */
  chainLabel: string;
  heartbeatLabel: string | null;
  stalenessLabel: string | null;
}

/** One distinct feed across the profile, with the branches that read it. */
export interface OracleFeedSummaryRow extends OracleFeedClientRow {
  /** Labels of the branches reading this feed, in curated order. */
  branchLabels: string[];
}

export interface OracleCollateralParameterClientRow {
  key: string;
  asset: string;
  maxLtvLabel: string | null;
  minCrLabel: string | null;
  shutdownCrLabel: string | null;
  /** Reviewed maximum loan-to-value in percent; the figure behind `maxLtvLabel`. */
  maxLtvPct: number | null;
  /** Reviewed minimum collateral ratio in percent (110 = 110 %); the figure behind `minCrLabel`. */
  minCrPct: number | null;
  /** Reviewed shutdown collateral ratio in percent; the figure behind `shutdownCrLabel`. */
  shutdownCrPct: number | null;
  note: string | null;
}

export interface OracleBranchClientRow {
  id: string;
  label: string;
  /** The branch's reviewed tier; an unrecognised value reads as opaque / unknown. */
  tier: OracleRiskTier;
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
  /**
   * One summary-layer sentence (<= 25 words) generated from structured fields:
   * tier, branch count and the loosest staleness bound. Null when the review
   * rules the liquidation oracle not applicable; `notApplicableRationale` then
   * carries the reason.
   */
  verdict: string | null;
  tier: OracleRiskTier;
  tierLabel: string;
  tierToneClass: string;
  /** The review rules a liquidation oracle out of scope, so nothing is scored. */
  notApplicable: boolean;
  /** The reviewer's reason for `notApplicable`; null otherwise. */
  notApplicableRationale: string | null;
  summary: string;
  confidenceLabel: string | null;
  reviewedAt: string | null;
  branchCount: number;
  /** Distinct feeds (`feeds.length`); a feed shared by several branches counts once. */
  feedCount: number;
  /** Distinct feed providers in first-seen order; empty when none are itemized. */
  providers: string[];
  /** Distinct feeds across every branch, first-seen order. */
  feeds: OracleFeedSummaryRow[];
  /** Loosest reviewed staleness bound across the feeds. */
  maxStalenessLabel: string | null;
  worstMaxLtvPct: number | null;
  worstMinCrPct: number | null;
  maxLiquidationDelayLabel: string | null;
  /**
   * The oracle's own hold on a new price before it is used (a medianized-with-
   * delay tier, e.g. Sky's OSM): "OSM" when the reviewed feed path names an
   * Oracle Security Module, "Yes" otherwise, "N of M branches" when only some
   * branches delay. Null when no reviewed tier delays the price. Distinct from
   * `maxLiquidationDelayLabel`, the wait between an unsafe position and its
   * liquidation.
   */
  priceDelayLabel: string | null;
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

/**
 * Severity step per tier. The pill reads opaque as an alert (a reviewed
 * inventory established non-disclosure); the ladder overrides that to neutral
 * because the topology itself is unknown, never safe and never green.
 */
const TIER_SEVERITY: Record<OracleRiskTier, SeverityTone> = {
  "oracleless": "ok",
  "privileged-internal-pricing": "watch",
  "redundant-with-failover": "ok",
  "medianized-with-delay": "info",
  "standard-external": "info",
  "single-source-or-laggy": "watch",
  "opaque-or-unknown": "alert",
};

const ROLE_TITLES: Record<OracleRiskRole, string> = {
  "collateral-pricing": "Collateral pricing & liquidation",
  "coin-price-feed": "Price feed",
};

/**
 * One-word ladder labels for narrow ladders (tiles): the published tier names
 * cut to their first word, so no band ever has to ellipsize a tier name.
 */
const TIER_SHORT_LABELS: Record<OracleRiskTier, string> = {
  "oracleless": "Oracleless",
  "privileged-internal-pricing": "Privileged",
  "redundant-with-failover": "Redundant",
  "medianized-with-delay": "Medianized",
  "standard-external": "Standard",
  "single-source-or-laggy": "Single-source",
  "opaque-or-unknown": "Opaque",
};

/**
 * Oracle tiers in the published `oracleTierQuality` order (V9 methodology
 * policy `control.oracleTierQuality`), weakest band first so the ladder reads
 * "right = safer". Tiers the policy scores alike share one band. Pinned to the
 * policy by test: change one and the pin fails.
 */
export const ORACLE_TIER_POLICY_BANDS: readonly { quality: number; tiers: readonly OracleRiskTier[] }[] = [
  { quality: 45, tiers: ["privileged-internal-pricing", "single-source-or-laggy", "opaque-or-unknown"] },
  { quality: 70, tiers: ["standard-external"] },
  { quality: 80, tiers: ["medianized-with-delay"] },
  { quality: 90, tiers: ["redundant-with-failover"] },
  { quality: 95, tiers: ["oracleless"] },
];

export interface OracleTierLadderBand {
  key: string;
  /** Wide-ladder label: the lit tier's full name, or every tier the band holds. */
  label: string;
  /** Narrow-ladder label: one word, or "<first> +N" for an unlit tied band. */
  shortLabel: string;
  fillClass: string;
  textClass: string;
}

export interface OracleTierLadder {
  bands: OracleTierLadderBand[];
  activeKey: string;
  /** 1-based band position, weakest first. */
  position: number;
  /** Other tiers sharing the active band, by published label. */
  tiedTierLabels: string[];
}

function isOracleRiskTier(value: unknown): value is OracleRiskTier {
  return typeof value === "string" && Object.hasOwn(TIER_LABELS, value);
}

/** A missing or unrecognised tier reads as opaque / unknown: never guessed, never a crash. */
export function oracleTierLabel(tier: string | null | undefined): string {
  return TIER_LABELS[isOracleRiskTier(tier) ? tier : "opaque-or-unknown"];
}

/**
 * The ordinal ladder for `tier` in published policy order. The lit band takes
 * the tier's severity hue (opaque stays neutral) and names the lit tier; a
 * band holding several tied tiers names them all while unlit. Each band also
 * carries a one-word `shortLabel` for ladders too narrow for full names.
 * Null for a value outside the published tiers, so no band is ever guessed.
 */
export function resolveOracleTierLadder(tier: string): OracleTierLadder | null {
  if (!isOracleRiskTier(tier)) return null;
  const activeIndex = ORACLE_TIER_POLICY_BANDS.findIndex((band) => band.tiers.includes(tier));
  if (activeIndex === -1) return null;
  const tone: SeverityTone = tier === "opaque-or-unknown" ? "neutral" : TIER_SEVERITY[tier];
  const bands = ORACLE_TIER_POLICY_BANDS.map((band, index) => {
    const active = index === activeIndex;
    const [first, ...tied] = band.tiers;
    let label: string;
    let shortLabel: string;
    if (active) {
      label = TIER_LABELS[tier];
      shortLabel = TIER_SHORT_LABELS[tier];
    } else if (tied.length === 0) {
      label = TIER_LABELS[first!];
      shortLabel = TIER_SHORT_LABELS[first!];
    } else {
      label = band.tiers.map((member) => TIER_SHORT_LABELS[member]).join(" / ");
      shortLabel = `${TIER_SHORT_LABELS[first!]} +${tied.length}`;
    }
    return {
      key: `q${band.quality}`,
      label,
      shortLabel,
      fillClass: SEVERITY_TONE_CLASS[tone].bar,
      textClass: SEVERITY_TONE_CLASS[tone].text,
    };
  });
  return {
    bands,
    activeKey: bands[activeIndex]!.key,
    position: activeIndex + 1,
    tiedTierLabels: ORACLE_TIER_POLICY_BANDS[activeIndex]!.tiers
      .filter((member) => member !== tier)
      .map((member) => TIER_LABELS[member]),
  };
}

/**
 * Mirrors the curated backfill rule, so a profile that predates the `role`
 * field — or a new one that omits it — still titles itself correctly:
 * reviewed liquidation branches, or an unresolved crypto-backed CDP, price
 * borrower collateral; everything else prices the coin or its backing.
 */
function resolveOracleRiskRole(coin: StablecoinMeta): OracleRiskRole {
  const profile = coin.oracleRisk;
  if (profile?.role) return profile.role;
  if (profile?.paths) {
    return profile.paths.some((path) => path.applicability?.disposition === "branches-required")
      ? "collateral-pricing"
      : "coin-price-feed";
  }
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

/** Noun phrases for the generated verdict, one per published tier. */
const TIER_VERDICT_SOURCES: Record<Exclude<OracleRiskTier, "oracleless">, string> = {
  "privileged-internal-pricing": "a privileged internal price",
  "redundant-with-failover": "redundant feeds with automatic failover",
  "medianized-with-delay": "a medianized feed behind a price delay",
  "standard-external": "a standard external feed",
  "single-source-or-laggy": "a single-source or laggy feed",
  "opaque-or-unknown": "an undisclosed pricing method",
};

/**
 * The summary-layer verdict, built from structured fields only (the reviewer
 * summary stays in Review notes): who consumes the price, what the reviewed
 * tier says produces it, and the loosest staleness bound when one is
 * reviewed. Facts already in the module's FactGrid (CR, LTV, delay) are not
 * restated.
 */
export function buildOracleVerdict({
  role,
  tier,
  symbol,
  branchCount,
  maxStalenessLabel,
  stalenessBoundCount,
}: {
  role: OracleRiskRole;
  tier: OracleRiskTier;
  symbol: string;
  branchCount: number;
  maxStalenessLabel: string | null;
  /** Distinct reviewed staleness bounds; above one the clause names the loosest. */
  stalenessBoundCount: number;
}): string {
  let lead: string;
  if (role === "collateral-pricing") {
    const subject = branchCount > 1 ? `${branchCount} branches price collateral` : "Collateral is priced";
    lead = tier === "oracleless"
      ? `${subject} without an external price oracle`
      : `${subject} from ${TIER_VERDICT_SOURCES[tier]}`;
  } else {
    lead = tier === "oracleless"
      ? `${symbol} mint and redeem quotes use no external price oracle`
      : `${symbol} mint and redeem quotes rely on ${TIER_VERDICT_SOURCES[tier]}`;
  }
  if (maxStalenessLabel == null) return `${lead}.`;
  return `${lead}; ${stalenessBoundCount > 1 ? "loosest staleness bound" : "staleness bound"} ${maxStalenessLabel}.`;
}

function chainLabel(chain: string): string {
  const id = normalizeChainId(chain) ?? chain;
  return CHAIN_META[id]?.name ?? titleCaseSlug(id);
}

/**
 * One row per distinct feed (provider, path, chain and timings), first-seen
 * order, carrying every branch that reads it: BOLD's three branches all read
 * the same ETH / USD push oracle, which should print once, not three times.
 */
export function dedupeOracleFeeds(branches: readonly OracleBranchClientRow[]): OracleFeedSummaryRow[] {
  const byIdentity = new Map<string, OracleFeedSummaryRow>();
  for (const branch of branches) {
    for (const feed of branch.feeds) {
      const identity = [feed.provider, feed.path, feed.chain, feed.heartbeatLabel ?? "", feed.stalenessLabel ?? ""]
        .map((part) => part.trim().toLowerCase())
        .join("\u0000");
      const existing = byIdentity.get(identity);
      if (existing) {
        if (!existing.branchLabels.includes(branch.label)) existing.branchLabels.push(branch.label);
      } else {
        byIdentity.set(identity, { ...feed, branchLabels: [branch.label] });
      }
    }
  }
  return [...byIdentity.values()];
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

/** A feed path or provider that names an Oracle Security Module (Sky/Maker-style delayed price). */
const OSM_PATTERN = /\bOSM\b/;

/**
 * The price-delay fact for `OracleRiskClientSummary.priceDelayLabel`: only a
 * medianized-with-delay tier delays the price itself. Read from the reviewed
 * tier and feed path; a duration is never guessed because none is curated.
 */
function resolvePriceDelayLabel(tier: OracleRiskTier, branches: readonly OracleBranchClientRow[]): string | null {
  const delayed = branches.filter((branch) => branch.tier === "medianized-with-delay");
  if (delayed.length === 0 && tier !== "medianized-with-delay") return null;
  if (delayed.length > 0 && delayed.length < branches.length) {
    return `${delayed.length} of ${branches.length} branches`;
  }
  const scope = delayed.length > 0 ? delayed : branches;
  const namesOsm = scope.some((branch) =>
    branch.feeds.some((feed) => OSM_PATTERN.test(feed.path) || OSM_PATTERN.test(feed.provider)),
  );
  return namesOsm ? "OSM" : "Yes";
}

export function projectOracleRiskClientSummary(coin: StablecoinMeta): OracleRiskClientSummary | null {
  const profile = coin.oracleRisk;
  if (!profile) return null;

  const branches: OracleBranchClientRow[] = (profile.branches ?? []).map((branch) => ({
    id: branch.id,
    label: branch.label,
    tier: isOracleRiskTier(branch.tier) ? branch.tier : "opaque-or-unknown",
    tierLabel: oracleTierLabel(branch.tier),
    summary: branch.summary,
    debtSharePct: branch.debtSharePct ?? null,
    feeds: (branch.feeds ?? []).map((feed, index) => ({
      key: `${feed.provider}:${feed.path}:${feed.chain}:${index}`,
      provider: feed.provider,
      path: feed.path,
      chain: feed.chain,
      chainLabel: chainLabel(feed.chain),
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
      maxLtvPct: parameter.maximumLtvPct ?? null,
      minCrPct: parameter.minimumCollateralRatioPct ?? null,
      shutdownCrPct: parameter.shutdownCollateralRatioPct ?? null,
      note: parameter.note ?? null,
    })),
    liquidationMechanism: branch.liquidationMechanism ?? null,
    liquidationDelayLabel:
      branch.liquidationState === "uncallable"
        ? "uncallable (reviewed)"
        : formatOracleDurationSec(branch.liquidationDelaySec),
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
  const stalenessBounds = new Set(
    (profile.branches ?? [])
      .flatMap((branch) => branch.feeds ?? [])
      .map((feed) => feed.stalenessBoundSec)
      .filter((value): value is number => value != null && value > 0),
  );
  const maxStalenessLabel = stalenessBounds.size > 0 ? formatOracleDurationSec(Math.max(...stalenessBounds)) : null;

  const sources = dedupeStablecoinLinksByUrl([
    ...(profile.sources ?? []),
    ...(profile.branches ?? []).flatMap((branch) => branch.sources ?? []),
    ...(profile.paths ?? []).flatMap((path) => path.applicability?.sources ?? []),
  ]);

  const notApplicable = profile.paths
    ? profile.paths.every((path) =>
        path.pricingAuthority === "none" && path.applicability?.disposition === "not-applicable" &&
        path.applicability.confidence === "verified",
      )
    : profile.branchApplicability?.disposition === "not-applicable";
  const notApplicableRationale = notApplicable
    ? profile.paths?.find((path) => path.applicability != null)?.applicability?.rationale
      ?? profile.branchApplicability?.rationale
      ?? null
    : null;
  const role = resolveOracleRiskRole(coin);
  const feeds = dedupeOracleFeeds(branches);
  const tier: OracleRiskTier = isOracleRiskTier(profile.tier) ? profile.tier : "opaque-or-unknown";

  return {
    role,
    title: ROLE_TITLES[role],
    verdict: notApplicable
      ? null
      : buildOracleVerdict({
          role,
          tier,
          symbol: coin.symbol,
          branchCount: branches.length,
          maxStalenessLabel,
          stalenessBoundCount: stalenessBounds.size,
        }),
    tier,
    tierLabel: notApplicable ? "No liquidation oracle · not scored" : oracleTierLabel(tier),
    tierToneClass: notApplicable
      ? SEVERITY_TONE_CLASS.neutral.pill
      : SEVERITY_TONE_CLASS[TIER_SEVERITY[tier]].pill,
    notApplicable,
    notApplicableRationale,
    summary: profile.summary,
    confidenceLabel: profile.confidence ? CONFIDENCE_LABELS[profile.confidence] : null,
    reviewedAt: profile.reviewedAt ?? null,
    branchCount: branches.length,
    feedCount: feeds.length,
    providers: [...new Set(feeds.map((feed) => feed.provider))],
    feeds,
    maxStalenessLabel,
    worstMaxLtvPct: maxLtvValues.length > 0 ? Math.max(...maxLtvValues) : null,
    worstMinCrPct: minCrValues.length > 0 ? Math.min(...minCrValues) : null,
    maxLiquidationDelayLabel: delayValues.length > 0 ? formatOracleDurationSec(Math.max(...delayValues)) : null,
    priceDelayLabel: notApplicable ? null : resolvePriceDelayLabel(tier, branches),
    branches,
    sources,
  };
}

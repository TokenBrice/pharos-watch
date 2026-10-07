"use client";

import type { ReactNode } from "react";
import { CircleDashed, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { EvidenceModule } from "@/components/stablecoin-detail/evidence-module";
import { resolveFactValueStyle } from "@/components/stablecoin-detail/fact-grid";
import {
  RAIL_METRIC_MAX_SUB_METRICS,
  RailMetricCard,
  type RailMetricSubMetric,
} from "@/components/stablecoin-detail/rail-card";
import { SECTION_SCROLL_MT } from "@/components/stablecoin-detail/section-title-class";
import { SourceLinkList } from "@/components/stablecoin-detail/source-link-list";
import {
  getCollateralCoverageTone,
  ShareMeter,
  ThresholdGauge,
  type CollateralCoverageTone,
  type ThresholdGaugeMarker,
} from "@/components/stablecoin-detail/threshold-gauge";
import type { MechanismBackingMetric, MechanismBackingNote, MechanismBackingView } from "@/lib/mechanism-backing";
import type { MechanismCollateralizationView } from "@/lib/mechanism-collateralization";
import type { OracleCollateralParameterClientRow } from "@/lib/stablecoin-detail-oracle-client";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";
import { COLLATERAL_COVERAGE_LABELS, COLLATERAL_COVERAGE_PILL_CLASSES } from "@shared/lib/classification";
import { timeAgo } from "@shared/lib/format";
import type { LiveReserveSnapshotMetadata } from "@shared/types";

/** The in-flow copy owns this id; the `xl+` rail copy stands in for it. */
export const BACKING_METRICS_ANCHOR_ID = "collateralization";
/** Zero-height alias for the retired Backing mechanics module's anchor. */
const BACKING_METRICS_ALIAS_ANCHOR_ID = "backing-mechanics";

/**
 * Which source filled the headline, in the S7 fill order. A reviewed
 * not-applicable ruling never leads: it is a gap, and folds with the others.
 */
export type BackingHeadlineSource =
  | "live-ratio"
  | "reviewed-ratio"
  | "metric"
  | "backstop"
  | "protocol-fact";

export interface BackingMetricsHeadline {
  source: BackingHeadlineSource;
  /** Formatted figure. */
  value: string;
  /** What the figure is measured against: "vs supply", "hedge coverage · via USDe". Never empty. */
  basis: string;
}

export type BackingMetricsVisual =
  | {
      /** A ratio read against par: a collateral ratio, or a hedge coverage ratio. */
      kind: "coverage-ratio";
      valuePct: number;
      /** Names the measure and its basis for assistive technology. */
      ariaLabel: string;
      /** Reviewed minimum collateral ratio; null unless the oracle review is dated. */
      threshold: ThresholdGaugeMarker | null;
      shutdown: ThresholdGaugeMarker | null;
    }
  | { kind: "share"; valuePct: number; label: string }
  | { kind: "backing-split"; exogenousPct: number; reflexivePct: number }
  | { kind: "duration-pair"; maturity: string; cadence: string };

export interface BackingMetricsSubMetric {
  key: string;
  /** Three words at most: rendered as a mono caps sub-label. */
  label: string;
  value: string;
  hint: string | null;
  /**
   * 0–100 share drawn as a thin meter beside the figure; null for durations
   * and for thin buffers, which a 0–100 track draws as an empty bar.
   */
  meterPct: number | null;
}

export interface BackingMetricsDetailRow {
  key: string;
  /** Names the measure and, for ratios, its denominator. */
  label: string;
  value: string;
  note: string | null;
}

export interface BackingMetricsSource {
  label: string;
  url: string;
}

export interface BackingMetricsView {
  title: string;
  headline: BackingMetricsHeadline;
  /**
   * Header status chip: the coverage band of a collateral ratio or a hedge
   * coverage headline; null for every other headline.
   */
  coverage: { tone: CollateralCoverageTone; label: string } | null;
  visual: BackingMetricsVisual | null;
  /** Parent symbol when the reviewed metrics describe the parent's system ("via USDe"). */
  via: string | null;
  /** The live ratio covers the shared Sky/Maker book, so it is not additive across DAI and USDS. */
  sharedBookNote: boolean;
  /** At most `RAIL_METRIC_MAX_SUB_METRICS`; the rest land in `details`. */
  subMetrics: BackingMetricsSubMetric[];
  /** Alternate ratios (each with its denominator), overflow metrics, parent readings, protocol facts. */
  details: BackingMetricsDetailRow[];
  /** Reviewed gaps: dimensions ruled not applicable or undisclosed. */
  gaps: MechanismBackingNote[];
  sources: BackingMetricsSource[];
  freshness: {
    /** Live stamp when a live figure is shown, e.g. "Live · checked 2h ago". */
    live: string | null;
    /** The live feed is past its freshness budget: an amber chip, never a re-tinted bar. */
    stale: boolean;
    /** Review date of the reviewed figures shown. */
    reviewedAt: string | null;
  };
}

/** Structural slice of `OracleRiskClientSummary` the gauge markers read. */
export interface BackingMetricsOracleInput {
  reviewedAt: string | null;
  notApplicable?: boolean;
  worstMinCrPct: number | null;
  branches: readonly {
    collateralParameters: readonly Pick<OracleCollateralParameterClientRow, "minCrPct" | "shutdownCrPct">[];
  }[];
}

export interface BackingMetricsInput {
  collateralization: MechanismCollateralizationView | null;
  backing: MechanismBackingView | null;
  /** Live feed ratio from the reserve snapshot metadata, when the adapter emits one. */
  liveRatio?: number | null;
  /** Live committed liquidation capital as a share of supply, when measured. */
  liveLiquidationCapacityRatio?: number | null;
  liveAtSec?: number | null;
  liveFreshnessLabel?: string;
  liveBalanceSheetScope?: "shared-sky-maker";
  liveSharedBookAssetIds?: readonly string[];
  /** Denominator of the live ratio (`resolveLiveRatioBasis`). */
  liveRatioBasis?: string | null;
  /** Live snapshot is stale; derived from the freshness label when omitted. */
  liveStale?: boolean;
  oracle?: BackingMetricsOracleInput | null;
  /**
   * Parent of a savings pass-through wrapper (sUSDe → USDe). The wrapper runs
   * no backing of its own, so its reviewed metrics describe the parent's
   * system and read "via <symbol>". With the parent's own review, each figure
   * that review reads differently folds in beside this coin's, labelled.
   */
  parent?: { symbol: string; backing: MechanismBackingView | null } | null;
  nowSec?: number;
}

const SHARED_BOOK_BASIS = "vs Sky/Maker debt";
const UNKNOWN_LIVE_BASIS = "reported reserve ratio";
const REVIEWED_RATIO_BASIS = "vs supply";
const BACKSTOP_LABEL = "Liquidation backstop";
const BACKSTOP_HINT = "Capital committed to absorb liquidations, as a share of supply.";
const COLLATERAL_RATIO_NOTE_KEY = "metric:collateralizationRatio";
const HEDGE_COVERAGE_KEY = "hedgeCoverageRatio";

/**
 * Thin buffers measured in tenths of a percent to a few percent of supply,
 * with no published cutoffs: a 0–100 share meter draws them as empty bars,
 * and any narrower domain would imply a scale nobody publishes. They print
 * as figures only.
 */
const THIN_BUFFER_METRIC_KEYS: Record<string, true> = { marginBufferPct: true, lossAbsorptionShare: true };

/** Hedge coverage reads against par like a collateral ratio, on the same bands. */
const HEDGE_COVERAGE_LABELS: Record<CollateralCoverageTone, string> = {
  over: "Fully hedged",
  par: "Fully hedged",
  under: "Partly hedged",
};

/**
 * Names the denominator of a live adapter's collateralization ratio from the
 * totals the same snapshot publishes beside it.
 */
export function resolveLiveRatioBasis(metadata: LiveReserveSnapshotMetadata | null | undefined): string {
  if (!metadata) return UNKNOWN_LIVE_BASIS;
  if (metadata.balanceSheetScope === "shared-sky-maker") return SHARED_BOOK_BASIS;
  if (typeof metadata.totalDebtUsd === "number") return "vs debt";
  if (typeof metadata.totalLiabilitiesUsd === "number") return "vs liabilities";
  if (
    metadata.liabilityScope?.basis === "issuer-native-supply"
    || typeof metadata.supplyUsd === "number"
    || typeof metadata.supplyTokens === "number"
    || typeof metadata.circulatingSupplyTokens === "number"
  ) {
    return "vs supply";
  }
  return UNKNOWN_LIVE_BASIS;
}

function finiteNonNegative(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * A ratio as a percentage, rounded to hundredths of a point so meters and
 * their aria values never carry float noise (0.575 × 100 = 57.49999…).
 */
function ratioToPct(ratio: number): number {
  return Math.round(ratio * 10_000) / 100;
}

function formatRatioPct(ratio: number): string {
  const pct = ratioToPct(ratio);
  return `${pct >= 1000 ? Math.round(pct).toLocaleString("en-US") : pct.toFixed(1)}%`;
}

/** Figure for a reviewed backing metric (`%` or a duration). */
export function formatBackingMetric(metric: MechanismBackingMetric): string {
  if (metric.unit === "days") {
    if (metric.value === 0) return "Continuous";
    if (metric.value < 1) return `${(metric.value * 24).toFixed(1)}h`;
    if (metric.value >= 365) return `${(metric.value / 365).toFixed(1)}y`;
    return `${metric.value < 10 ? metric.value.toFixed(1) : Math.round(metric.value).toLocaleString("en-US")}d`;
  }
  if (metric.value >= 1000) return `${Math.round(metric.value).toLocaleString("en-US")}%`;
  return `${metric.value < 1 ? metric.value.toFixed(2) : metric.value.toFixed(1)}%`;
}

function cadencePhrase(metric: MechanismBackingMetric): string {
  if (metric.value === 0) return "Repriced continuously";
  if (metric.value === 1) return "Repriced daily";
  if (metric.value === 7) return "Repriced weekly";
  return `Repriced every ${formatBackingMetric(metric)}`;
}

/** "Hedge coverage" -> "hedge coverage", leaving acronym-led labels ("USDC reserve") intact. */
function asCaption(label: string): string {
  return /^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

function coverageFor(ratio: number): { tone: CollateralCoverageTone; label: string } {
  const tone = getCollateralCoverageTone(ratio * 100);
  return { tone, label: COLLATERAL_COVERAGE_LABELS[tone] };
}

function distinctSorted(values: readonly (number | null)[]): number[] {
  return [...new Set(values.filter((value): value is number => value != null))].sort((a, b) => a - b);
}

function formatPctRange(values: readonly number[]): string {
  const format = (value: number) => `${Number(value.toFixed(2))}`;
  return `${format(values[0]!)}–${format(values[values.length - 1]!)}%`;
}

interface CollateralMarkers {
  threshold: ThresholdGaugeMarker | null;
  shutdown: ThresholdGaugeMarker | null;
  rangeRows: BackingMetricsDetailRow[];
}

/**
 * MCR and shutdown markers come from the reviewed oracle profile only: an
 * undated or not-applicable review draws par alone. Several branches with
 * different parameters mark the worst MCR (the lowest) and fold the ranges.
 */
function resolveCollateralMarkers(oracle: BackingMetricsOracleInput | null | undefined): CollateralMarkers {
  const none: CollateralMarkers = { threshold: null, shutdown: null, rangeRows: [] };
  if (!oracle || oracle.reviewedAt == null || oracle.notApplicable === true) return none;
  const parameters = oracle.branches.flatMap((branch) => branch.collateralParameters);
  const minCrs = distinctSorted(parameters.map((parameter) => parameter.minCrPct));
  const shutdowns = distinctSorted(parameters.map((parameter) => parameter.shutdownCrPct));
  const worstMinCr = finiteNonNegative(oracle.worstMinCrPct) ?? minCrs[0] ?? null;
  const rangeRows: BackingMetricsDetailRow[] = [];
  if (minCrs.length > 1) {
    rangeRows.push({
      key: "mcr-range",
      label: "Minimum collateral ratio across branches",
      value: formatPctRange(minCrs),
      note: `Reviewed ${oracle.reviewedAt}`,
    });
  }
  if (shutdowns.length > 1) {
    rangeRows.push({
      key: "shutdown-range",
      label: "Shutdown collateral ratio across branches",
      value: formatPctRange(shutdowns),
      note: `Reviewed ${oracle.reviewedAt}`,
    });
  }
  return {
    threshold: worstMinCr != null ? { pct: worstMinCr, label: minCrs.length > 1 ? "Lowest MCR" : "MCR" } : null,
    shutdown: shutdowns.length === 1 ? { pct: shutdowns[0]!, label: "Shutdown" } : null,
    rangeRows,
  };
}

type SubCandidate = BackingMetricsSubMetric & { origin: "live" | "collateral" | "backing" };

function metricCandidate(metric: MechanismBackingMetric): SubCandidate {
  return {
    key: metric.key,
    label: metric.label,
    value: formatBackingMetric(metric),
    hint: metric.hint,
    meterPct: metric.unit === "percent" && THIN_BUFFER_METRIC_KEYS[metric.key] !== true ? metric.value : null,
    origin: "backing",
  };
}

interface MetricHeadlinePlan {
  visual: BackingMetricsVisual | null;
  /** Metric keys the visual already states, so they do not repeat as rows. */
  consumed: ReadonlySet<string>;
}

function planMetricVisual(
  archetype: string,
  metrics: readonly MechanismBackingMetric[],
  /** Names the headline measure for assistive technology. */
  ariaLabel: string,
): MetricHeadlinePlan {
  const headline = metrics[0]!;
  const byKey = new Map(metrics.map((metric) => [metric.key, metric]));
  if (archetype === "rwa-credit-fund") {
    const maturity = byKey.get("weightedAverageMaturityDays");
    const cadence = byKey.get("valuationCadenceDays");
    if (maturity && cadence) {
      return {
        visual: { kind: "duration-pair", maturity: `WAM ${formatBackingMetric(maturity)}`, cadence: cadencePhrase(cadence) },
        consumed: new Set([maturity.key, cadence.key]),
      };
    }
  }
  if (archetype === "algorithmic") {
    const exogenous = byKey.get("exogenousBackingShare");
    const reflexive = byKey.get("reflexiveBackingShare");
    if (exogenous && reflexive) {
      return {
        visual: { kind: "backing-split", exogenousPct: exogenous.value, reflexivePct: reflexive.value },
        consumed: new Set(),
      };
    }
  }
  // Full hedge coverage is par, not a full share: it draws on the par gauge.
  if (headline.key === HEDGE_COVERAGE_KEY) {
    return {
      visual: { kind: "coverage-ratio", valuePct: headline.value, ariaLabel, threshold: null, shutdown: null },
      consumed: new Set(),
    };
  }
  if (headline.unit === "percent" && THIN_BUFFER_METRIC_KEYS[headline.key] !== true) {
    return { visual: { kind: "share", valuePct: headline.value, label: headline.label }, consumed: new Set() };
  }
  return { visual: null, consumed: new Set() };
}

/**
 * The parent symbol when a wrapper's reviewed metrics describe the parent's
 * system: the caller passes a pass-through parent, and a parent review, when
 * known, has the same archetype (a strategy vault re-scored on its own
 * archetype is not a look-through).
 */
function resolveLookThrough(
  parent: BackingMetricsInput["parent"],
  backing: MechanismBackingView | null,
): string | null {
  if (!parent || !backing || backing.metrics.length === 0) return null;
  if (parent.backing && parent.backing.archetype !== backing.archetype) return null;
  return parent.symbol;
}

function dedupeSources(sources: readonly (BackingMetricsSource | null)[]): BackingMetricsSource[] {
  const seen = new Set<string>();
  const out: BackingMetricsSource[] = [];
  for (const source of sources) {
    if (!source || seen.has(source.url)) continue;
    seen.add(source.url);
    out.push(source);
  }
  return out;
}

/**
 * One Backing KPI per coin (plan §7, decision S7). The headline fills from the
 * first source that has a reading — live ratio, reviewed ratio, the
 * archetype's leading reviewed metric, a live backstop, then the first
 * protocol fact — and always names its basis. Every other ratio folds into
 * the details with its own denominator, so a coin never shows two
 * unreconciled headline ratios. A ratio ruled not applicable is a reviewed
 * gap, never a headline. Returns `null` when nothing can lead: a gaps-only
 * review (including a lone not-applicable ruling) gets no card.
 */
export function buildBackingMetricsView(input: BackingMetricsInput): BackingMetricsView | null {
  const { collateralization, backing, oracle } = input;
  const live = finiteNonNegative(input.liveRatio);
  const liveBackstop = finiteNonNegative(input.liveLiquidationCapacityRatio);
  const reviewedBackstop = collateralization?.liquidationCapacityRatio ?? null;
  const backstop = liveBackstop ?? reviewedBackstop;
  const metrics = backing?.metrics ?? [];
  const facts = backing?.protocolFacts ?? [];

  const showsSharedBook = live != null
    && input.liveBalanceSheetScope === "shared-sky-maker"
    && input.liveSharedBookAssetIds?.includes("dai-makerdao") === true
    && input.liveSharedBookAssetIds.includes("usds-sky");

  const backstopCandidate: SubCandidate | null = backstop != null
    ? {
        key: "liquidationCapacityRatio",
        label: BACKSTOP_LABEL,
        value: formatRatioPct(backstop),
        hint: BACKSTOP_HINT,
        meterPct: ratioToPct(backstop),
        origin: liveBackstop != null ? "live" : "collateral",
      }
    : null;

  let headline: BackingMetricsHeadline;
  let coverage: BackingMetricsView["coverage"] = null;
  let visual: BackingMetricsVisual | null = null;
  let via: string | null = null;
  let pool: (SubCandidate | null)[] = [];
  let headlineFactKey: string | null = null;
  const markers = resolveCollateralMarkers(oracle);

  if (live != null) {
    const basis = input.liveRatioBasis || (showsSharedBook ? SHARED_BOOK_BASIS : UNKNOWN_LIVE_BASIS);
    headline = { source: "live-ratio", value: formatRatioPct(live), basis };
    coverage = coverageFor(live);
    visual = {
      kind: "coverage-ratio",
      valuePct: ratioToPct(live),
      ariaLabel: `Collateral ratio ${basis}`,
      threshold: markers.threshold,
      shutdown: markers.shutdown,
    };
    pool = [backstopCandidate, ...metrics.map(metricCandidate)];
  } else if (collateralization?.ratio != null) {
    headline = { source: "reviewed-ratio", value: formatRatioPct(collateralization.ratio), basis: REVIEWED_RATIO_BASIS };
    coverage = coverageFor(collateralization.ratio);
    visual = {
      kind: "coverage-ratio",
      valuePct: ratioToPct(collateralization.ratio),
      ariaLabel: `Collateral ratio ${REVIEWED_RATIO_BASIS}`,
      threshold: markers.threshold,
      shutdown: markers.shutdown,
    };
    pool = [backstopCandidate, ...metrics.map(metricCandidate)];
  } else if (metrics.length > 0) {
    const lead = metrics[0]!;
    via = resolveLookThrough(input.parent, backing);
    const basis = via ? `${asCaption(lead.label)} · via ${via}` : asCaption(lead.label);
    const plan = planMetricVisual(backing!.archetype, metrics, via ? `${lead.label}, via ${via}` : lead.label);
    headline = { source: "metric", value: formatBackingMetric(lead), basis };
    if (lead.key === HEDGE_COVERAGE_KEY) {
      const tone = getCollateralCoverageTone(lead.value);
      coverage = { tone, label: HEDGE_COVERAGE_LABELS[tone] };
    }
    visual = plan.visual;
    pool = [
      backstopCandidate,
      ...metrics.slice(1).filter((metric) => !plan.consumed.has(metric.key)).map(metricCandidate),
    ];
  } else if (backstop != null) {
    headline = { source: "backstop", value: formatRatioPct(backstop), basis: "liquidation backstop, share of supply" };
    visual = { kind: "share", valuePct: ratioToPct(backstop), label: BACKSTOP_LABEL };
  } else if (facts.length > 0) {
    const lead = facts[0]!;
    headlineFactKey = lead.key;
    headline = { source: "protocol-fact", value: lead.value, basis: asCaption(lead.label) };
  } else {
    return null;
  }

  const candidates = pool.filter((candidate): candidate is SubCandidate => candidate != null);
  const shown = candidates.slice(0, RAIL_METRIC_MAX_SUB_METRICS);
  const overflow = candidates.slice(RAIL_METRIC_MAX_SUB_METRICS);
  const ratioHeadline = headline.source === "live-ratio" || headline.source === "reviewed-ratio";

  const details: BackingMetricsDetailRow[] = [];
  if (headline.source === "live-ratio" && collateralization?.ratio != null) {
    details.push({
      key: "reviewed-ratio",
      label: `Reviewed collateral ratio ${REVIEWED_RATIO_BASIS}`,
      value: formatRatioPct(collateralization.ratio),
      note: `Reviewed ${collateralization.reviewedAt}`,
    });
  }
  if (liveBackstop != null && reviewedBackstop != null && collateralization != null) {
    details.push({
      key: "reviewed-backstop",
      label: "Reviewed liquidation backstop, share of supply",
      value: formatRatioPct(reviewedBackstop),
      note: `Reviewed ${collateralization.reviewedAt}`,
    });
  }
  // Branch parameter ranges explain the gauge's markers, so they fold only beside a ratio.
  if (ratioHeadline) details.push(...markers.rangeRows);
  for (const candidate of overflow) {
    details.push({ key: candidate.key, label: candidate.label, value: candidate.value, note: candidate.hint });
  }
  // Two reviews of one system can pin different readings (sUSDe's review read
  // Ethena's API hours before USDe's): name whose figure is whose.
  const parentBacking = via ? input.parent?.backing ?? null : null;
  const parentByKey = new Map((parentBacking?.metrics ?? []).map((metric) => [metric.key, metric]));
  if (via && parentBacking) {
    for (const metric of metrics) {
      const parentMetric = parentByKey.get(metric.key);
      if (!parentMetric || formatBackingMetric(parentMetric) === formatBackingMetric(metric)) continue;
      details.push({
        key: `parent:${metric.key}`,
        label: `${metric.label} on the ${via} review`,
        value: formatBackingMetric(parentMetric),
        note: `Reviewed ${parentBacking.reviewedAt}. This card shows this coin's own review of the same system.`,
      });
    }
  }
  for (const fact of facts) {
    if (fact.key === headlineFactKey) continue;
    details.push({ key: `fact:${fact.key}`, label: fact.label, value: fact.value, note: null });
  }

  // A ratio ruled not applicable is a reviewed gap. The backing review usually
  // carries the same ruling; otherwise the collateral review supplies it.
  const gaps = [...(backing?.notes ?? [])];
  const collateralGap = !ratioHeadline
    && collateralization?.ratio == null
    && collateralization?.notApplicableRationale != null
    && !gaps.some((note) => note.key === COLLATERAL_RATIO_NOTE_KEY);
  if (collateralGap) {
    gaps.unshift({
      key: COLLATERAL_RATIO_NOTE_KEY,
      label: "Collateralization ratio",
      state: "not-applicable",
      rationale: collateralization!.notApplicableRationale!,
      sourceUrl: null,
    });
  }

  const backingHeadline = headline.source === "metric" || headline.source === "protocol-fact";
  const backingRowShown = candidates.some((row) => row.origin === "backing");
  const collateralShown = collateralization != null && (
    headline.source === "reviewed-ratio"
    || collateralGap
    || details.some((row) => row.key === "reviewed-ratio" || row.key === "reviewed-backstop")
    || candidates.some((row) => row.origin === "collateral")
  );
  const backingShown = backing != null && (
    backingHeadline
    || backingRowShown
    || facts.some((fact) => fact.key !== headlineFactKey)
    || gaps.length > (collateralGap ? 1 : 0)
  );
  const parentShown = parentBacking != null && details.some((row) => row.key.startsWith("parent:"));

  const liveShown = live != null || liveBackstop != null;
  const labelParts = input.liveFreshnessLabel?.split(" · ") ?? null;
  const stale = liveShown && (input.liveStale ?? labelParts?.includes("Stale") ?? false);
  // "Source date unavailable · Checked …": the check time already dates the
  // reading, so the missing source date would only push the stamp to two lines.
  const checked = labelParts?.some((part) => part.startsWith("Checked ")) ?? false;
  const liveStamp = !liveShown
    ? null
    : labelParts != null
      ? labelParts.filter((part) => part !== "Stale" && !(checked && part === "Source date unavailable")).join(" · ")
      : input.liveAtSec != null
        ? `Live · checked ${timeAgo(input.liveAtSec, input.nowSec)}`
        : "Live";
  // The stamp dates the reviewed figures on the summary layer, preferring the
  // headline's own review.
  const reviewedAt = backingHeadline
    ? backing!.reviewedAt
    : collateralShown
      ? collateralization!.reviewedAt
      : backingRowShown
        ? backing!.reviewedAt
        : null;

  return {
    title: backingHeadline ? "Backing mechanics" : "Collateralization",
    headline,
    coverage,
    visual,
    via,
    sharedBookNote: showsSharedBook,
    // A look-through figure the parent's own review reads differently says so
    // on its own row (tooltip and accessible name), so sUSDe's 0.06 % beside
    // USDe's 0.10 % never reads as an error; the fold keeps the parent row.
    subMetrics: shown.map(({ origin, ...row }) => {
      const parentMetric = origin === "backing" ? parentByKey.get(row.key) : undefined;
      if (!parentBacking || !parentMetric || formatBackingMetric(parentMetric) === row.value) return row;
      const difference = `This coin's review (${backing!.reviewedAt}) reads ${row.value}; the ${via} review (${parentBacking.reviewedAt}) reads ${formatBackingMetric(parentMetric)}.`;
      return { ...row, hint: row.hint ? `${row.hint} ${difference}` : difference };
    }),
    details,
    gaps,
    sources: dedupeSources([
      collateralShown ? { label: collateralization!.sourceLabel, url: collateralization!.sourceUrl } : null,
      backingShown ? { label: backing!.sourceLabel, url: backing!.sourceUrl } : null,
      parentShown && parentBacking ? { label: parentBacking.sourceLabel, url: parentBacking.sourceUrl } : null,
    ]),
    freshness: { live: liveStamp, stale, reviewedAt },
  };
}

const GAP_STATE_LABELS: Record<MechanismBackingNote["state"], string> = {
  "not-applicable": "Not applicable",
  unavailable: "Not disclosed",
};

// Both states are the absence of a reading, not a measured hazard, so both stay
// neutral; `unavailable` carries the dashed-circle glyph so the two differ by
// shape rather than hue.
const GAP_STATE_CLASSES: Record<MechanismBackingNote["state"], string> = {
  "not-applicable": "border-border/60 bg-muted/40 text-muted-foreground",
  unavailable: SEVERITY_TONE_CLASS.neutral.pill,
};

const HEADLINE_FIGURE_CLASS = "font-mono text-[2rem] font-semibold leading-none tracking-normal tabular-nums text-foreground";
const HEADLINE_TEXT_CLASS = "text-sm font-medium text-foreground";
const SUB_METRIC_LABEL_CLASS = "font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground";
const SUB_METRIC_VALUE_CLASS = "pharos-numeric text-sm font-semibold text-foreground";

function BackingSplitBar({ exogenousPct, reflexivePct }: { exogenousPct: number; reflexivePct: number }) {
  const exogenous = Math.max(exogenousPct, 0);
  const reflexive = Math.max(reflexivePct, 0);
  const total = exogenous + reflexive;
  const scale = total > 100 ? 100 / total : 1;
  const exogenousWidth = exogenous * scale;
  const reflexiveWidth = reflexive * scale;
  const unattributed = Math.max(0, 100 - exogenousWidth - reflexiveWidth);
  const format = (pct: number) => `${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}%`;
  const label = [
    `Backing split: exogenous ${format(exogenousPct)}`,
    `reflexive ${format(reflexivePct)}`,
    unattributed >= 0.05 ? `unattributed ${format(unattributed)}` : null,
  ]
    .filter((part): part is string => part != null)
    .join(", ");

  return (
    <div>
      <div role="img" aria-label={`${label}.`} className="flex h-2 min-w-0 gap-px overflow-hidden rounded-full">
        {exogenousWidth > 0 ? (
          <span className="h-full bg-foreground/65" style={{ width: `${exogenousWidth}%` }} />
        ) : null}
        {reflexiveWidth > 0 ? (
          <span className="h-full bg-foreground/25" style={{ width: `${reflexiveWidth}%` }} />
        ) : null}
        {unattributed >= 0.05 ? (
          <span
            className="h-full rounded-r-full border border-dashed border-muted-foreground/50"
            style={{ width: `${unattributed}%` }}
          />
        ) : null}
      </div>
      <div aria-hidden="true" className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-foreground/65" />
          Exogenous
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-foreground/25" />
          Reflexive
        </span>
        {unattributed >= 0.05 ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm border border-dashed border-muted-foreground/60" />
            Unattributed
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** The visual under the headline; `null` when the headline carries none. */
function BackingVisual({ view }: { view: BackingMetricsView }) {
  const { visual } = view;
  if (!visual && !view.sharedBookNote) return null;

  return (
    <div className="space-y-2">
      {/* Capped so a twin spanning a 1,000 px row never strands the knob on an empty track. */}
      {visual?.kind === "coverage-ratio" ? (
        <ThresholdGauge
          valuePct={visual.valuePct}
          ariaLabel={visual.ariaLabel}
          threshold={visual.threshold}
          shutdown={visual.shutdown}
          showValueLabel={false}
          className="max-w-md"
        />
      ) : null}
      {visual?.kind === "share" ? (
        <ShareMeter valuePct={visual.valuePct} ariaLabel={visual.label} className="max-w-md" />
      ) : null}
      {visual?.kind === "backing-split" ? (
        <div className="max-w-md">
          <BackingSplitBar exogenousPct={visual.exogenousPct} reflexivePct={visual.reflexivePct} />
        </div>
      ) : null}
      {visual?.kind === "duration-pair" ? (
        <ul aria-label="Loan book duration" className="flex flex-wrap gap-1.5">
          {[visual.maturity, visual.cadence].map((item) => (
            <li key={item}>
              <Badge variant="outline" className="h-6 rounded-full px-2.5 text-[11px] font-medium text-foreground">
                {item}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      {view.sharedBookNote ? (
        <p className="max-w-prose text-xs leading-snug text-muted-foreground">
          Covers the shared Sky/Maker balance sheet behind DAI and USDS; not additive across the two.
        </p>
      ) : null}
    </div>
  );
}

function CoverageChip({ coverage }: { coverage: NonNullable<BackingMetricsView["coverage"]> }) {
  return (
    <Badge variant="outline" className={cn("shrink-0 text-[11px] font-medium", COLLATERAL_COVERAGE_PILL_CLASSES[coverage.tone])}>
      {coverage.label}
    </Badge>
  );
}

/** The figure, with a share meter only where a 0–100 track means something. */
function SubMetricValue({ row }: { row: BackingMetricsSubMetric }) {
  if (row.meterPct == null) return <>{row.value}</>;
  return (
    <span className="inline-flex items-center gap-2">
      <ShareMeter valuePct={row.meterPct} ariaLabel={row.label} className="w-12" />
      {row.value}
    </span>
  );
}

function BackingDetails({ view, withSources }: { view: BackingMetricsView; withSources: boolean }) {
  return (
    <>
      {view.details.length > 0 ? (
        <dl className="space-y-2">
          {view.details.map((row) => (
            <div key={row.key} className="flex items-baseline justify-between gap-3">
              <dt className="min-w-0">
                {row.label}
                {row.note ? <span className="block text-[11px] text-muted-foreground">{row.note}</span> : null}
              </dt>
              <dd className="pharos-numeric shrink-0 font-semibold text-foreground">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {view.gaps.length > 0 ? (
        <div className={cn(view.details.length > 0 ? "border-t border-border/40 pt-2" : undefined)}>
          <p className="font-medium text-foreground">Reviewed gaps</p>
          <ul className="mt-1.5 space-y-2.5">
            {view.gaps.map((gap) => (
              <li key={gap.key}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 font-medium text-foreground">{gap.label}</span>
                  <Badge
                    variant="outline"
                    className={cn("h-5 shrink-0 gap-1 rounded-full px-2 text-[11px] font-medium", GAP_STATE_CLASSES[gap.state])}
                  >
                    {gap.state === "unavailable" ? <CircleDashed className="h-3 w-3" aria-hidden="true" /> : null}
                    {GAP_STATE_LABELS[gap.state]}
                  </Badge>
                </div>
                <p className="mt-0.5 text-[11px] leading-snug">
                  {gap.rationale}
                  {gap.sourceUrl ? (
                    <a
                      href={gap.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="pharos-focus-ring ml-1.5 inline-flex items-center gap-1 rounded-sm underline underline-offset-2 hover:text-foreground"
                    >
                      <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                      Source
                    </a>
                  ) : null}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {withSources && view.sources.length > 0 ? (
        <SourceLinkList aria-label="Sources" sources={view.sources} className="space-y-1.5 border-t border-border/40 pt-2" />
      ) : null}
    </>
  );
}

/** The live stamp, with an amber chip when the feed is past its budget. */
function LiveStamp({ freshness }: { freshness: BackingMetricsView["freshness"] }) {
  if (!freshness.live) return null;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
      {freshness.stale ? (
        <Badge variant="outline" className={cn("h-5 rounded-full px-2 text-[11px] font-medium", SEVERITY_TONE_CLASS.watch.pill)}>
          Stale feed
        </Badge>
      ) : null}
      <span>{freshness.live}</span>
    </span>
  );
}

function BackingFreshness({ freshness }: { freshness: BackingMetricsView["freshness"] }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <LiveStamp freshness={freshness} />
      {freshness.reviewedAt ? <span className="ml-auto whitespace-nowrap">Reviewed {freshness.reviewedAt}</span> : null}
    </span>
  );
}

/**
 * The in-flow summary layer at main-column density: headline and visual on
 * the left, capped at the gauge's width; from a ~42rem body the sub-metric
 * rows move beside them instead of stacking under them.
 */
function BackingModuleSummary({ view }: { view: BackingMetricsView }) {
  const headlineIsFigure = resolveFactValueStyle(view.headline.value) === "figure";
  return (
    <div className="@container/kpi">
      <div className="flex flex-col gap-4 @2xl/kpi:flex-row @2xl/kpi:items-start @2xl/kpi:gap-8">
        <div className="w-full min-w-0 max-w-md">
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className={headlineIsFigure ? HEADLINE_FIGURE_CLASS : HEADLINE_TEXT_CLASS}>{view.headline.value}</span>
            <span className="text-xs text-muted-foreground">{view.headline.basis}</span>
          </p>
          <div className="mt-3 empty:hidden">
            <BackingVisual view={view} />
          </div>
        </div>
        {view.subMetrics.length > 0 ? (
          <dl className="min-w-0 flex-1 divide-y divide-border/40 border-t border-border/40 @2xl/kpi:border-l @2xl/kpi:border-t-0 @2xl/kpi:pl-6">
            {view.subMetrics.map((row) => (
              <div
                key={row.key}
                title={row.hint ?? undefined}
                className="flex items-baseline justify-between gap-3 py-2 @2xl/kpi:first:pt-0"
              >
                <dt className={SUB_METRIC_LABEL_CLASS}>
                  {row.label}
                  {row.hint ? <span className="sr-only">, {row.hint}</span> : null}
                </dt>
                <dd className={SUB_METRIC_VALUE_CLASS}>
                  <SubMetricValue row={row} />
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The Backing KPI (plan §7): Collateralization and Backing mechanics merged.
 * Mount it twice with the same view:
 *
 * - in the `xl+` rail with `anchorTwin`: a `RailMetricCard` that stands in for
 *   both anchors while the in-flow copy is display-hidden;
 * - in flow below `xl` with `id`: an `EvidenceModule` tile in the Backing
 *   board, with the module header grammar (logo · ticker · title, status
 *   chip), one "Review notes & sources" fold and the module footer line. It
 *   fills its grid track; `stripForm` comes from the tile grid. It also
 *   renders the zero-height `#backing-mechanics` alias.
 */
export function BackingMetricsCard({
  view,
  id,
  anchorTwin = false,
  stripForm = false,
}: {
  view: BackingMetricsView;
  id?: string;
  anchorTwin?: boolean;
  /** In flow only: the lone last tile of its board renders in strip form. */
  stripForm?: boolean;
}) {
  const chip = view.coverage ? <CoverageChip coverage={view.coverage} /> : null;
  let body: ReactNode;

  if (id != null && !anchorTwin) {
    const notesCount = view.details.length + view.gaps.length;
    body = (
      <EvidenceModule
        id={id}
        title={view.title}
        variant="tile"
        stripForm={stripForm}
        headerRight={chip}
        visual={<BackingModuleSummary view={view} />}
        footer={
          <EvidenceFooter
            notes={notesCount > 0 ? <BackingDetails view={view} withSources={false} /> : undefined}
            notesCount={notesCount}
            sources={view.sources}
            reviewed={view.freshness.reviewedAt ?? undefined}
          >
            {view.freshness.live ? <LiveStamp freshness={view.freshness} /> : null}
          </EvidenceFooter>
        }
      />
    );
  } else {
    const detailsCount = view.details.length + view.gaps.length + view.sources.length;
    body = (
      <RailMetricCard
        anchorTwin={anchorTwin ? BACKING_METRICS_ANCHOR_ID : undefined}
        title={view.title}
        chip={view.coverage ? { label: view.coverage.label, toneClass: COLLATERAL_COVERAGE_PILL_CLASSES[view.coverage.tone] } : null}
        value={view.headline.value}
        valueCaption={view.headline.basis}
        visual={view.visual || view.sharedBookNote ? <BackingVisual view={view} /> : undefined}
        subMetrics={view.subMetrics.map((row): RailMetricSubMetric => ({
          label: row.label,
          hint: row.hint ?? undefined,
          value: <SubMetricValue row={row} />,
        }))}
        details={detailsCount > 0 ? <BackingDetails view={view} withSources /> : undefined}
        detailsCount={detailsCount}
        freshness={view.freshness.live || view.freshness.reviewedAt ? <BackingFreshness freshness={view.freshness} /> : undefined}
      />
    );
  }

  if (!anchorTwin && id == null) return body;
  return (
    <div className="min-w-0">
      <span
        aria-hidden="true"
        className={cn("block h-0", SECTION_SCROLL_MT)}
        {...(anchorTwin ? { "data-anchor-twin": BACKING_METRICS_ALIAS_ANCHOR_ID } : { id: BACKING_METRICS_ALIAS_ANCHOR_ID })}
      />
      {body}
    </div>
  );
}

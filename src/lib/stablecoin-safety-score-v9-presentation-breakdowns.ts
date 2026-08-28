import type {
  SafetyScoreV9BackingBreakdown,
  SafetyScoreV9ControlBreakdown,
  SafetyScoreV9CurrentCard,
  SafetyScoreV9ExitBreakdown,
  SafetyScoreV9PillarAdjustment,
} from "@shared/types";
import { formatWholeUnitDurationSeconds } from "@shared/lib/relative-time";
import { humanizeSafetyScoreV9Value } from "@/lib/stablecoin-safety-score-v9-presentation-helpers";

export type StablecoinSafetyScoreV9Card = SafetyScoreV9CurrentCard;


/**
 * Restrained colour: rows only leave neutral when they are the problem.
 * Boundaries follow the published grade bands — 65 is the floor of the B range
 * and 40 the floor of D — so a tinted bar always means "C or worse".
 */
const WARN_BELOW_SCORE = 65;
const CRITICAL_BELOW_SCORE = 40;

/** Pillar-weight floor under which a component folds into the group tail. */
const TAIL_WEIGHT_FLOOR = 0.02;
/** Folding one or two rows saves no height, so a tail needs at least this many. */
const MIN_TAIL_ROWS = 3;
/** A composite of one is just the row itself. */
const MIN_COMPOSITE_ROWS = 2;

export type StablecoinSafetyScoreV9RowTone = "neutral" | "warn" | "critical";

function scoreTone(score: number): StablecoinSafetyScoreV9RowTone {
  if (score < CRITICAL_BELOW_SCORE) return "critical";
  if (score < WARN_BELOW_SCORE) return "warn";
  return "neutral";
}

export interface StablecoinSafetyScoreV9BreakdownRow {
  key: string;
  label: string;
  score: number;
  weight: number | null;
  status: string | null;
  tone: StablecoinSafetyScoreV9RowTone;
  /** Secondary line under the row, e.g. a composite's spread summary. */
  detail: string | null;
  /** Members folded into this row; a composite expands to show them. */
  children: StablecoinSafetyScoreV9BreakdownRow[];
}

export interface StablecoinSafetyScoreV9BreakdownGroup {
  key: string;
  /** Null when the pillar has no meaningful sub-grouping. */
  label: string | null;
  score: number | null;
  weight: number | null;
  rows: StablecoinSafetyScoreV9BreakdownRow[];
  /** Low-weight rows folded behind a disclosure, with their combined weight. */
  tail: { label: string; rows: StablecoinSafetyScoreV9BreakdownRow[] } | null;
}

function makeRow(row: {
  key: string;
  label: string;
  score: number;
  weight?: number | null;
  status?: string | null;
  detail?: string | null;
  children?: StablecoinSafetyScoreV9BreakdownRow[];
}): StablecoinSafetyScoreV9BreakdownRow {
  return {
    key: row.key,
    label: row.label,
    score: row.score,
    weight: row.weight ?? null,
    status: row.status ?? null,
    tone: scoreTone(row.score),
    detail: row.detail ?? null,
    children: row.children ?? [],
  };
}

/**
 * Splits a weighted group so the load-bearing inputs lead and the dust folds
 * away. Reserve baskets reach 25 slices on the widest asset, most of them
 * under a percent of the pillar.
 */
function groupWithTail(
  key: string,
  label: string | null,
  score: number | null,
  weight: number | null,
  rows: StablecoinSafetyScoreV9BreakdownRow[],
): StablecoinSafetyScoreV9BreakdownGroup {
  const sorted = [...rows].sort((left, right) => (right.weight ?? 0) - (left.weight ?? 0));
  const tailRows = sorted.filter((row) => row.weight !== null && row.weight < TAIL_WEIGHT_FLOOR);
  if (tailRows.length < MIN_TAIL_ROWS) {
    return { key, label, score, weight, rows: sorted, tail: null };
  }
  const combined = tailRows.reduce((total, row) => total + (row.weight ?? 0), 0);
  return {
    key,
    label,
    score,
    weight,
    rows: sorted.filter((row) => !tailRows.includes(row)),
    tail: {
      label: `Smaller holdings (${tailRows.length}) · ${percentLabel(combined)} combined`,
      rows: tailRows,
    },
  };
}

export interface StablecoinSafetyScoreV9BreakdownMeta {
  key: string;
  label: string;
  value: string;
}

export interface StablecoinSafetyScoreV9Alternative {
  key: string;
  label: string;
  score: number | null;
  included: boolean;
  redundancyCredit: number | null;
  detail: string | null;
}

export interface StablecoinSafetyScoreV9ExitHighlight {
  primaryRouteLabel: string;
  primaryRouteScore: number;
  redundancyCredit: number;
  capacityLine: string | null;
}

export interface StablecoinSafetyScoreV9PillarBreakdown {
  aggregationWeight: number | null;
  evaluatedScore: number | null;
  publishedScore: number | null;
  sectionLabel: string;
  context: StablecoinSafetyScoreV9BreakdownMeta[];
  exitHighlight: StablecoinSafetyScoreV9ExitHighlight | null;
  /** One entry when the pillar has no sub-structure; labelled groups otherwise. */
  groups: StablecoinSafetyScoreV9BreakdownGroup[];
  alternatives: StablecoinSafetyScoreV9Alternative[];
}

function percentLabel(value: number): string {
  return `${(value * 100).toFixed(value * 100 < 10 ? 1 : 0)}%`;
}

function multiplierLabel(value: number): string {
  return value.toFixed(value === 1 ? 0 : 2);
}

function adjustmentContext(
  adjustments: readonly SafetyScoreV9PillarAdjustment[],
): StablecoinSafetyScoreV9BreakdownMeta[] {
  return adjustments.map((adjustment, index) => {
    const label = adjustment.kind === "operational-resilience-credit"
      ? "Resilience credit"
      : "Dependency limit";
    return {
      key: `${adjustment.kind}-${index}`,
      label,
      value: `${adjustment.delta > 0 ? "+" : ""}${adjustment.delta.toFixed(1)} to ${adjustment.scoreAfter.toFixed(1)}`,
    };
  });
}

function parseBackingBreakdown(
  breakdown: SafetyScoreV9BackingBreakdown,
): StablecoinSafetyScoreV9PillarBreakdown {
  return {
    aggregationWeight: breakdown.aggregationWeight,
    evaluatedScore: breakdown.evaluatedScore,
    publishedScore: breakdown.publishedScore,
    sectionLabel: "Backing components",
    // The group scores and weights now head their own sections, so repeating
    // them as context rows would say the same thing twice.
    context: adjustmentContext(breakdown.adjustments),
    exitHighlight: null,
    groups: backingGroups(breakdown),
    alternatives: [],
  };
}

/**
 * Backing already computes a Reserves/Mechanism split whose component weights
 * sum exactly to the group weights, but it was rendered as two context rows
 * above a flat list. Nesting the components under their group turns a 13-row
 * dump into two weighted sections.
 */
function backingGroups(
  breakdown: SafetyScoreV9BackingBreakdown,
): StablecoinSafetyScoreV9BreakdownGroup[] {
  const rowsByGroup = new Map<string, StablecoinSafetyScoreV9BreakdownRow[]>();
  for (const component of breakdown.components) {
    // Only `mechanism` components belong to the mechanism group; both
    // reserve-exposure and reserve-concentration roll up to reserves.
    const groupKey = component.source === "mechanism" ? "mechanism" : "reserves";
    const row = makeRow({
      key: component.key,
      label: component.label,
      score: component.score,
      weight: component.effectiveWeight,
      status: humanizeSafetyScoreV9Value(component.observationState),
    });
    const existing = rowsByGroup.get(groupKey);
    if (existing) existing.push(row);
    else rowsByGroup.set(groupKey, [row]);
  }

  const groups = breakdown.groups
    .filter((group) => (rowsByGroup.get(group.key)?.length ?? 0) > 0)
    .map((group) => groupWithTail(
      group.key,
      group.label,
      group.score,
      group.effectiveWeight,
      rowsByGroup.get(group.key) ?? [],
    ));

  // A component whose group the producer did not publish still has to render.
  const claimed = new Set(groups.map((group) => group.key));
  const orphans = [...rowsByGroup.entries()].filter(([key]) => !claimed.has(key));
  return [
    ...groups,
    ...orphans.map(([key, rows]) => groupWithTail(key, null, null, null, rows)),
  ];
}

function compactUsd(value: number): string {
  return value >= 1_000_000
    ? `$${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`
    : value >= 1_000
      ? `$${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`
      : `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function fullUsd(value: number): string {
  return `$${value.toLocaleString("en-US", {
    maximumFractionDigits: value < 1 ? 2 : 0,
  })}`;
}

function completionLabel(ratio: number): string {
  const percent = ratio * 100;
  if (percent === 0) return "0%";
  if (percent > 0 && percent < 1) return "<1%";
  return `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
}

function excludedRouteReason(
  alternative: SafetyScoreV9ExitBreakdown["alternatives"][number],
): string | null {
  if (alternative.exclusionReason === null) return null;
  if (alternative.capacity === null || alternative.capacity === undefined) {
    return humanizeSafetyScoreV9Value(alternative.exclusionReason);
  }
  if (alternative.capacity.executableUsd === 0) {
    return "Measured zero executable capacity for the stress request";
  }
  if (alternative.exclusionReason === "unsupported-same-notional-route") {
    return "Measured capacity did not qualify as a same-notional exit route";
  }
  return humanizeSafetyScoreV9Value(alternative.exclusionReason);
}

function alternativeRouteDetail(
  alternative: SafetyScoreV9ExitBreakdown["alternatives"][number],
): string | null {
  const isRedemption =
    alternative.routeFamily === "issuer-redemption" ||
    alternative.routeFamily === "eventual-redemption";
  const redemptionHorizon = !isRedemption
    ? null
    : alternative.capacityScoringHorizon === "eventual"
      ? "eventual redemption horizon"
      : alternative.settlementDelaySec === undefined
        ? "24h/eventual redemption horizon"
        : `${formatWholeUnitDurationSeconds(alternative.settlementDelaySec, { minUnit: "minute" })} redemption horizon`;
  const parts: string[] = [];
  if (alternative.capacity) {
    parts.push(
      `${fullUsd(alternative.capacity.executableUsd)} of ${fullUsd(alternative.capacity.requestedNotionalUsd)} executable`,
    );
  }
  if (redemptionHorizon) parts.push(redemptionHorizon);
  // A complete-confidence observation is still evidence. Show it for excluded
  // routes instead of silently dropping the factor and making a measured zero
  // look like an unobserved route.
  if (
    alternative.confidenceFactor != null &&
    (!alternative.included || Math.abs(alternative.confidenceFactor - 1) >= 0.005)
  ) {
    parts.push(`route confidence ${multiplierLabel(alternative.confidenceFactor)}x`);
  }
  const reason = excludedRouteReason(alternative);
  if (reason) parts.push(reason);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function exitReasonFallback(
  score: number | null,
  breakdown: SafetyScoreV9ExitBreakdown,
): string | null {
  if (score !== 0) return null;
  const primary = breakdown.primaryRoute;
  if (primary?.capsApplied.includes("zero-executable-capacity")) {
    return primary.capacity
      ? `The selected ${primary.label} route had zero executable capacity for the ${fullUsd(primary.capacity.requestedNotionalUsd)} stress request.`
      : `The selected ${primary.label} route had zero executable capacity.`;
  }
  if (primary?.capsApplied.includes("immaterial-executable-capacity")) {
    return primary.capacity
      ? `The selected ${primary.label} route cleared only ${fullUsd(primary.capacity.executableUsd)} of the ${fullUsd(primary.capacity.requestedNotionalUsd)} stress request, below the material-capacity floor.`
      : `The selected ${primary.label} route remained below the material-capacity floor.`;
  }
  const measured = breakdown.alternatives.find((route) => route.capacity != null);
  if (measured?.capacity?.executableUsd === 0) {
    return `The reviewed ${measured.label} route had zero executable capacity for the ${fullUsd(measured.capacity.requestedNotionalUsd)} stress request and did not qualify as a viable Exit route.`;
  }
  return breakdown.primaryRoute === null
    ? "No evaluated route qualified as an executable exit for the published stress request."
    : null;
}

function parseExitBreakdown(
  breakdown: SafetyScoreV9ExitBreakdown,
): StablecoinSafetyScoreV9PillarBreakdown {
  const primaryRoute = breakdown.primaryRoute;
  const context: StablecoinSafetyScoreV9BreakdownMeta[] = primaryRoute === null
    ? [{ key: "primary-route", label: "Primary route", value: "No eligible route" }]
    : [];
  const bestObservedAlternative = primaryRoute === null
    ? breakdown.alternatives.find((route) => route.capacity != null)
    : undefined;
  if (bestObservedAlternative?.capacity) {
    context.push({
      key: "observed-route-capacity",
      label: `Observed capacity — ${bestObservedAlternative.label}`,
      value: `${fullUsd(bestObservedAlternative.capacity.executableUsd)} of ${fullUsd(bestObservedAlternative.capacity.requestedNotionalUsd)} executable`,
    });
    if (bestObservedAlternative.confidenceFactor != null) {
      context.push({
        key: "observed-route-confidence",
        label: "Route confidence factor",
        value: `${multiplierLabel(bestObservedAlternative.confidenceFactor)}x`,
      });
    }
    const exclusion = excludedRouteReason(bestObservedAlternative);
    if (exclusion) {
      context.push({
        key: "observed-route-exclusion",
        label: "Why not selected",
        value: exclusion,
      });
    }
  }
  const capacityFloorApplied = primaryRoute?.capsApplied.some(
    (cap) => cap === "zero-executable-capacity" || cap === "immaterial-executable-capacity",
  ) ?? false;
  if (
    primaryRoute !== null &&
    (capacityFloorApplied || Math.abs(primaryRoute.confidenceFactor - 1) >= 0.005)
  ) {
    context.push({
      key: "confidence",
      label: "Confidence",
      value: `${multiplierLabel(primaryRoute.confidenceFactor)}x`,
    });
  }
  if (primaryRoute !== null && Math.abs(primaryRoute.eligibilityMultiplier - 1) >= 0.005) {
    context.push({
      key: "eligibility",
      label: "Eligibility",
      value: `${multiplierLabel(primaryRoute.eligibilityMultiplier)}x`,
    });
  }
  if (breakdown.stressRequest !== null) {
    context.push({
      key: "stress-request",
      label: "Stress request",
      value: `${compactUsd(breakdown.stressRequest.requestedNotionalUsd)} / ${breakdown.stressRequest.maxCostBps.toFixed(0)} bps / ${formatWholeUnitDurationSeconds(breakdown.stressRequest.comparisonWindowSec, { minUnit: "minute" })}`,
    });
  }
  if (primaryRoute?.capacity) {
    const capacity = primaryRoute.capacity;
    const selectedVenue = capacity.protocol ?? primaryRoute.label;
    context.push(
      {
        key: "selected-route-capacity",
        label: "Selected route capacity",
        value: `${fullUsd(capacity.executableUsd)} of ${fullUsd(capacity.requestedNotionalUsd)} executable on selected ${selectedVenue} route`,
      },
      {
        key: "selected-route-bound",
        label: "Horizon / execution cost",
        value: `${formatWholeUnitDurationSeconds(capacity.settlementDelaySec, { minUnit: "minute" })} / ${capacity.executionCostBps.toFixed(0)} bps observed / ${capacity.maxCostBps.toFixed(0)} bps bound`,
      },
    );
    if (capacity.chain !== null || capacity.poolId !== null) {
      context.push({
        key: "selected-route-scope",
        label: "Chain / pool",
        value: [capacity.chain, capacity.poolId].filter(Boolean).join(" / "),
      });
    }
    context.push({
      key: "selected-route-evidence",
      label: "Evidence",
      value: `${humanizeSafetyScoreV9Value(capacity.evidenceKind)}${
        capacity.observedAtSec === null
          ? ""
          : ` · ${new Date(capacity.observedAtSec * 1_000).toISOString().replace(".000Z", "Z")}`
      }`,
    });
  }
  for (const [index, cap] of (primaryRoute?.capsApplied ?? []).entries()) {
    context.push({
      key: `cap-${index}`,
      label: "Applied cap",
      value: humanizeSafetyScoreV9Value(cap),
    });
  }
  context.push(...adjustmentContext(breakdown.adjustments));

  const redundancyCredit = breakdown.diversification?.bonus ?? 0;
  const exitHighlight: StablecoinSafetyScoreV9ExitHighlight | null = primaryRoute === null
    ? null
    : {
        primaryRouteLabel: primaryRoute.label,
        primaryRouteScore: primaryRoute.score,
        redundancyCredit,
        capacityLine: primaryRoute.capacity === undefined || primaryRoute.capacity === null
          ? null
          : `${completionLabel(primaryRoute.capacity.completionRatio)} of ${compactUsd(primaryRoute.capacity.requestedNotionalUsd)} executable ${
              primaryRoute.capacity.settlementDelaySec === 0
                ? "immediately"
                : `within ${formatWholeUnitDurationSeconds(primaryRoute.capacity.settlementDelaySec, { minUnit: "minute" })}`
            } · ${primaryRoute.capacity.executionCostBps.toFixed(0)} bps`,
      };

  return {
    aggregationWeight: breakdown.aggregationWeight,
    evaluatedScore: breakdown.evaluatedScore,
    publishedScore: breakdown.publishedScore,
    sectionLabel: primaryRoute === null
      ? "Route components"
      : `Primary route components — ${primaryRoute.label}`,
    context,
    exitHighlight,
    // The route's components are few and already ordered meaningfully, so exit
    // keeps a single unlabelled group and its producer order.
    groups: [{
      key: "route",
      label: null,
      score: null,
      weight: null,
      rows: (primaryRoute?.components ?? []).map((component) => makeRow({
        key: component.key,
        label: component.key === "capacity"
          ? "Capacity score — selected route"
          : component.label,
        score: component.score,
        weight: component.weight,
      })),
      tail: null,
    }],
    alternatives: breakdown.alternatives.map((alternative) => {
      return {
        key: alternative.key,
        label: alternative.label,
        score: alternative.score,
        included: alternative.included,
        redundancyCredit:
          breakdown.diversification?.routeKey === alternative.key
            ? breakdown.diversification.bonus
            : null,
        detail: alternativeRouteDetail(alternative),
      };
    }),
  };
}

function parseControlBreakdown(
  breakdown: SafetyScoreV9ControlBreakdown,
): StablecoinSafetyScoreV9PillarBreakdown {
  const toRow = (component: SafetyScoreV9ControlBreakdown["components"][number]) => makeRow({
    key: component.key,
    label: component.kind === "mint" ? "Mint authority" : component.label,
    score: component.score,
    status: component.binding ? "Binding" : "Diagnostic",
  });

  // The pillar scores on the lowest binding control, so binding rows lead,
  // cheapest first: the row that sets the score is always the first one read.
  const binding = breakdown.components.filter((component) => component.binding);
  const rows = [...binding]
    .sort((left, right) => left.score - right.score)
    .map(toRow);

  // Non-binding bridges are the bulk of the noise — 48 of usdc-circle's 50
  // rows. They roll into one composite carrying the cohort's worst score,
  // because the pillar rule is a minimum and an average would flatter it. Any
  // binding bridge stays above as its own row; on 37 assets a bridge is the
  // lowest binding control and must never be folded away.
  const loose = breakdown.components.filter((component) => !component.binding);
  const looseBridges = loose.filter((component) => component.kind === "bridge");
  const otherLoose = loose.filter((component) => component.kind !== "bridge");
  rows.push(...otherLoose.map(toRow));

  if (looseBridges.length >= MIN_COMPOSITE_ROWS) {
    const scores = looseBridges.map((component) => component.score);
    const worst = Math.min(...scores);
    const best = Math.max(...scores);
    rows.push(makeRow({
      key: "bridge-composite",
      label: "Bridge deployments",
      score: worst,
      status: `${looseBridges.length} chains`,
      detail: worst === best
        ? `All ${looseBridges.length} at ${worst.toFixed(0)} · not binding`
        : `Worst of ${looseBridges.length} · range ${worst.toFixed(0)}–${best.toFixed(0)} · not binding`,
      children: [...looseBridges]
        .sort((left, right) => left.score - right.score)
        .map(toRow),
    }));
  } else {
    rows.push(...looseBridges.map(toRow));
  }

  return {
    aggregationWeight: breakdown.aggregationWeight,
    evaluatedScore: breakdown.evaluatedScore,
    publishedScore: breakdown.publishedScore,
    sectionLabel: "Control components",
    context: [{
      key: "method",
      label: "Pillar rule",
      value: "Lowest binding control",
    }, ...adjustmentContext(breakdown.adjustments)],
    exitHighlight: null,
    groups: [{ key: "control", label: null, score: null, weight: null, rows, tail: null }],
    alternatives: [],
  };
}

export function pillarBreakdown(
  card: StablecoinSafetyScoreV9Card,
  pillar: "backing" | "exit" | "control",
): StablecoinSafetyScoreV9PillarBreakdown | null {
  const breakdowns = card.breakdowns;
  if (breakdowns === null) return null;
  if (pillar === "backing") return parseBackingBreakdown(breakdowns.backing);
  if (pillar === "exit") return parseExitBreakdown(breakdowns.exit);
  return parseControlBreakdown(breakdowns.control);
}

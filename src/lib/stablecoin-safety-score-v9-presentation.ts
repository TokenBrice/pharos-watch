import type {
  SafetyScoreV9BackingBreakdown,
  SafetyScoreV9Breakdowns,
  SafetyScoreV9ControlBreakdown,
  SafetyScoreV9CurrentCard,
  SafetyScoreV9ExitBreakdown,
  SafetyScoreV9PillarAdjustment,
  SafetyScoreV9PreBreakdownCard,
} from "@shared/types";
import {
  SAFETY_SCORE_V9_RESPONSIBILITY_LABELS,
  SAFETY_SCORE_V9_RESPONSIBILITY_ORDER,
} from "@/lib/safety-score-v9-labels";

type StablecoinSafetyScoreV9Card =
  | SafetyScoreV9CurrentCard
  | SafetyScoreV9PreBreakdownCard;

const PILLARS = [
  ["backing", "Backing"],
  ["exit", "Exit"],
  ["control", "Economic Control"],
] as const;

const ACCESS_FIELDS = [
  ["transfer", "Transfer"],
  ["freezeExposure", "Freeze exposure"],
  ["primaryExit", "Primary exit"],
  ["governance", "Governance"],
] as const;

function isUnknown(value: string): boolean {
  return value.trim().toLowerCase() === "unknown";
}

export function humanizeSafetyScoreV9Value(value: string): string {
  const explicitLabels: Record<string, string> = {
    "none-known": "None known",
    "eligibility-gated": "Eligibility gated",
    "issuer-discretionary": "Issuer discretionary",
    "single-entity": "Single entity",
  };
  const explicit = explicitLabels[value];
  if (explicit) return explicit;
  return value
    .split("-")
    .filter(Boolean)
    .map((part, index) => index === 0 ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part)
    .join(" ");
}

function traceParts(card: StablecoinSafetyScoreV9Card): string[] {
  const { stages } = card.scoreTrace;
  if (stages.preCapScore === null) return [];

  const parts = [`Pre-cap ${stages.preCapScore.toFixed(1)}`];
  if (card.bindingCap) {
    const capLabel = card.bindingCap.kind.startsWith("track-record")
      ? "Track-record"
      : card.bindingCap.source === "active-depeg"
        ? "Active-depeg"
        : humanizeSafetyScoreV9Value(card.bindingCap.source);
    parts.push(`${capLabel} cap ${card.bindingCap.limit.toFixed(0)}`);
  }
  if (stages.pegMultiplier !== null && Math.abs(stages.pegMultiplier - 1) >= 0.005) {
    parts.push(`Peg x${stages.pegMultiplier.toFixed(3)}`);
  }
  if (stages.deploymentAdjustmentPoints !== null && stages.deploymentAdjustmentPoints >= 0.05) {
    parts.push(`Deployment -${stages.deploymentAdjustmentPoints.toFixed(1)}`);
  }
  if (card.scoreTrace.wrapperParentLimit) {
    parts.push(`Parent limit ${card.scoreTrace.wrapperParentLimit.limit.toFixed(0)}`);
  }
  return parts;
}

/**
 * Producer messages quote measured values at full precision
 * ("Measured peg multiplier is 0.804213."). Six decimals read as noise in a
 * sentence, so long fractions round to three for display only.
 */
function tidyMeasuredDecimals(message: string): string {
  return message.replace(/\d+\.\d{4,}/g, (value) => Number(value).toFixed(3));
}

function uniqueMessages(messages: readonly string[]): string[] {
  return [...new Set(messages.map((message) => tidyMeasuredDecimals(message.trim())).filter(Boolean))];
}

export interface StablecoinSafetyScoreV9Component {
  key: string;
  label: string;
  category: string;
}

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

function compactDuration(valueSec: number): string {
  if (valueSec % 86_400 === 0) return `${valueSec / 86_400}d`;
  if (valueSec % 3_600 === 0) return `${valueSec / 3_600}h`;
  return `${Math.round(valueSec / 60)}m`;
}

function completionLabel(ratio: number): string {
  const percent = ratio * 100;
  if (percent > 0 && percent < 1) return "<1%";
  return `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
}

function parseExitBreakdown(
  breakdown: SafetyScoreV9ExitBreakdown,
): StablecoinSafetyScoreV9PillarBreakdown {
  const primaryRoute = breakdown.primaryRoute;
  const context: StablecoinSafetyScoreV9BreakdownMeta[] = primaryRoute === null
    ? [{ key: "primary-route", label: "Primary route", value: "No eligible route" }]
    : [];
  if (primaryRoute !== null && Math.abs(primaryRoute.confidenceFactor - 1) >= 0.005) {
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
      value: `${compactUsd(breakdown.stressRequest.requestedNotionalUsd)} / ${breakdown.stressRequest.maxCostBps.toFixed(0)} bps / ${compactDuration(breakdown.stressRequest.comparisonWindowSec)}`,
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
        value: `${compactDuration(capacity.settlementDelaySec)} / ${capacity.executionCostBps.toFixed(0)} bps observed / ${capacity.maxCostBps.toFixed(0)} bps bound`,
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
                : `within ${compactDuration(primaryRoute.capacity.settlementDelaySec)}`
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
      const confidence =
        alternative.confidenceFactor != null &&
        Math.abs(alternative.confidenceFactor - 1) >= 0.005
          ? ` · confidence ${multiplierLabel(alternative.confidenceFactor)}x`
          : "";
      const isRedemption =
        alternative.routeFamily === "issuer-redemption" ||
        alternative.routeFamily === "eventual-redemption";
      const redemptionHorizon = !isRedemption
        ? ""
        : alternative.capacityScoringHorizon === "eventual"
          ? "eventual redemption horizon"
          : alternative.settlementDelaySec === undefined
            ? "24h/eventual redemption horizon"
            : `${compactDuration(alternative.settlementDelaySec)} redemption horizon`;
      return {
        key: alternative.key,
        label: alternative.label,
        score: alternative.score,
        included: alternative.included,
        redundancyCredit:
          breakdown.diversification?.routeKey === alternative.key
            ? breakdown.diversification.bonus
            : null,
        detail: alternative.exclusionReason === null
          ? alternative.capacity
            ? `${fullUsd(alternative.capacity.executableUsd)} of ${fullUsd(alternative.capacity.requestedNotionalUsd)} executable${
                redemptionHorizon ? ` · ${redemptionHorizon}` : ""
              }${confidence}`
            : isRedemption
            ? `${redemptionHorizon}${confidence}`
            : confidence.slice(3) || null
          : humanizeSafetyScoreV9Value(alternative.exclusionReason),
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

function cardBreakdowns(card: StablecoinSafetyScoreV9Card): SafetyScoreV9Breakdowns | null {
  return "breakdowns" in card ? card.breakdowns : null;
}

function pillarBreakdown(
  card: StablecoinSafetyScoreV9Card,
  pillar: "backing" | "exit" | "control",
): StablecoinSafetyScoreV9PillarBreakdown | null {
  const breakdowns = cardBreakdowns(card);
  if (breakdowns === null) return null;
  if (pillar === "backing") return parseBackingBreakdown(breakdowns.backing);
  if (pillar === "exit") return parseExitBreakdown(breakdowns.exit);
  return parseControlBreakdown(breakdowns.control);
}

function componentBaseLabel(component: string): { label: string; category: string } {
  if (component === "mint") return { label: "Mint authority", category: "Authority" };
  if (component === "oracle") return { label: "Oracle design", category: "Oracle" };
  if (component.startsWith("mechanism:")) {
    return {
      label: humanizeSafetyScoreV9Value(component.slice("mechanism:".length)),
      category: "Mechanism",
    };
  }
  if (component === "reserve:concentration") {
    return { label: "Reserve concentration", category: "Reserve" };
  }
  if (component.startsWith("reserve:reserve:")) {
    return { label: "Reserve slice", category: "Reserve" };
  }
  if (component.startsWith("redemption:")) {
    const routeKind = component.split(":").at(-1) ?? "route";
    return {
      label: routeKind === "collateral-redeem"
        ? "Collateral redemption"
        : humanizeSafetyScoreV9Value(routeKind),
      category: "Redemption",
    };
  }
  if (component.startsWith("bridge:")) {
    const chain = component.split(":")[1] ?? "deployment";
    return {
      label: `${humanizeSafetyScoreV9Value(chain)} bridge`,
      category: "Bridge",
    };
  }
  if (component.startsWith("dex:")) {
    let decoded = component;
    try {
      decoded = decodeURIComponent(component);
    } catch {
      // The public key remains usable even if a producer emits malformed escaping.
    }
    const venue = decoded.includes(":curve:") ? "Curve" : "DEX";
    return { label: `${venue} liquidity route`, category: "DEX" };
  }
  return {
    label: humanizeSafetyScoreV9Value(component.replaceAll(":", " ")),
    category: "Input",
  };
}

export function describeSafetyScoreV9Components(
  components: readonly string[],
): StablecoinSafetyScoreV9Component[] {
  const base = components.map((component) => ({ key: component, ...componentBaseLabel(component) }));
  const totals = new Map<string, number>();
  for (const item of base) {
    const groupingKey = `${item.category}\u0000${item.label}`;
    totals.set(groupingKey, (totals.get(groupingKey) ?? 0) + 1);
  }
  const occurrences = new Map<string, number>();
  return base.map((item) => {
    const groupingKey = `${item.category}\u0000${item.label}`;
    const occurrence = (occurrences.get(groupingKey) ?? 0) + 1;
    occurrences.set(groupingKey, occurrence);
    return {
      ...item,
      label: (totals.get(groupingKey) ?? 0) > 1 ? `${item.label} ${occurrence}` : item.label,
    };
  });
}

export interface StablecoinSafetyScoreV9AccessRow {
  key: string;
  label: string;
  value: string;
}

/**
 * Access posture rows, standalone so the summary rail can render them without
 * building the whole card presentation. Unknown fields drop out entirely.
 */
export function buildSafetyScoreV9AccessRows(
  card: StablecoinSafetyScoreV9Card,
): StablecoinSafetyScoreV9AccessRow[] {
  return ACCESS_FIELDS.flatMap(([key, label]) => {
    const value = card.accessPosture[key];
    return isUnknown(value) ? [] : [{ key, label, value: humanizeSafetyScoreV9Value(value) }];
  });
}

export interface StablecoinSafetyScoreV9AttributionGroup {
  key: string;
  label: string;
  messages: string[];
}

/**
 * V9 splits every drag into two causally distinct buckets: what was measured
 * and found adverse, and what stayed unresolved. Only the second carries an
 * owner, so only the second is grouped by responsibility.
 */
function attributionGroups(
  items: ReadonlyArray<{ message: string; responsibility: string }>,
): StablecoinSafetyScoreV9AttributionGroup[] {
  const byResponsibility = new Map<string, string[]>();
  for (const item of items) {
    const existing = byResponsibility.get(item.responsibility);
    if (existing) existing.push(item.message);
    else byResponsibility.set(item.responsibility, [item.message]);
  }
  return [...byResponsibility.entries()]
    .sort(([left], [right]) => {
      const leftRank = SAFETY_SCORE_V9_RESPONSIBILITY_ORDER.indexOf(left);
      const rightRank = SAFETY_SCORE_V9_RESPONSIBILITY_ORDER.indexOf(right);
      return (leftRank < 0 ? Number.MAX_SAFE_INTEGER : leftRank)
        - (rightRank < 0 ? Number.MAX_SAFE_INTEGER : rightRank);
    })
    .map(([responsibility, messages]) => ({
      key: responsibility,
      label: SAFETY_SCORE_V9_RESPONSIBILITY_LABELS[responsibility]
        ?? humanizeSafetyScoreV9Value(responsibility),
      messages: uniqueMessages(messages),
    }));
}

/**
 * The causal split on its own, without building every pillar breakdown. The
 * summary rail renders the score-construction module beside the card and only
 * needs this slice; running the full presentation twice per page would rebuild
 * all three pillar breakdowns for nothing.
 */
export interface StablecoinSafetyScoreV9Attribution {
  /** Measured and found adverse. Always self-attributed, so ungrouped. */
  adverseMessages: string[];
  /** Unresolved facts, grouped by whose gap they are. */
  boundedGroups: StablecoinSafetyScoreV9AttributionGroup[];
}

export function buildSafetyScoreV9Attribution(
  card: StablecoinSafetyScoreV9Card,
): StablecoinSafetyScoreV9Attribution {
  return {
    adverseMessages: uniqueMessages(card.scoreTrace.adverseAttribution.items.map((item) => item.message)),
    boundedGroups: attributionGroups(card.scoreTrace.boundedUncertaintyAttribution.items),
  };
}

export interface StablecoinSafetyScoreV9Presentation {
  accessRows: Array<{ key: string; label: string; value: string }>;
  /** Measured and found adverse. Always self-attributed, so ungrouped. */
  adverseMessages: string[];
  /** Unresolved facts, grouped by whose gap they are. */
  boundedGroups: StablecoinSafetyScoreV9AttributionGroup[];
  evidenceSummary: string;
  evidenceReasons: string[];
  pillars: Array<{
    key: "backing" | "exit" | "control";
    label: string;
    score: number | null;
    evidenceSummary: string;
    componentCount: number;
    components: StablecoinSafetyScoreV9Component[];
    breakdown: StablecoinSafetyScoreV9PillarBreakdown | null;
    reasons: string[];
    isWeakest: boolean;
  }>;
  primaryReasons: string[];
  traceParts: string[];
}

export function buildStablecoinSafetyScoreV9Presentation(
  card: StablecoinSafetyScoreV9Card,
): StablecoinSafetyScoreV9Presentation {
  const hasIncompleteDexCoverage = card.scoreTrace.evidenceResponsibility.summaries.some(
    (summary) => summary.reasonCodes.includes("incomplete-dex-route-coverage"),
  );
  return {
    traceParts: traceParts(card),
    ...buildSafetyScoreV9Attribution(card),
    pillars: PILLARS.map(([key, label]) => {
      const pillar = card.pillars[key];
      const baseEvidenceSummary = isUnknown(pillar.freshness)
        ? `${humanizeSafetyScoreV9Value(pillar.evidenceLevel)} evidence`
        : `${humanizeSafetyScoreV9Value(pillar.evidenceLevel)} evidence · ${humanizeSafetyScoreV9Value(pillar.freshness)}`;
      const evidenceSummary = key === "exit"
        ? `${baseEvidenceSummary.replace(" evidence", " selected-route evidence")}${
            hasIncompleteDexCoverage ? " · partial DEX coverage" : ""
          }`
        : baseEvidenceSummary;
      return {
        key,
        label,
        score: pillar.score,
        evidenceSummary,
        componentCount: pillar.components.length,
        components: describeSafetyScoreV9Components(pillar.components),
        breakdown: pillarBreakdown(card, key),
        reasons: uniqueMessages(pillar.reasons.map((reason) => reason.message)),
        isWeakest: card.weakestPillar?.pillar === key,
      };
    }),
    evidenceSummary: isUnknown(card.evidence.freshness)
      ? `${humanizeSafetyScoreV9Value(card.evidence.level)} coverage`
      : `${humanizeSafetyScoreV9Value(card.evidence.level)} coverage · ${humanizeSafetyScoreV9Value(card.evidence.freshness)}`,
    evidenceReasons: uniqueMessages(card.evidence.reasons.map((reason) => reason.message)),
    accessRows: buildSafetyScoreV9AccessRows(card),
    primaryReasons: uniqueMessages([
      ...card.nrReasons.map((reason) => reason.message),
      ...card.accessPosture.reasons.map((reason) => reason.message),
    ]),
  };
}

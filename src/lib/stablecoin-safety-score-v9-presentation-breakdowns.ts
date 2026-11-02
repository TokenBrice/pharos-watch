import type {
  SafetyScoreV9BackingBreakdown,
  SafetyScoreV9ControlBreakdown,
  SafetyScoreV9CurrentCard,
  SafetyScoreV9ExitBreakdown,
} from "@shared/types";
import { formatV9PresentationUsd as compactUsd } from "@shared/lib/format";
import { formatWholeUnitDurationSeconds } from "@shared/lib/relative-time";
import { resolveV9EffectiveScoringWeight } from "@shared/types/safety-score-v9-public-causes";
import { humanizeSafetyScoreV9Value } from "@/lib/stablecoin-safety-score-v9-presentation-helpers";
import { describeExitRouteVenue, describePartialEvidence, formatPartialEvidenceGap } from "@/lib/safety-score-reason-labels";
import { resolveControlComponentRoles } from "@/lib/pillar-evidence-strips";
import type { ControlComponentRole } from "@shared/lib/classification";
import {
  isV9BridgeRouteComponentFor,
  isV9DeploymentControlComponentKey,
  v9BridgeMintControlKey,
  v9BridgeRouteDeploymentKey,
  v9ControlChainLabel,
} from "@shared/lib/safety-score-v9/control-component-keys";

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

export type StablecoinSafetyScoreV9RowTone = "neutral" | "warn" | "critical";

function scoreTone(score: number | null): StablecoinSafetyScoreV9RowTone {
  if (score === null) return "neutral";
  if (score < CRITICAL_BELOW_SCORE) return "critical";
  if (score < WARN_BELOW_SCORE) return "warn";
  return "neutral";
}

export interface StablecoinSafetyScoreV9BreakdownRow {
  key: string;
  label: string;
  score: number | null;
  weight: number | null;
  status: string | null;
  tone: StablecoinSafetyScoreV9RowTone;
  /** Secondary line under the row, e.g. a composite's spread summary. */
  detail: string | null;
  /** Members folded into this row; a composite expands to show them. */
  children: StablecoinSafetyScoreV9BreakdownRow[];
  /** Economic Control only: how the input relates to the pillar minimum. */
  role: ControlComponentRole | null;
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
  score: number | null;
  weight?: number | null;
  status?: string | null;
  detail?: string | null;
  children?: StablecoinSafetyScoreV9BreakdownRow[];
  role?: ControlComponentRole | null;
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
    role: row.role ?? null,
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
  const tailRows = sorted.filter((row) => row.score !== null && row.weight !== null && row.weight > 0 && row.weight < TAIL_WEIGHT_FLOOR);
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
  /** Reader venue ("Curve on Ethereum"); never the internal "AMM 10" ordinal. */
  venueLabel: string;
  primaryRouteScore: number | null;
  redundancyCredit: number;
  /** "$25M at 4 bps", with the settlement window when not immediate. */
  capacityLine: string | null;
}

export interface StablecoinSafetyScoreV9PillarBreakdown {
  aggregationWeight: number | null;
  evaluatedScore: number | null;
  publishedScore: number | null;
  sectionLabel: string;
  context: StablecoinSafetyScoreV9BreakdownMeta[];
  exitHighlight: StablecoinSafetyScoreV9ExitHighlight | null;
  /** One sentence read before the rows, for a rule too long for the context grid. */
  note: string | null;
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

function causeLabel(cause: "A" | "B" | "C" | "U" | "D" | null | undefined): string | null {
  switch (cause) {
    case "A": return "excluded — pipeline gap";
    case "B": return "excluded — awaiting curation";
    case "C": return "Issuer does not disclose";
    case "U": return "Unresolved";
    case "D": return "Measured and adverse";
    case null: case undefined: return null;
  }
}

function costLabel(cost: number | null): string {
  return cost === null ? "cost not evaluated" : `${cost.toFixed(0)} bps`;
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
    context: [],
    exitHighlight: null,
    note: null,
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
      weight: resolveV9EffectiveScoringWeight(component),
      status: causeLabel(component.cause) ?? humanizeSafetyScoreV9Value(component.observationState),
      detail: component.wholeAssetWeight === null ? null : `${percentLabel(component.wholeAssetWeight ?? resolveV9EffectiveScoringWeight(component))} of whole asset`,
      children: (component.factors ?? []).map((factor) => makeRow({
        key: factor.componentKey,
        label: humanizeSafetyScoreV9Value(factor.componentKey),
        score: factor.score,
        weight: resolveV9EffectiveScoringWeight(factor),
        status: causeLabel(factor.cause),
        detail: `${percentLabel(factor.normalizedWeight ?? 0)} normalized factor weight`,
      })),
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
      resolveV9EffectiveScoringWeight(group),
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

function fullUsd(value: number): string {
  return `$${value.toLocaleString("en-US", {
    maximumFractionDigits: value < 1 ? 2 : 0,
  })}`;
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
  if (alternative.rawSameNotionalCostBps !== null) parts.push(`${costLabel(alternative.rawSameNotionalCostBps)} raw same-notional cost`);
  if (alternative.capacity) {
    parts.push(
      `${fullUsd(alternative.capacity.executableUsd)} of ${fullUsd(alternative.capacity.requestedNotionalUsd)} executable`,
    );
  }
  if (redemptionHorizon) parts.push(redemptionHorizon);
  parts.push(`capacity method: ${humanizeSafetyScoreV9Value(alternative.capacityEvidenceTier)}`);
  if (alternative.confidenceDimensions) {
    for (const [dimension, confidence] of Object.entries(alternative.confidenceDimensions)) {
      if (confidence.cause !== null) parts.push(`${humanizeSafetyScoreV9Value(dimension)}: ${causeLabel(confidence.cause)}`);
    }
  }
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
  card: StablecoinSafetyScoreV9Card,
): StablecoinSafetyScoreV9PillarBreakdown {
  const primaryRoute = breakdown.primaryRoute;
  const context: StablecoinSafetyScoreV9BreakdownMeta[] = primaryRoute === null
    ? [{ key: "primary-route", label: "Primary route", value: breakdown.aggregationDisposition === "excluded-a-b"
      ? describePartialEvidence(card)?.gaps.map(formatPartialEvidenceGap).join(" · ") ?? "Excluded"
      : "No eligible route" }]
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
  if (primaryRoute !== null) {
    for (const [key, dimension] of Object.entries(primaryRoute.confidenceDimensions)) {
      context.push({ key: `confidence-${key}`, label: `Confidence — ${humanizeSafetyScoreV9Value(key)}`,
        value: `${multiplierLabel(dimension.factor)}x${dimension.cause == null ? "" : ` · ${causeLabel(dimension.cause)}`}` });
    }
    context.push({ key: "capacity-method", label: "Capacity evidence tier", value: humanizeSafetyScoreV9Value(primaryRoute.capacityEvidenceTier) });
    context.push({ key: "raw-cost", label: "Raw same-notional cost", value: costLabel(primaryRoute.rawSameNotionalCostBps) });
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
        value: `${formatWholeUnitDurationSeconds(capacity.settlementDelaySec, { minUnit: "minute" })} / ${costLabel(capacity.executionCostBps)} observed / ${capacity.maxCostBps.toFixed(0)} bps bound`,
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

  const redundancyCredit = breakdown.diversification?.bonus ?? 0;
  const exitHighlight: StablecoinSafetyScoreV9ExitHighlight | null = primaryRoute === null
    ? null
    : {
        venueLabel: describeExitRouteVenue(primaryRoute),
        primaryRouteScore: primaryRoute.score,
        redundancyCredit,
        capacityLine: primaryRoute.capacity === undefined || primaryRoute.capacity === null
          ? null
          : `${compactUsd(primaryRoute.capacity.executableUsd)}${
              primaryRoute.capacity.completionRatio < 1
                ? ` of ${compactUsd(primaryRoute.capacity.requestedNotionalUsd)}`
                : ""
            } at ${costLabel(primaryRoute.capacity.executionCostBps)}${
              primaryRoute.capacity.settlementDelaySec === 0
                ? ""
                : ` within ${formatWholeUnitDurationSeconds(primaryRoute.capacity.settlementDelaySec, { minUnit: "minute" })}`
            }`,
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
    note: null,
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
        weight: resolveV9EffectiveScoringWeight(component),
        status: causeLabel(component.cause),
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

type ControlComponent = SafetyScoreV9ControlBreakdown["components"][number];

/** Strongest claim first: a group of parts takes the role its most binding part holds. */
const ROLE_ORDER: readonly ControlComponentRole[] = ["limiting", "eligible", "diagnostic", "excluded"];

/** Tied score-setting deployments stay visible as rows up to this count; a larger tie folds. */
const MAX_UNFOLDED_LIMITING_DEPLOYMENTS = 3;

/** The row's role tag names limiting and diagnostic cohorts; the others say it in the label. */
const DEPLOYMENT_FOLD_LABELS: Record<ControlComponentRole, string> = {
  limiting: "Deployments",
  eligible: "Eligible deployments",
  diagnostic: "Deployments",
  excluded: "Unscored deployments",
};

interface ControlEntry {
  row: StablecoinSafetyScoreV9BreakdownRow;
  role: ControlComponentRole;
  deployment: boolean;
}

/** Cheapest first; at a score tie asset-level inputs lead, since they name the whole asset. */
function compareControlEntries(left: ControlEntry, right: ControlEntry): number {
  return (left.row.score ?? Infinity) - (right.row.score ?? Infinity) ||
    Number(left.deployment) - Number(right.deployment) ||
    left.row.label.localeCompare(right.row.label);
}

function shortDeploymentAddress(deploymentKey: string): string {
  const address = deploymentKey.slice(deploymentKey.indexOf(":") + 1);
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/**
 * One bridged deployment publishes two components over the same control: its
 * bridge-tier route and the authority that mints its token there. They read
 * as one deployment row scored on the weaker part, both parts named beneath.
 * Unpaired parts keep their own producer label.
 */
function deploymentEntries(
  components: readonly ControlComponent[],
  roleByKey: ReadonlyMap<string, ControlComponentRole>,
): ControlEntry[] {
  const routes = components.filter((component) => component.kind === "bridge");
  const paired = new Set<string>();
  const entries: { parts: ControlComponent[]; deploymentKey: string | null }[] = [];
  for (const component of components) {
    const controlKey = v9BridgeMintControlKey(component.key);
    const route = controlKey === null
      ? undefined
      : routes.find((candidate) => !paired.has(candidate.key) && isV9BridgeRouteComponentFor(candidate.key, controlKey));
    if (controlKey === null || route === undefined) continue;
    paired.add(component.key).add(route.key);
    entries.push({ parts: [route, component], deploymentKey: v9BridgeRouteDeploymentKey(route.key, controlKey) });
  }
  for (const component of components) {
    if (!paired.has(component.key)) entries.push({ parts: [component], deploymentKey: null });
  }

  const chainOf = (deploymentKey: string | null) =>
    deploymentKey === null ? null : v9ControlChainLabel(deploymentKey);
  const chainCounts = new Map<string, number>();
  for (const entry of entries) {
    const chain = entry.parts.length > 1 ? chainOf(entry.deploymentKey) : null;
    if (chain !== null) chainCounts.set(chain, (chainCounts.get(chain) ?? 0) + 1);
  }

  return entries.map(({ parts, deploymentKey }) => {
    const roles = parts.map((part) => roleByKey.get(part.key) ?? "excluded");
    const role = ROLE_ORDER.find((candidate) => roles.includes(candidate))!;
    // Score from the parts that hold the row's role, so a diagnostic part can
    // never lower an eligible deployment's bar.
    const scores = parts.flatMap((part, index) =>
      roles[index] === role && part.score !== null ? [part.score] : []);
    const chain = parts.length > 1 ? chainOf(deploymentKey) : null;
    // A pair off the chain registry still reads as a deployment, not as its
    // route's generic fallback label.
    const label = parts.length === 1
      ? parts[0]!.label
      : chain === null
        ? "Bridged deployment"
        : (chainCounts.get(chain) ?? 0) > 1 ? `${chain} · ${shortDeploymentAddress(deploymentKey!)}` : chain;
    const causes = [...new Set(parts.flatMap((part) => causeLabel(part.cause) ?? []))];
    return {
      role,
      deployment: true,
      row: makeRow({
        key: parts.map((part) => part.key).join("|"),
        label,
        score: scores.length === 0 ? null : Math.min(...scores),
        role,
        status: causes.length === 0 ? null : causes.join(" · "),
        detail: parts.length > 1
          ? parts.map((part) => `${part.kind === "bridge" ? "Bridge route" : "Bridged-token mint"} ${
            part.score === null ? "—" : part.score.toFixed(0)}${part.posture === "compromised" ? " (compromised)" : ""}`).join(" · ")
          : null,
      }),
    };
  });
}

function foldSummary(rows: readonly StablecoinSafetyScoreV9BreakdownRow[]): string {
  const scores = rows.flatMap((row) => row.score === null ? [] : [row.score]);
  if (scores.length === 0) return `${rows.length} not scored`;
  const worst = Math.min(...scores);
  const best = Math.max(...scores);
  if (worst === best && scores.length === rows.length) return `All ${rows.length} at ${worst.toFixed(0)}`;
  // Rows arrive cheapest first, so the first weak rows are the weakest.
  const weak = rows.filter((row) => row.score !== null && row.score < WARN_BELOW_SCORE);
  const named = weak.slice(0, 2).map((row) => `${row.label} ${row.score!.toFixed(0)}`);
  const weakLine = weak.length === 0
    ? ""
    : weak.length > named.length
      ? ` · ${weak.length} weak (under ${WARN_BELOW_SCORE}) · weakest ${named.join(", ")}`
      : ` · weakest ${named.join(", ")}`;
  return `Range ${worst.toFixed(0)}–${best.toFixed(0)}${weakLine}`;
}

/**
 * Economic Control scores the lowest eligible input, so the breakdown leads
 * with the limiting inputs and orders the rest by role. Asset-level inputs are
 * always rows. Deployment inputs (bridge routes, bridged-token mints and local
 * mints) number up to a hundred on the widest assets: each role's cohort folds
 * into one worst-score row once it has three members, except that up to three
 * limiting deployments stay rows so the input that sets the score is never
 * hidden. Worst, not mean: the pillar rule is a minimum.
 */
function parseControlBreakdown(
  card: StablecoinSafetyScoreV9Card,
  breakdown: SafetyScoreV9ControlBreakdown,
): StablecoinSafetyScoreV9PillarBreakdown {
  const roleByKey = new Map(
    (resolveControlComponentRoles(card)?.components ?? []).map((component) => [component.key, component.role]),
  );
  const assetEntries: ControlEntry[] = breakdown.components
    .filter((component) => !isV9DeploymentControlComponentKey(component.key))
    .map((component) => {
      const role = roleByKey.get(component.key) ?? "excluded";
      return {
        role,
        deployment: false,
        row: makeRow({
          key: component.key,
          label: component.label,
          score: component.score,
          role,
          status: causeLabel(component.cause),
        }),
      };
    });
  const deployments = deploymentEntries(
    breakdown.components.filter((component) => isV9DeploymentControlComponentKey(component.key)),
    roleByKey,
  );

  const rows: StablecoinSafetyScoreV9BreakdownRow[] = [];
  for (const role of ROLE_ORDER) {
    const assets = assetEntries.filter((entry) => entry.role === role);
    const cohort = deployments.filter((entry) => entry.role === role).sort(compareControlEntries);
    const foldAt = role === "limiting" ? MAX_UNFOLDED_LIMITING_DEPLOYMENTS + 1 : MIN_TAIL_ROWS;
    const entries: ControlEntry[] = [...assets];
    if (cohort.length >= foldAt) {
      const children = cohort.map((entry) => entry.row);
      const scores = children.flatMap((row) => row.score === null ? [] : [row.score]);
      entries.push({
        role,
        deployment: true,
        row: makeRow({
          key: `deployments:${role}`,
          label: `${DEPLOYMENT_FOLD_LABELS[role]} (${children.length})`,
          score: scores.length === 0 ? null : Math.min(...scores),
          role,
          detail: foldSummary(children),
          children,
        }),
      });
    } else {
      entries.push(...cohort);
    }
    rows.push(...entries.sort(compareControlEntries).map((entry) => entry.row));
  }

  const hasDiagnostics = [...assetEntries, ...deployments].some((entry) => entry.role === "diagnostic");
  return {
    aggregationWeight: breakdown.aggregationWeight,
    evaluatedScore: breakdown.evaluatedScore,
    publishedScore: breakdown.publishedScore,
    sectionLabel: "Control inputs",
    context: [{ key: "method", label: "Pillar rule", value: "Lowest eligible input" }],
    exitHighlight: null,
    // v10.31: deployment-local authority, bridge-route tiers and control
    // incidents leave the minimum but are priced by supply share in
    // deployment risk; a bridged-token mint's own score is not authority-priced.
    note: hasDiagnostics
      ? "Diagnostic inputs sit outside the minimum. Deployment risk can still charge bridge routes, control incidents and deployment-local authority by their share of supply."
      : null,
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
  if (pillar === "exit") return parseExitBreakdown(breakdowns.exit, card);
  return parseControlBreakdown(card, breakdowns.control);
}

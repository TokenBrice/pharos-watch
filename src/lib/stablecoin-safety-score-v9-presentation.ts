import type {
  SafetyScoreV9BackingBreakdown,
  SafetyScoreV9Breakdowns,
  SafetyScoreV9ControlBreakdown,
  SafetyScoreV9CurrentCard,
  SafetyScoreV9ExitBreakdown,
  SafetyScoreV9PillarAdjustment,
  SafetyScoreV9PreBreakdownCard,
} from "@shared/types";

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

function uniqueMessages(messages: readonly string[]): string[] {
  return [...new Set(messages.map((message) => message.trim()).filter(Boolean))];
}

export interface StablecoinSafetyScoreV9Component {
  key: string;
  label: string;
  category: string;
}

export interface StablecoinSafetyScoreV9BreakdownRow {
  key: string;
  label: string;
  score: number;
  weight: number | null;
  status: string | null;
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
  detail: string | null;
}

export interface StablecoinSafetyScoreV9PillarBreakdown {
  aggregationWeight: number | null;
  evaluatedScore: number | null;
  publishedScore: number | null;
  sectionLabel: string;
  context: StablecoinSafetyScoreV9BreakdownMeta[];
  rows: StablecoinSafetyScoreV9BreakdownRow[];
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
    context: [
      ...breakdown.groups.map((group) => ({
        key: group.key,
        label: group.label,
        value: `${group.score.toFixed(0)} / 100 · ${percentLabel(group.effectiveWeight)} pillar weight`,
      })),
      ...adjustmentContext(breakdown.adjustments),
    ],
    rows: breakdown.components.map((component) => ({
      key: component.key,
      label: component.label,
      score: component.score,
      weight: component.effectiveWeight,
      status: humanizeSafetyScoreV9Value(component.observationState),
    })),
    alternatives: [],
  };
}

function compactUsd(value: number): string {
  return value >= 1_000_000
    ? `$${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`
    : `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function compactDuration(valueSec: number): string {
  if (valueSec % 86_400 === 0) return `${valueSec / 86_400}d`;
  if (valueSec % 3_600 === 0) return `${valueSec / 3_600}h`;
  return `${Math.round(valueSec / 60)}m`;
}

function parseExitBreakdown(
  breakdown: SafetyScoreV9ExitBreakdown,
): StablecoinSafetyScoreV9PillarBreakdown {
  const primaryRoute = breakdown.primaryRoute;
  const context: StablecoinSafetyScoreV9BreakdownMeta[] = primaryRoute === null
    ? [{ key: "primary-route", label: "Primary route", value: "No eligible route" }]
    : [
        { key: "primary-route", label: "Primary route", value: primaryRoute.label },
        { key: "route-score", label: "Route score", value: `${primaryRoute.score.toFixed(0)} / 100` },
      ];
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
  if (breakdown.diversification !== null && breakdown.diversification.bonus > 0) {
    context.push({
      key: "diversification",
      label: "Diversification",
      value: `+${breakdown.diversification.bonus.toFixed(1)}`,
    });
  }
  if (breakdown.stressRequest !== null) {
    context.push({
      key: "stress-request",
      label: "Stress request",
      value: `${compactUsd(breakdown.stressRequest.requestedNotionalUsd)} / ${breakdown.stressRequest.maxCostBps.toFixed(0)} bps / ${compactDuration(breakdown.stressRequest.comparisonWindowSec)}`,
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

  return {
    aggregationWeight: breakdown.aggregationWeight,
    evaluatedScore: breakdown.evaluatedScore,
    publishedScore: breakdown.publishedScore,
    sectionLabel: "Route components",
    context,
    rows: (primaryRoute?.components ?? []).map((component) => ({
      key: component.key,
      label: component.label,
      score: component.score,
      weight: component.weight,
      status: null,
    })),
    alternatives: breakdown.alternatives.map((alternative) => ({
      key: alternative.key,
      label: alternative.label,
      score: alternative.score,
      included: alternative.included,
      detail: alternative.exclusionReason === null
        ? null
        : humanizeSafetyScoreV9Value(alternative.exclusionReason),
    })),
  };
}

function parseControlBreakdown(
  breakdown: SafetyScoreV9ControlBreakdown,
): StablecoinSafetyScoreV9PillarBreakdown {
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
    rows: breakdown.components.map((component) => ({
      key: component.key,
      label: component.label,
      score: component.score,
      weight: null,
      status: component.binding ? "Binding" : "Diagnostic",
    })),
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

export interface StablecoinSafetyScoreV9Presentation {
  accessRows: Array<{ key: string; label: string; value: string }>;
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
  return {
    traceParts: traceParts(card),
    pillars: PILLARS.map(([key, label]) => {
      const pillar = card.pillars[key];
      const evidenceSummary = isUnknown(pillar.freshness)
        ? `${humanizeSafetyScoreV9Value(pillar.evidenceLevel)} evidence`
        : `${humanizeSafetyScoreV9Value(pillar.evidenceLevel)} evidence · ${humanizeSafetyScoreV9Value(pillar.freshness)}`;
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
    accessRows: ACCESS_FIELDS.flatMap(([key, label]) => {
      const value = card.accessPosture[key];
      return isUnknown(value) ? [] : [{ key, label, value: humanizeSafetyScoreV9Value(value) }];
    }),
    primaryReasons: uniqueMessages([
      ...card.nrReasons.map((reason) => reason.message),
      ...card.accessPosture.reasons.map((reason) => reason.message),
    ]),
  };
}

/**
 * Pure formatters for the Show Your Work panel.
 *
 * Each `format*` produces a flat table-row representation of the inputs that
 * feed a score. The component renders these rows verbatim, so all per-kind
 * shape decisions live here.
 *
 * Per W3-C brief: PegScore decomposition is not on the payload, so no
 * PegScore formatter ships in v1.
 */

import { formatPercent } from "@shared/lib/format";
import { LIQUIDITY_SCORE_WEIGHTS } from "@shared/lib/liquidity-score-weights";
import {
  BACKING_DIVERSITY_WEIGHT,
  CHAIN_ENVIRONMENT_WEIGHT,
  CONCENTRATION_WEIGHT,
  PEG_STABILITY_WEIGHT,
  QUALITY_WEIGHT,
} from "@shared/lib/chain-health";
import type { MethodologyContextKey } from "@/lib/methodology-context";
import type { SafetyScoreV9CurrentCard } from "@shared/types";
import type { DexLiquidityData, StressSignalEntry } from "@shared/types/market";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import type { StabilityIndexCurrent } from "@shared/types/stability";
import type { ChainEnvironmentEvidence, ChainHealthFactors } from "@shared/types/chains";

export interface ShowYourWorkRow {
  label: string;
  value: string;
  weight?: string;
  contribution?: string;
}

export interface ShowYourWorkTable {
  rows: ShowYourWorkRow[];
  formula: string;
  topic: MethodologyContextKey;
  versionLabel?: string;
}

export type SafetyScoreV9ShowWorkCard = SafetyScoreV9CurrentCard;

/**
 * Show-your-work tables use an em-dash for "not reported" (the shared formatters
 * use "-" / "N/A") and must never group thousands — a raw `comparisonWindowSec`
 * has to read back as the exact configured integer. Only `fmtPct` matches a
 * shared formatter exactly; the rest stay local for those two reasons.
 */
const NOT_REPORTED = "—";

function fmtNum(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return NOT_REPORTED;
  return v.toFixed(digits);
}

function fmtPct(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return NOT_REPORTED;
  return formatPercent(v, digits);
}

function fmtFractionPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return NOT_REPORTED;
  const percent = v * 100;
  return `${percent.toFixed(Number.isInteger(percent) ? 0 : 1)}%`;
}

function fmtSigned(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
}

function fmtUsd(v: number): string {
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export function formatReportCardV9(
  card: SafetyScoreV9ShowWorkCard,
  methodologyVersion: string,
): ShowYourWorkTable {
  const stages = card.scoreTrace.stages;
  const breakdowns = card.breakdowns;
  const rows: ShowYourWorkRow[] = [
    {
      label: "Backing pillar",
      value: fmtNum(card.pillars.backing.score, 1),
      weight: breakdowns === null ? undefined : fmtFractionPct(breakdowns.backing.aggregationWeight),
    },
    {
      label: "Exit pillar",
      value: fmtNum(card.pillars.exit.score, 1),
      weight: breakdowns === null ? undefined : fmtFractionPct(breakdowns.exit.aggregationWeight),
    },
    {
      label: "Economic Control pillar",
      value: fmtNum(card.pillars.control.score, 1),
      weight: breakdowns === null ? undefined : fmtFractionPct(breakdowns.control.aggregationWeight),
    },
  ];

  if (breakdowns !== null) {
    rows.push({
      label: "Backing evaluated score",
      value: fmtNum(breakdowns.backing.evaluatedScore, 1),
    });
    for (const group of breakdowns.backing.groups) {
      rows.push({
        label: `Backing group · ${group.label} [${group.key}]`,
        value: fmtNum(group.score, 1),
        weight: fmtFractionPct(group.effectiveWeight),
      });
    }
    for (const component of breakdowns.backing.components) {
      rows.push({
        label: `Backing component · ${component.label} [${component.key}]`,
        value: `${fmtNum(component.score, 1)} · ${component.source} · ${component.observationState}`,
        weight: fmtFractionPct(component.effectiveWeight),
        contribution: fmtNum(component.weightedContribution, 1),
      });
    }
    for (const adjustment of breakdowns.backing.adjustments) {
      rows.push({
        label: `Backing adjustment · ${adjustment.kind}`,
        value: `${fmtNum(adjustment.scoreBefore, 1)} → ${fmtNum(adjustment.scoreAfter, 1)}`,
        contribution: fmtSigned(adjustment.delta),
      });
    }

    rows.push({
      label: "Exit evaluated score",
      value: fmtNum(breakdowns.exit.evaluatedScore, 1),
    });
    if (breakdowns.exit.stressRequest !== null) {
      rows.push(
        {
          label: "Exit stress request · requested notional",
          value: fmtUsd(breakdowns.exit.stressRequest.requestedNotionalUsd),
        },
        {
          label: "Exit stress request · maximum cost",
          value: `${fmtNum(breakdowns.exit.stressRequest.maxCostBps, 0)} bps`,
        },
        {
          label: "Exit stress request · comparison window",
          value: `${fmtNum(breakdowns.exit.stressRequest.comparisonWindowSec, 0)} seconds`,
        },
      );
    }
    const primaryRoute = breakdowns.exit.primaryRoute;
    if (primaryRoute !== null) {
      rows.push({
        label: `Exit primary route · ${primaryRoute.label} [${primaryRoute.key}]`,
        value: `${fmtNum(primaryRoute.score, 1)} · ${primaryRoute.routeFamily}`,
      });
      for (const component of primaryRoute.components) {
        rows.push({
          label: `Exit component · ${component.label} [${component.key}]`,
          value: fmtNum(component.score, 1),
          weight: fmtFractionPct(component.weight),
          contribution: fmtNum(component.weightedContribution, 1),
        });
      }
      rows.push(
        {
          label: "Exit route · confidence factor",
          value: `${primaryRoute.confidenceFactor.toFixed(3)}x`,
        },
        {
          label: "Exit route · eligibility multiplier",
          value: `${primaryRoute.eligibilityMultiplier.toFixed(3)}x`,
        },
      );
      for (const cap of primaryRoute.capsApplied) {
        rows.push({ label: `Exit route cap · ${cap}`, value: "applied" });
      }
    }
    if (breakdowns.exit.diversification !== null) {
      rows.push({
        label:
          `Exit diversification · ${breakdowns.exit.diversification.routeLabel}` +
          ` [${breakdowns.exit.diversification.routeKey}]`,
        value: fmtSigned(breakdowns.exit.diversification.bonus),
      });
    }
    for (const route of breakdowns.exit.alternatives) {
      rows.push({
        label: `Exit alternative · ${route.label} [${route.key}]`,
        value: [
          route.score === null ? "NR" : fmtNum(route.score, 1),
          route.routeFamily,
          route.included ? "included" : route.exclusionReason ?? "excluded",
        ].join(" · "),
      });
    }
    for (const adjustment of breakdowns.exit.adjustments) {
      rows.push({
        label: `Exit adjustment · ${adjustment.kind}`,
        value: `${fmtNum(adjustment.scoreBefore, 1)} → ${fmtNum(adjustment.scoreAfter, 1)}`,
        contribution: fmtSigned(adjustment.delta),
      });
    }

    rows.push({
      label: "Economic Control evaluated score",
      value: fmtNum(breakdowns.control.evaluatedScore, 1),
    });
    for (const component of breakdowns.control.components) {
      rows.push({
        label: `Economic Control component · ${component.label} [${component.key}]`,
        value: [
          fmtNum(component.score, 1),
          component.binding ? "binding" : "diagnostic",
          component.kind,
          component.posture,
        ].join(" · "),
      });
    }
    for (const adjustment of breakdowns.control.adjustments) {
      rows.push({
        label: `Economic Control adjustment · ${adjustment.kind}`,
        value: `${fmtNum(adjustment.scoreBefore, 1)} → ${fmtNum(adjustment.scoreAfter, 1)}`,
        contribution: fmtSigned(adjustment.delta),
      });
    }
  }

  rows.push(
    { label: "Weighted pillar mean", value: fmtNum(stages.weightedPillarMean, 1) },
    { label: "Bounded-headroom aggregate", value: fmtNum(stages.aggregatedQualityScore, 1) },
    {
      label: "Peg multiplier",
      value: stages.pegMultiplier == null ? "—" : `${stages.pegMultiplier.toFixed(3)}x`,
    },
    { label: "Base asset score", value: fmtNum(stages.baseAssetScore, 1) },
    { label: "Deployment adjustment", value: fmtNum(stages.deploymentAdjustmentPoints, 1) },
    { label: "Pre-cap score", value: fmtNum(stages.preCapScore, 1) },
  );

  if (card.bindingCap) {
    rows.push({
      label: "Binding cap",
      value: `${card.bindingCap.limit.toFixed(0)} (${card.bindingCap.kind})`,
    });
  }
  if (card.scoreTrace.wrapperParentLimit) {
    rows.push({
      label: "Wrapper parent limit",
      value: fmtNum(card.scoreTrace.wrapperParentLimit.limit, 1),
    });
  }
  for (const adjustment of card.scoreTrace.scoreAdjustments) {
    rows.push({
      label: adjustment.label,
      value: `+${adjustment.appliedPoints.toFixed(1)}`,
    });
  }
  rows.push({ label: "Published score", value: fmtNum(stages.publishedScore, 1) });

  return {
    rows,
    formula:
      breakdowns === null
        ? "three pillars → bounded-headroom aggregation → peg multiplier → deployment adjustment → policy score adjustment → caps → published score"
        : "Backing = weighted effective components; Exit = selected weighted route × confidence × eligibility, then caps and diversification; Economic Control = minimum binding component; published pillars → bounded-headroom aggregation → peg multiplier → deployment adjustment → policy score adjustment → caps → published score",
    topic: "safetyScore",
    versionLabel: methodologyVersion,
  };
}

// ---------------------------------------------------------------------------
// DEWS
// ---------------------------------------------------------------------------

export function formatDews(current: StressSignalEntry): ShowYourWorkTable {
  const rows: ShowYourWorkRow[] = Object.entries(current.signals).map(([key, sig]) => ({
    label: key,
    value: sig.available ? Math.round(sig.value).toString() : "n/a",
  }));

  rows.push({ label: "Composite score", value: Math.round(current.score).toString() });
  rows.push({ label: "Band", value: current.band });

  if (current.amplifiers) {
    rows.push({
      label: "PSI amplifier",
      value: `${current.amplifiers.psi.toFixed(2)}x`,
    });
    rows.push({
      label: "Contagion amplifier",
      value: `${current.amplifiers.contagion.toFixed(2)}x`,
    });
  }

  return {
    rows,
    formula:
      "score = weighted average of available stress signals with weights redistributed, then × PSI amplifier × contagion amplifier and clamped to 0..100; band maps to Calm/Watch/Alert/Warning/Danger",
    topic: "dews",
  };
}

// ---------------------------------------------------------------------------
// Liquidity Score
// ---------------------------------------------------------------------------

export function formatLiquidity(scoreComponents: NonNullable<DexLiquidityData["scoreComponents"]>): ShowYourWorkTable {
  const rows: ShowYourWorkRow[] = LIQUIDITY_SCORE_WEIGHTS.map((w) => {
    const value = scoreComponents[w.key];
    const contribution = value * w.weight;
    return {
      label: w.label,
      value: value.toFixed(1),
      weight: w.displayWeight,
      contribution: contribution.toFixed(1),
    };
  });

  return {
    rows,
    formula: "score = 0.30·TVL Depth + 0.20·Volume + 0.20·Pool Quality + 0.20·Durability + 0.10·Diversity",
    topic: "liquidityScore",
  };
}

// ---------------------------------------------------------------------------
// PSI
// ---------------------------------------------------------------------------

export function formatPsi(current: StabilityIndexCurrent): ShowYourWorkTable {
  const rows: ShowYourWorkRow[] = [
    { label: "Severity penalty", value: current.components.severity.toFixed(1) },
    { label: "Breadth penalty", value: current.components.breadth.toFixed(1) },
  ];
  if (current.components.stressBreadth != null) {
    rows.push({
      label: "Stress breadth penalty",
      value: current.components.stressBreadth.toFixed(1),
    });
  }
  rows.push({ label: "Trend offset", value: current.components.trend.toFixed(1) });
  rows.push({ label: "Composite score", value: current.score.toFixed(1) });
  rows.push({ label: "Band", value: current.band });

  if (current.contributors && current.contributors.length > 0) {
    const top = current.contributors.slice(0, 5);
    for (const c of top) {
      rows.push({
        label: `Top contributor · ${c.symbol}`,
        value: `${c.bps.toFixed(1)} bps`,
        contribution: c.factor.toFixed(2),
      });
    }
  }

  return {
    rows,
    formula:
      "PSI = clamp(100 − severity − breadth − stressBreadth + trend, 0, 100); mega-cap depegs amplified via log₂ factor",
    topic: "psi",
  };
}

// ---------------------------------------------------------------------------
// Redemption Backstop
// ---------------------------------------------------------------------------

export function formatRedemption(entry: RedemptionBackstopEntry): ShowYourWorkTable {
  const rows: ShowYourWorkRow[] = [
    { label: "Access", value: fmtNum(entry.accessScore) },
    { label: "Settlement", value: fmtNum(entry.settlementScore) },
    { label: "Execution certainty", value: fmtNum(entry.executionCertaintyScore) },
    { label: "Capacity", value: fmtNum(entry.capacityScore) },
    { label: "Output asset quality", value: fmtNum(entry.outputAssetQualityScore) },
    { label: "Cost", value: fmtNum(entry.costScore) },
    { label: "Composite", value: fmtNum(entry.score) },
    { label: "Route family", value: entry.routeFamily },
    { label: "Access model", value: entry.accessModel },
    { label: "Settlement model", value: entry.settlementModel },
    { label: "Execution model", value: entry.executionModel },
    { label: "Capacity confidence", value: entry.capacityConfidence },
    { label: "Model confidence", value: entry.modelConfidence },
    {
      label: "Immediate capacity (USD)",
      value: entry.immediateCapacityUsd != null ? fmtUsd(entry.immediateCapacityUsd) : NOT_REPORTED,
    },
    {
      label: "Immediate capacity ratio",
      value: entry.immediateCapacityRatio != null ? fmtPct(entry.immediateCapacityRatio * 100, 1) : "—",
    },
    {
      label: "Fee (bps)",
      value: entry.feeBps != null ? entry.feeBps.toString() : "—",
    },
  ];

  return {
    rows,
    formula:
      "route score = weighted(access, settlement, execution, capacity, output, cost) with route-family caps; effective exit then applies capacity, freshness, model-confidence discount, and independent-route diversification before comparing with DEX liquidity",
    topic: "redemptionBackstop",
  };
}

// ---------------------------------------------------------------------------
// Chain Health
// ---------------------------------------------------------------------------

function formatChainEnvironmentValue(
  score: number,
  evidence?: ChainEnvironmentEvidence,
): string {
  if (!evidence) return fmtNum(score);
  if (evidence.source === "l2beat") {
    return `${fmtNum(score)} (${evidence.name} ${evidence.stage}, risk ${evidence.riskScore}, snapshot ${evidence.snapshot.fetchedAt})`;
  }
  return `${fmtNum(score)} (Pharos tier ${evidence.resilienceTier})`;
}

export function formatChainHealth(
  factors: ChainHealthFactors,
  chainEnvironmentEvidence?: ChainEnvironmentEvidence,
): ShowYourWorkTable {
  const rows: ShowYourWorkRow[] = [
    {
      label: "Quality",
      value: fmtNum(factors.quality),
      weight: `${Math.round(QUALITY_WEIGHT * 100)}%`,
      contribution: factors.quality != null ? (factors.quality * QUALITY_WEIGHT).toFixed(1) : "—",
    },
    {
      label: "Chain environment",
      value: formatChainEnvironmentValue(factors.chainEnvironment, chainEnvironmentEvidence),
      weight: `${Math.round(CHAIN_ENVIRONMENT_WEIGHT * 100)}%`,
      contribution: (factors.chainEnvironment * CHAIN_ENVIRONMENT_WEIGHT).toFixed(1),
    },
    {
      label: "Concentration",
      value: fmtNum(factors.concentration),
      weight: `${Math.round(CONCENTRATION_WEIGHT * 100)}%`,
      contribution: (factors.concentration * CONCENTRATION_WEIGHT).toFixed(1),
    },
    {
      label: "Peg stability",
      value: fmtNum(factors.pegStability),
      weight: `${Math.round(PEG_STABILITY_WEIGHT * 100)}%`,
      contribution: (factors.pegStability * PEG_STABILITY_WEIGHT).toFixed(1),
    },
    {
      label: "Backing diversity",
      value: fmtNum(factors.backingDiversity),
      weight: `${Math.round(BACKING_DIVERSITY_WEIGHT * 100)}%`,
      contribution: (factors.backingDiversity * BACKING_DIVERSITY_WEIGHT).toFixed(1),
    },
  ];

  return {
    rows,
    formula:
      "score = 0.30·Quality + 0.20·Environment + 0.20·Concentration + 0.20·Peg Stability + 0.10·Backing Diversity",
    topic: "chainHealth",
  };
}

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

import { LIQUIDITY_SCORE_WEIGHTS } from "@shared/lib/liquidity-score-weights";
import {
  BACKING_DIVERSITY_WEIGHT,
  CHAIN_ENVIRONMENT_WEIGHT,
  CONCENTRATION_WEIGHT,
  PEG_STABILITY_WEIGHT,
  QUALITY_WEIGHT,
} from "@shared/lib/chain-health";
import type { MethodologyContextKey } from "@/lib/methodology-context";
import type { RawDimensionInputs, SafetyScoreV9CurrentCard } from "@shared/types";
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

function fmtNum(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(digits);
}

function fmtPct(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(digits)}%`;
}

function fmtBool(v: boolean | null | undefined): string {
  if (v == null) return "—";
  return v ? "yes" : "no";
}

// ---------------------------------------------------------------------------
// Report Card
// ---------------------------------------------------------------------------

export function formatReportCard(rawInputs: RawDimensionInputs): ShowYourWorkTable {
  const rows: ShowYourWorkRow[] = [
    { label: "Peg score", value: fmtNum(rawInputs.pegScore) },
    {
      label: "Active depeg",
      value: rawInputs.activeDepeg
        ? rawInputs.activeDepegBps != null
          ? `yes (${rawInputs.activeDepegBps} bps)`
          : "yes"
        : "no",
    },
    { label: "Depeg event count", value: fmtNum(rawInputs.depegEventCount) },
    { label: "Liquidity score", value: fmtNum(rawInputs.liquidityScore) },
    { label: "Observed DEX score", value: fmtNum(rawInputs.liquidityObservedScore) },
    { label: "DEX exit evidence", value: rawInputs.liquidityExitEvidenceKind ?? "legacy / unavailable" },
    { label: "DEX evidence ceiling", value: fmtNum(rawInputs.liquidityEvidenceCeiling) },
    { label: "DEX coverage class", value: rawInputs.liquidityCoverageClass ?? "—" },
    { label: "DEX coverage confidence", value: fmtNum(rawInputs.liquidityCoverageConfidence) },
    { label: "DEX effective TVL", value: fmtNum(rawInputs.liquidityEffectiveTvlUsd) },
    { label: "DEX balance-measured TVL", value: fmtNum(rawInputs.liquidityBalanceMeasuredTvlUsd) },
    { label: "Redemption backstop score", value: fmtNum(rawInputs.redemptionBackstopScore) },
    { label: "Effective exit score", value: fmtNum(rawInputs.effectiveExitScore) },
    {
      label: "Redemption used for liquidity",
      value: fmtBool(rawInputs.redemptionUsedForLiquidity),
    },
    { label: "Chain tier", value: String(rawInputs.chainTier) },
    { label: "Deployment model", value: rawInputs.deploymentModel },
    { label: "Collateral quality", value: rawInputs.collateralQuality },
    { label: "Custody model", value: rawInputs.custodyModel },
    { label: "Governance tier", value: rawInputs.governanceTier },
    { label: "Governance quality", value: rawInputs.governanceQuality },
    { label: "Mint authority score", value: fmtNum(rawInputs.mintAuthorityScore) },
    { label: "Oracle risk tier", value: rawInputs.oracleRiskTier ?? "—" },
    { label: "Oracle risk score", value: fmtNum(rawInputs.oracleRiskScore) },
    { label: "Bridge route tier", value: rawInputs.bridgeRouteRiskTier ?? "—" },
    { label: "Bridge route score", value: fmtNum(rawInputs.bridgeRouteRiskScore) },
    {
      label: "Blacklist exposure",
      value:
        typeof rawInputs.canBeBlacklisted === "boolean"
          ? rawInputs.canBeBlacklisted
            ? "yes"
            : "no"
          : rawInputs.canBeBlacklisted,
    },
    {
      label: "Bluechip grade",
      value: rawInputs.bluechipGrade ?? "—",
    },
    {
      label: "Dependencies",
      value: rawInputs.dependencies.length
        ? rawInputs.dependencies.map((d) => `${d.id} (${d.type})`).join(", ")
        : "none",
    },
  ];

  return {
    rows,
    formula:
      "overall = weighted(liquidity/exit, resilience, decentralization, dependency risk) with NR weights redistributed; decentralization may include chain, CDP oracle, bridge-route, and mint-authority penalties; then × (Peg Score/100)^0.40, ×0.9 when no liquidity/exit input exists, and capped by severe active-depeg peaks",
    topic: "safetyScore",
  };
}

export function formatReportCardV9(
  card: SafetyScoreV9CurrentCard,
  methodologyVersion: string,
): ShowYourWorkTable {
  const stages = card.scoreTrace.stages;
  const rows: ShowYourWorkRow[] = [
    { label: "Backing pillar", value: fmtNum(card.pillars.backing.score, 1) },
    { label: "Exit pillar", value: fmtNum(card.pillars.exit.score, 1) },
    { label: "Economic Control pillar", value: fmtNum(card.pillars.control.score, 1) },
    { label: "Weighted pillar mean", value: fmtNum(stages.weightedPillarMean, 1) },
    { label: "Bounded-headroom aggregate", value: fmtNum(stages.aggregatedQualityScore, 1) },
    {
      label: "Peg multiplier",
      value: stages.pegMultiplier == null ? "—" : `${stages.pegMultiplier.toFixed(3)}x`,
    },
    { label: "Base asset score", value: fmtNum(stages.baseAssetScore, 1) },
    { label: "Deployment adjustment", value: fmtNum(stages.deploymentAdjustmentPoints, 1) },
    { label: "Pre-cap score", value: fmtNum(stages.preCapScore, 1) },
  ];

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
      "three pillars → bounded-headroom aggregation → peg multiplier → deployment adjustment → policy score adjustment → caps → published score",
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
    { label: "Effective exit", value: fmtNum(entry.effectiveExitScore) },
    { label: "Route family", value: entry.routeFamily },
    { label: "Access model", value: entry.accessModel },
    { label: "Settlement model", value: entry.settlementModel },
    { label: "Execution model", value: entry.executionModel },
    { label: "Capacity confidence", value: entry.capacityConfidence },
    { label: "Model confidence", value: entry.modelConfidence },
    {
      label: "Immediate capacity (USD)",
      value: entry.immediateCapacityUsd != null ? `$${entry.immediateCapacityUsd.toLocaleString()}` : "—",
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

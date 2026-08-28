import { EXTERNAL_OPPORTUNITY_YIELD_TYPES } from "@/lib/yield-view-config";
import { numberValue as finiteNumber } from "@shared/lib/type-guards";
import type {
  YieldSourceRisk,
  YieldSourceRole,
  YieldType,
} from "@shared/types";
import type {
  YieldSourceConfidenceTier,
  YieldSourcePublishedFreshness,
} from "@/lib/yield-source-presentation";
export {
  YIELD_RANK_CHANGE_DRIVER_LABELS,
  YIELD_SOURCE_CONFIDENCE_STYLES,
  getYieldSourceFreshnessDisplay,
  type YieldSourceConfidenceStyle,
  type YieldSourceConfidenceTier,
  type YieldSourceFreshnessDisplay,
  type YieldSourcePublishedFreshness,
} from "@/lib/yield-source-presentation";

export type YieldSourceDepthLens = "deep" | "moderate" | "thin" | "unknown";
export type YieldSourcePosture = "clean" | "watch" | "speculative";

export type YieldSourceRiskDriverKey =
  | "high-risk-venue"
  | "elevated-risk-venue"
  | "concentrated-dependency"
  | "reward-heavy"
  | "thin-source-depth"
  | "stale-source"
  | "limited-history"
  | "source-changed";

export interface YieldSourceRiskDriver {
  key: YieldSourceRiskDriverKey;
  label: string;
  description: string;
}

export const YIELD_SOURCE_POSTURE_ORDER: readonly YieldSourcePosture[] = ["clean", "watch", "speculative"];

export const YIELD_SOURCE_POSTURE_DEFINITIONS: Record<YieldSourcePosture, { label: string; description: string }> = {
  clean: {
    label: "Clean",
    description: "Non-thin source with no published staleness or material source-risk or source-change evidence.",
  },
  watch: {
    label: "Watch",
    description: "Medium or explainable source-risk evidence without severe venue, depth, staleness, or reward drivers.",
  },
  speculative: {
    label: "Speculative",
    description: "High venue risk, thin/stale/reward-heavy source evidence, multiple source-risk drivers, or a material penalty.",
  },
};

export const YIELD_SOURCE_CONFIDENCE_ORDER: readonly YieldSourceConfidenceTier[] = [
  "deterministic",
  "curated",
  "discovered",
  "fallback",
];

export const YIELD_SOURCE_CONFIDENCE_DEFINITIONS: Record<
  YieldSourceConfidenceTier,
  { label: string; description: string }
> = {
  deterministic: {
    label: "Deterministic",
    description: "Derived from repeatable on-chain, rate, or protocol math rather than a discovered market row.",
  },
  curated: {
    label: "Curated",
    description: "Reviewed source or protocol API selected by confidence-weighted arbitration.",
  },
  discovered: {
    label: "Discovered",
    description: "Automatically matched lending or pool source that passed the yield source guards.",
  },
  fallback: {
    label: "Fallback",
    description: "Backup source path used when stronger source families are unavailable.",
  },
};

export const YIELD_SOURCE_DEPTH_DEFINITIONS: Record<YieldSourceDepthLens, { label: string; description: string }> = {
  deep: {
    label: "Deep",
    description: "Venue TVL is at least 1% of the tracked stablecoin supply.",
  },
  moderate: {
    label: "Moderate",
    description: "Venue TVL is 0.1% to 1% of the tracked stablecoin supply.",
  },
  thin: {
    label: "Thin",
    description: "Venue TVL is below 0.1% of the tracked stablecoin supply.",
  },
  unknown: {
    label: "Unknown",
    description: "Depth cannot be classified because source TVL or supply-relative depth is missing.",
  },
};

export function classifyYieldSourceDepth(params: {
  sourceRisk?: YieldSourceRisk | null;
  sourceTvlUsd?: number | null;
}): YieldSourceDepthLens {
  const sourceDepthRatio = finiteNumber(params.sourceRisk?.sourceDepthRatio);
  const sourceTvlUsd = finiteNumber(params.sourceTvlUsd);

  if (sourceDepthRatio === null || sourceTvlUsd === null) return "unknown";
  if (sourceDepthRatio >= 0.01) return "deep";
  if (sourceDepthRatio >= 0.001) return "moderate";
  return "thin";
}

/**
 * Depth lens as displayed. `native-unmeasured` deliberately lives outside
 * {@link YieldSourceDepthLens}: the lens drives depth filters, board counts,
 * source posture, and URL state, none of which change here.
 */
export type YieldSourceDepthDisplayLens = YieldSourceDepthLens | "native-unmeasured";

export interface YieldSourceDepthDisplay {
  lens: YieldSourceDepthDisplayLens;
  /** Short noun for chips and cells: "Deep", "Unknown", "Native". */
  label: string;
  /** Self-contained phrase: "Deep depth", "Native · depth n/a". */
  phrase: string;
  description: string;
  /** True when the row has no venue to size apart from the asset itself. */
  isNativeUnmeasured: boolean;
}

const NATIVE_UNMEASURED_DEPTH = {
  label: "Native",
  phrase: "Native · depth n/a",
  description:
    "Yield accrues on the asset itself, so there is no venue TVL to compare against supply. Depth is not applicable here rather than missing.",
} as const;

const NATIVE_SOURCE_ROLES: Partial<Record<YieldSourceRole, true>> = {
  "canonical-holder": true,
  "fallback-proxy": true,
  "degraded-canonical": true,
};

/**
 * Whether the yield accrues on the asset itself rather than in an external
 * venue. `sourceRole` is authoritative wherever the row carries it; the
 * leaderboard's summary projection omits the field, so the holder-versus-
 * opportunity yield-type split decides there.
 */
export function isNativeYieldSource(
  sourceRole: YieldSourceRole | null | undefined,
  yieldType: YieldType,
): boolean {
  if (sourceRole === "external-opportunity") return false;
  if (sourceRole && NATIVE_SOURCE_ROLES[sourceRole]) return true;
  return !EXTERNAL_OPPORTUNITY_YIELD_TYPES.has(yieldType);
}

/**
 * Depth for display. `classifyYieldSourceDepth` reports "unknown" whenever
 * venue TVL is missing, which reads as a measurement we failed to make. On a
 * native row nothing was missed — there is no venue to measure — so those rows
 * say that instead. External rows keep "Unknown depth": there the gap is real.
 */
export function getYieldSourceDepthDisplay(params: {
  depthLens: YieldSourceDepthLens;
  yieldType: YieldType;
  sourceRole?: YieldSourceRole | null;
  sourceTvlUsd?: number | null;
}): YieldSourceDepthDisplay {
  if (
    params.depthLens === "unknown" &&
    finiteNumber(params.sourceTvlUsd) === null &&
    isNativeYieldSource(params.sourceRole, params.yieldType)
  ) {
    return { lens: "native-unmeasured", ...NATIVE_UNMEASURED_DEPTH, isNativeUnmeasured: true };
  }
  const meta = YIELD_SOURCE_DEPTH_DEFINITIONS[params.depthLens];
  return {
    lens: params.depthLens,
    label: meta.label,
    phrase: `${meta.label} depth`,
    description: meta.description,
    isNativeUnmeasured: false,
  };
}

export function getYieldSourceRiskDrivers(params: {
  sourceRisk?: YieldSourceRisk | null;
  sourceChanged?: boolean;
  sourceFreshness?: YieldSourcePublishedFreshness | null;
  warningSignals?: readonly string[] | null;
}): YieldSourceRiskDriver[] {
  const sourceRisk = params.sourceRisk ?? null;
  const warningSignals = params.warningSignals ?? [];
  const sourceIsStale = params.sourceFreshness === "stale"
    || (params.sourceFreshness == null && warningSignals.includes("data-stale"));
  if (!sourceRisk && !params.sourceChanged && warningSignals.length === 0 && !sourceIsStale) return [];

  const rewardShare = finiteNumber(sourceRisk?.rewardShare);
  const sourceDepthRatio = finiteNumber(sourceRisk?.sourceDepthRatio);
  const observationCount30d = finiteNumber(sourceRisk?.observationCount30d);
  const sourceSwitchCount30d = finiteNumber(sourceRisk?.sourceSwitchCount30d);
  const drivers: YieldSourceRiskDriver[] = [];
  const hasDriver = (key: YieldSourceRiskDriverKey) => drivers.some((driver) => driver.key === key);

  // Venue + concentration drivers lead because protocol risk outweighs data-quality
  // signals. Gated on populated evidence, so unknown/low venues stay a no-op.
  const venueRiskWeighted = finiteNumber(sourceRisk?.venueRiskWeighted);
  const venueWeightedSuffix =
    venueRiskWeighted !== null ? ` (venue risk ${venueRiskWeighted.toFixed(1)}/5)` : "";
  // Confidence is surfaced, not used to discount the penalty: an uncertain venue
  // is scored conservatively (uncertainty = risk), and the chip says so.
  const venueConfidence = sourceRisk?.venueRiskConfidence ?? null;
  const confidenceNote =
    venueConfidence === "low"
      ? " Venue score is low-confidence — a conservative estimate where audit/admin facts were unverifiable."
      : venueConfidence === "partial"
        ? " Venue score is partial-confidence — some audit or admin facts are unverified."
        : "";
  const lowConfidenceSuffix = venueConfidence === "low" ? " · low confidence" : "";
  if (sourceRisk?.venueRiskTier === "high") {
    drivers.push({
      key: "high-risk-venue",
      label: `high-risk venue${lowConfidenceSuffix}`,
      description: `The yield venue scores high on the Yearn-style 5-category risk rubric${venueWeightedSuffix}.${confidenceNote}`,
    });
  } else if (sourceRisk?.venueRiskTier === "medium") {
    drivers.push({
      key: "elevated-risk-venue",
      label: `elevated-risk venue${lowConfidenceSuffix}`,
      description: `The yield venue scores medium on the Yearn-style 5-category risk rubric${venueWeightedSuffix}.${confidenceNote}`,
    });
  }

  const concentration = sourceRisk?.dependencyConcentration ?? null;
  if (concentration) {
    drivers.push({
      key: "concentrated-dependency",
      label: `${concentration.ecosystem} concentration`,
      description: concentration.note,
    });
  }

  if (rewardShare !== null && rewardShare > 0.5) {
    drivers.push({
      key: "reward-heavy",
      label: "reward-heavy",
      description: "Most APY comes from incentives, not base yield.",
    });
  }

  if (warningSignals.includes("reward-heavy") && !hasDriver("reward-heavy")) {
    drivers.push({
      key: "reward-heavy",
      label: "reward-heavy",
      description: "Most APY comes from incentives, not base yield.",
    });
  }

  if (sourceDepthRatio !== null && sourceDepthRatio < 0.001) {
    drivers.push({
      key: "thin-source-depth",
      label: "thin source depth",
      description: "Venue TVL is small relative to the stablecoin supply or row context.",
    });
  }

  if (warningSignals.includes("low-source-tvl") && !hasDriver("thin-source-depth")) {
    drivers.push({
      key: "thin-source-depth",
      label: "thin source depth",
      description: "Venue TVL is small relative to the stablecoin supply or row context.",
    });
  }

  if (sourceIsStale) {
    drivers.push({
      key: "stale-source",
      label: "stale source",
      description: "Latest source observation is older than expected for its family.",
    });
  }

  if (observationCount30d !== null && observationCount30d > 0 && observationCount30d < 7) {
    drivers.push({
      key: "limited-history",
      label: "limited history",
      description: "Fewer than seven distinct UTC observation days are available for mature confidence.",
    });
  }

  if (params.sourceChanged || (sourceSwitchCount30d !== null && sourceSwitchCount30d > 0)) {
    drivers.push({
      key: "source-changed",
      label: "source changed",
      description: "Selected source changed versus the prior published snapshot.",
    });
  }

  return drivers;
}

const CLEAN_SOURCE_RISK_PENALTY_MAX = 1.1;
const SPECULATIVE_SOURCE_RISK_PENALTY_MIN = 1.25;
const SOURCE_POSTURE_WATCH_WARNING_SIGNALS = new Set([
  "yield-spike",
  "yield-divergence",
  "negative-trend",
  "tvl-outflow",
  "zero-yield",
]);

function hasAnySignal(signals: readonly string[] | null | undefined, wanted: ReadonlySet<string>): boolean {
  return signals?.some((signal) => wanted.has(signal)) ?? false;
}

export function classifyYieldSourcePosture(params: {
  sourceRisk?: YieldSourceRisk | null;
  sourceTvlUsd?: number | null;
  sourceDepthLens?: YieldSourceDepthLens | null;
  sourceChanged?: boolean;
  sourceFreshness?: YieldSourcePublishedFreshness | null;
  warningSignals?: readonly string[] | null;
}): YieldSourcePosture {
  const sourceRisk = params.sourceRisk ?? null;
  const warningSignals = params.warningSignals ?? [];
  const sourceDepthLens = params.sourceDepthLens ?? classifyYieldSourceDepth({
    sourceRisk,
    sourceTvlUsd: params.sourceTvlUsd,
  });
  const sourceRiskPenalty = finiteNumber(sourceRisk?.sourceRiskPenalty) ?? 1;
  const sourceSwitchCount30d = finiteNumber(sourceRisk?.sourceSwitchCount30d);
  const sourceChanged = params.sourceChanged === true || (sourceSwitchCount30d !== null && sourceSwitchCount30d > 0);
  const drivers = getYieldSourceRiskDrivers({
    sourceRisk,
    sourceChanged,
    sourceFreshness: params.sourceFreshness,
    warningSignals,
  });
  const driverKeys = new Set(drivers.map((driver) => driver.key));
  const hasSevereDriver =
    driverKeys.has("high-risk-venue") ||
    driverKeys.has("reward-heavy") ||
    driverKeys.has("thin-source-depth") ||
    driverKeys.has("stale-source") ||
    sourceRisk?.dependencyConcentration?.severity === "high";
  const hasMaterialPenalty = sourceRiskPenalty >= SPECULATIVE_SOURCE_RISK_PENALTY_MIN;
  const hasMultipleDrivers = drivers.length >= 2;

  if (hasSevereDriver || sourceDepthLens === "thin" || hasMaterialPenalty || hasMultipleDrivers) {
    return "speculative";
  }

  const hasWatchDriver =
    driverKeys.has("elevated-risk-venue") ||
    driverKeys.has("concentrated-dependency") ||
    driverKeys.has("limited-history") ||
    driverKeys.has("source-changed");
  const hasEvidenceDebt = sourceDepthLens === "unknown";
  const hasUnknownVenueDebt = sourceRisk?.venueRiskTier === "unknown";
  const hasWatchWarning = hasAnySignal(warningSignals, SOURCE_POSTURE_WATCH_WARNING_SIGNALS);

  if (
    hasWatchDriver ||
    hasEvidenceDebt ||
    hasUnknownVenueDebt ||
    hasWatchWarning ||
    sourceRiskPenalty > CLEAN_SOURCE_RISK_PENALTY_MAX
  ) {
    return "watch";
  }

  return "clean";
}

export function formatYieldSourcePosture(posture: YieldSourcePosture): string {
  return YIELD_SOURCE_POSTURE_DEFINITIONS[posture].label;
}

function isYieldSourceRiskMaterial(sourceRisk: YieldSourceRisk | null | undefined): boolean {
  const sourceRiskPenalty = finiteNumber(sourceRisk?.sourceRiskPenalty);
  const sourceRiskScore = finiteNumber(sourceRisk?.sourceRiskScore);
  if (sourceRiskPenalty !== null) return sourceRiskPenalty > 1.05;
  return sourceRiskScore !== null && sourceRiskScore >= 10;
}

export function formatYieldSourceRiskSummary(sourceRisk: YieldSourceRisk | null | undefined): string | null {
  if (!isYieldSourceRiskMaterial(sourceRisk)) return null;

  return `Source risk ${formatYieldSourceRiskCompact(sourceRisk)}`;
}

export function formatYieldSourceRiskCompact(sourceRisk: YieldSourceRisk | null | undefined): string {
  const sourceRiskPenalty = finiteNumber(sourceRisk?.sourceRiskPenalty) ?? 1;
  const sourceRiskScore = finiteNumber(sourceRisk?.sourceRiskScore);
  const scoreLabel = sourceRiskScore !== null ? `${Math.round(sourceRiskScore)}/100` : "n/a";
  const penaltyLabel = `${sourceRiskPenalty.toFixed(2)}x`;
  return `${scoreLabel} | ${penaltyLabel}`;
}

export function formatYieldSourceRiskDriverSummary(drivers: readonly YieldSourceRiskDriver[]): string {
  if (drivers.length === 0) {
    return "No populated source-risk driver is currently reducing this row beyond the neutral source penalty.";
  }
  return drivers.map((driver) => `${driver.label}: ${driver.description}`).join(" ");
}

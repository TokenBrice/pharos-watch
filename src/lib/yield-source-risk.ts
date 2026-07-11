import { formatRelativeAgeSeconds } from "@shared/lib/relative-time";
import { numberValue as finiteNumber } from "@shared/lib/type-guards";
import type { YieldRanking, YieldRankChangeAttribution, YieldSourceRisk } from "@shared/types";

export type YieldSourceConfidenceTier = NonNullable<YieldRanking["provenance"]>["confidenceTier"];
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
    description: "Non-thin, fresh source with no material source-risk penalty or source-change evidence.",
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

export function getYieldSourceRiskDrivers(params: {
  sourceRisk?: YieldSourceRisk | null;
  sourceChanged?: boolean;
  warningSignals?: readonly string[] | null;
}): YieldSourceRiskDriver[] {
  const sourceRisk = params.sourceRisk ?? null;
  const warningSignals = params.warningSignals ?? [];
  if (!sourceRisk && !params.sourceChanged && warningSignals.length === 0) return [];

  const rewardShare = finiteNumber(sourceRisk?.rewardShare);
  const sourceDepthRatio = finiteNumber(sourceRisk?.sourceDepthRatio);
  const sourceAgeSeconds = finiteNumber(sourceRisk?.sourceAgeSeconds);
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

  if (sourceAgeSeconds !== null && sourceAgeSeconds > 6 * 60 * 60) {
    drivers.push({
      key: "stale-source",
      label: "stale source",
      description: "Latest source observation is older than expected for its family.",
    });
  }

  if (warningSignals.includes("data-stale") && !hasDriver("stale-source")) {
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
  const drivers = getYieldSourceRiskDrivers({ sourceRisk, sourceChanged, warningSignals });
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

// Confidence tier styles — one consistent visual language per tier.
// emerald = deterministic, sky = curated, amber = discovered, slate = fallback.
export interface YieldSourceConfidenceStyle {
  pill: string;
  dot: string;
  text: string;
}

export const YIELD_SOURCE_CONFIDENCE_STYLES: Record<YieldSourceConfidenceTier, YieldSourceConfidenceStyle> = {
  deterministic: {
    pill: "inline-flex items-center rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400",
    dot: "inline-block size-1.5 rounded-full bg-emerald-500",
    text: "text-emerald-700 dark:text-emerald-400",
  },
  curated: {
    pill: "inline-flex items-center rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-400",
    dot: "inline-block size-1.5 rounded-full bg-sky-500",
    text: "text-sky-700 dark:text-sky-400",
  },
  discovered: {
    pill: "inline-flex items-center rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400",
    dot: "inline-block size-1.5 rounded-full bg-amber-500",
    text: "text-amber-700 dark:text-amber-400",
  },
  fallback: {
    pill: "inline-flex items-center rounded-full border border-slate-500/20 bg-slate-500/10 px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:text-slate-400",
    dot: "inline-block size-1.5 rounded-full bg-slate-500",
    text: "text-slate-700 dark:text-slate-400",
  },
};

export type YieldSourceFreshnessTier = "fresh" | "recent" | "aging" | "stale";

export interface YieldSourceFreshnessLabel {
  tier: YieldSourceFreshnessTier;
  relativeText: string;
  textClassName: string;
}

const YIELD_SOURCE_FRESHNESS_STYLES: Record<YieldSourceFreshnessTier, string> = {
  fresh: "text-emerald-700 dark:text-emerald-400",
  recent: "text-sky-700 dark:text-sky-400",
  aging: "text-amber-700 dark:text-amber-400",
  stale: "text-muted-foreground",
};

/** Tiers: <=6h fresh, <=12h recent, <=24h aging, >24h stale. Null sourceAgeSeconds -> null. */
export function classifyYieldSourceFreshness(
  sourceAgeSeconds: number | null | undefined,
): YieldSourceFreshnessLabel | null {
  if (sourceAgeSeconds == null) return null;
  if (typeof sourceAgeSeconds !== "number" || !Number.isFinite(sourceAgeSeconds) || sourceAgeSeconds < 0) {
    return null;
  }
  let tier: YieldSourceFreshnessTier;
  if (sourceAgeSeconds <= 6 * 60 * 60) tier = "fresh";
  else if (sourceAgeSeconds <= 12 * 60 * 60) tier = "recent";
  else if (sourceAgeSeconds <= 24 * 60 * 60) tier = "aging";
  else tier = "stale";
  return {
    tier,
    relativeText: formatRelativeAgeSeconds(sourceAgeSeconds, { maxDays: 30 }),
    textClassName: YIELD_SOURCE_FRESHNESS_STYLES[tier],
  };
}

export const YIELD_RANK_CHANGE_DRIVER_LABELS: Record<
  NonNullable<NonNullable<YieldRankChangeAttribution["primaryDriver"]>>,
  { short: string; long: string }
> = {
  apy: { short: "APY", long: "30-day APY moved" },
  benchmark: { short: "Benchmark", long: "Benchmark rate moved" },
  "stablecoin-safety": { short: "Safety", long: "Stablecoin safety re-graded" },
  "source-risk": { short: "Source risk", long: "Source-risk penalty changed" },
  "source-switch": { short: "Source switch", long: "Selected source changed" },
  freshness: { short: "Freshness", long: "Source freshness changed" },
  volatility: { short: "Volatility", long: "30-day APY volatility changed" },
  "tvl-depth": { short: "Depth", long: "Source TVL depth changed" },
};

import type { YieldRanking, YieldSourceRisk } from "@shared/types";

export type YieldSourceConfidenceTier = NonNullable<YieldRanking["provenance"]>["confidenceTier"];
export type YieldSourceDepthLens = "deep" | "moderate" | "thin" | "unknown";

export interface YieldSourceRiskDriver {
  key: "reward-heavy" | "thin-source-depth" | "stale-source" | "limited-history" | "source-changed";
  label: string;
  description: string;
}

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

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

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
}): YieldSourceRiskDriver[] {
  const sourceRisk = params.sourceRisk ?? null;
  if (!sourceRisk && !params.sourceChanged) return [];

  const rewardShare = finiteNumber(sourceRisk?.rewardShare);
  const sourceDepthRatio = finiteNumber(sourceRisk?.sourceDepthRatio);
  const sourceAgeSeconds = finiteNumber(sourceRisk?.sourceAgeSeconds);
  const observationCount30d = finiteNumber(sourceRisk?.observationCount30d);
  const sourceSwitchCount30d = finiteNumber(sourceRisk?.sourceSwitchCount30d);
  const drivers: YieldSourceRiskDriver[] = [];

  if (rewardShare !== null && rewardShare > 0.5) {
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

  if (sourceAgeSeconds !== null && sourceAgeSeconds > 6 * 60 * 60) {
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
      description: "Observation count is too low for mature confidence.",
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

export function formatYieldSourceRiskDriverSummary(drivers: readonly YieldSourceRiskDriver[]): string {
  if (drivers.length === 0) {
    return "No populated source-risk driver is currently reducing this row beyond the neutral source penalty.";
  }
  return drivers.map((driver) => `${driver.label}: ${driver.description}`).join(" ");
}

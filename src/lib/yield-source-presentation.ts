import { YIELD_SOURCE_CONFIDENCE_CLASSES } from "@shared/lib/classification";
import { formatRelativeAgeSeconds } from "@shared/lib/relative-time";
import type { YieldRankChangeAttribution, YieldRanking } from "@shared/types";

export type YieldSourceConfidenceTier = NonNullable<YieldRanking["provenance"]>["confidenceTier"];
export type YieldSourcePublishedFreshness = NonNullable<
  NonNullable<YieldRanking["provenance"]>["sourceFreshness"]
>;

// Confidence tier colours come from YIELD_SOURCE_CONFIDENCE_CLASSES; layout stays here.
export interface YieldSourceConfidenceStyle {
  pill: string;
  dot: string;
  text: string;
}

export const YIELD_SOURCE_CONFIDENCE_STYLES: Record<YieldSourceConfidenceTier, YieldSourceConfidenceStyle> = {
  deterministic: {
    pill: `inline-flex items-center rounded-full border px-2 py-0.5 text-2xs font-medium ${YIELD_SOURCE_CONFIDENCE_CLASSES.deterministic.pill}`,
    dot: `inline-block size-1.5 rounded-full ${YIELD_SOURCE_CONFIDENCE_CLASSES.deterministic.dot}`,
    text: YIELD_SOURCE_CONFIDENCE_CLASSES.deterministic.text,
  },
  curated: {
    pill: `inline-flex items-center rounded-full border px-2 py-0.5 text-2xs font-medium ${YIELD_SOURCE_CONFIDENCE_CLASSES.curated.pill}`,
    dot: `inline-block size-1.5 rounded-full ${YIELD_SOURCE_CONFIDENCE_CLASSES.curated.dot}`,
    text: YIELD_SOURCE_CONFIDENCE_CLASSES.curated.text,
  },
  discovered: {
    pill: `inline-flex items-center rounded-full border px-2 py-0.5 text-2xs font-medium ${YIELD_SOURCE_CONFIDENCE_CLASSES.discovered.pill}`,
    dot: `inline-block size-1.5 rounded-full ${YIELD_SOURCE_CONFIDENCE_CLASSES.discovered.dot}`,
    text: YIELD_SOURCE_CONFIDENCE_CLASSES.discovered.text,
  },
  fallback: {
    pill: `inline-flex items-center rounded-full border px-2 py-0.5 text-2xs font-medium ${YIELD_SOURCE_CONFIDENCE_CLASSES.fallback.pill}`,
    dot: `inline-block size-1.5 rounded-full ${YIELD_SOURCE_CONFIDENCE_CLASSES.fallback.dot}`,
    text: YIELD_SOURCE_CONFIDENCE_CLASSES.fallback.text,
  },
};

export type YieldSourceAgeContextBand = "within-6h" | "within-12h" | "within-24h" | "over-24h";

export interface YieldSourceAgeContext {
  band: YieldSourceAgeContextBand;
  relativeText: string;
  description: string;
}

export interface YieldSourceFreshnessDisplay {
  status: YieldSourcePublishedFreshness;
  statusLabel: string;
  displayText: string;
  ageContext: YieldSourceAgeContext | null;
  textClassName: string;
  tooltipText: string;
}

const YIELD_SOURCE_FRESHNESS_STYLES: Record<YieldSourcePublishedFreshness, string> = {
  fresh: "text-state-positive",
  stale: "text-state-warn",
  unknown: "text-muted-foreground",
};

const YIELD_SOURCE_FRESHNESS_LABELS: Record<YieldSourcePublishedFreshness, string> = {
  fresh: "Fresh",
  stale: "Stale",
  unknown: "Unknown",
};

export function classifyYieldSourceAgeContext(
  sourceAgeSeconds: number | null | undefined,
): YieldSourceAgeContext | null {
  if (sourceAgeSeconds == null) return null;
  if (typeof sourceAgeSeconds !== "number" || !Number.isFinite(sourceAgeSeconds) || sourceAgeSeconds < 0) {
    return null;
  }
  let band: YieldSourceAgeContextBand;
  let description: string;
  if (sourceAgeSeconds <= 6 * 60 * 60) {
    band = "within-6h";
    description = "observed within 6 hours";
  } else if (sourceAgeSeconds <= 12 * 60 * 60) {
    band = "within-12h";
    description = "observed within 12 hours";
  } else if (sourceAgeSeconds <= 24 * 60 * 60) {
    band = "within-24h";
    description = "observed within 24 hours";
  } else {
    band = "over-24h";
    description = "observed more than 24 hours ago";
  }
  return {
    band,
    relativeText: formatRelativeAgeSeconds(sourceAgeSeconds, { maxDays: 30 }),
    description,
  };
}

function resolveYieldSourceFreshnessStatus(
  sourceFreshness: YieldSourcePublishedFreshness | null | undefined,
  warningSignals: readonly string[] | null | undefined,
): YieldSourcePublishedFreshness {
  if (sourceFreshness) return sourceFreshness;
  return warningSignals?.includes("data-stale") ? "stale" : "unknown";
}

export function getYieldSourceFreshnessDisplay(params: {
  sourceAgeSeconds?: number | null;
  sourceFreshness?: YieldSourcePublishedFreshness | null;
  warningSignals?: readonly string[] | null;
}): YieldSourceFreshnessDisplay | null {
  const ageContext = classifyYieldSourceAgeContext(params.sourceAgeSeconds);
  const hasPublishedStatus = params.sourceFreshness != null;
  const hasStaleWarning = params.warningSignals?.includes("data-stale") ?? false;
  const hasUnknownWarning = params.warningSignals?.includes("data-freshness-unknown") ?? false;
  if (!ageContext && !hasPublishedStatus && !hasStaleWarning && !hasUnknownWarning) return null;

  const status = resolveYieldSourceFreshnessStatus(params.sourceFreshness, params.warningSignals);
  const statusLabel = YIELD_SOURCE_FRESHNESS_LABELS[status];
  const displayText = ageContext ? `${statusLabel} · ${ageContext.relativeText}` : statusLabel;
  const statusContext = hasPublishedStatus
    ? `Published source freshness: ${statusLabel}.`
    : hasStaleWarning
      ? "Source freshness: Stale (data-stale warning)."
      : "Source freshness: Unknown.";
  const ageText = ageContext
    ? ` Source observed ${ageContext.relativeText}; age context: ${ageContext.description}.`
    : " Source observation age is unavailable.";

  return {
    status,
    statusLabel,
    displayText,
    ageContext,
    textClassName: YIELD_SOURCE_FRESHNESS_STYLES[status],
    tooltipText: `${statusContext}${ageText}`,
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
  methodology: { short: "Methodology", long: "Methodology version changed between the published and served scoring" },
};

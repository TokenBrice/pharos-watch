import { YIELD_SOURCE_AGE_DISPLAY, YIELD_SOURCE_CONFIDENCE_CLASSES } from "@shared/lib/classification";
import { getYieldSourceProducerCadenceMs } from "@shared/lib/yield-source-cadence";
import { formatRelativeAgeSeconds } from "@shared/lib/relative-time";
import { deriveDataHealth, isPublicWarning } from "@/lib/data-health";
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

/**
 * Response clock the source ages were assessed against, plus the sampled
 * boundary time. `assessedAt` is the response `_meta.assessedAt` (or receipt)
 * in seconds; `nowMs` is undefined during SSR/first hydration, when the
 * assessment clock itself is the comparison instant.
 */
export interface YieldSourceDisplayClock {
  assessedAt: number | null;
  nowMs?: number;
}

/** One source's own identity and observation clock. */
export interface YieldSourceClockInput {
  dataSource?: string | null;
  sourceKey?: string | null;
  /** Original observation time (seconds), when the payload carries it. */
  sourceObservedAt?: number | null;
  /** API-aged source age (seconds) at `clock.assessedAt`. */
  sourceAgeSeconds?: number | null;
}

function validSeconds(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** Response assessment clock (seconds): `_meta.assessedAt`, else the query receipt. */
export function resolveYieldSourceAssessedAt(meta: object | null | undefined, dataUpdatedAt: number): number | null {
  const assessedAt = meta != null && "assessedAt" in meta && typeof meta.assessedAt === "number" ? meta.assessedAt : null;
  return validSeconds(assessedAt) ?? (dataUpdatedAt > 0 ? dataUpdatedAt / 1000 : null);
}

/** Assessment instant (seconds); without a response clock the ages stand as of now. */
function resolveAssessmentSec(clock: YieldSourceDisplayClock | null | undefined): number {
  return validSeconds(clock?.assessedAt) ?? (clock?.nowMs ?? Date.now()) / 1000;
}

/** Observation anchor (seconds); null when the clock is missing, invalid, or in the future. */
function getYieldSourceObservedAt(
  input: YieldSourceClockInput,
  clock: YieldSourceDisplayClock | null | undefined,
  assessedAt: number = resolveAssessmentSec(clock),
): number | null {
  let observedAt: number | null;
  if (input.sourceObservedAt != null) {
    observedAt = validSeconds(input.sourceObservedAt);
  } else {
    const age = input.sourceAgeSeconds;
    observedAt = typeof age === "number" && Number.isFinite(age) && age >= 0 ? validSeconds(assessedAt - age) : null;
  }
  return observedAt != null && observedAt <= assessedAt ? observedAt : null;
}

/**
 * Shared public-gate input for one source: its own observation anchor against
 * its producer cadence. Scoring bounds and status floors play no part.
 */
export function getYieldSourceDisplayHealthInput(
  input: YieldSourceClockInput,
  clock: YieldSourceDisplayClock | null | undefined,
  assessedAt: number = resolveAssessmentSec(clock),
) {
  const observedAt = input.dataSource ? getYieldSourceObservedAt(input, clock, assessedAt) : null;
  return {
    label: "Source",
    // A missing identity or clock stays unavailable, never zero-age evidence.
    dataUpdatedAt: observedAt != null ? observedAt * 1000 : 0,
    staleTime: getYieldSourceProducerCadenceMs(input.dataSource ?? "", input.sourceKey),
    hasData: true,
  };
}

export interface YieldSourceDisplayAge {
  status: YieldSourcePublishedFreshness;
  ageSeconds: number | null;
}

/** Reader-facing source age: `stale` only past the shared public gate (ADR-42). */
export function assessYieldSourceDisplayAge(
  input: YieldSourceClockInput,
  clock: YieldSourceDisplayClock | null | undefined,
): YieldSourceDisplayAge {
  const assessedAt = resolveAssessmentSec(clock);
  const healthInput = getYieldSourceDisplayHealthInput(input, clock, assessedAt);
  if (healthInput.dataUpdatedAt <= 0) return { status: "unknown", ageSeconds: null };
  const health = deriveDataHealth(healthInput, clock?.nowMs ?? assessedAt * 1000);
  return {
    status: isPublicWarning(health) ? "stale" : "fresh",
    ageSeconds: health.ageMs != null ? health.ageMs / 1000 : null,
  };
}

export function getYieldSourceFreshnessDisplay(
  input: YieldSourceClockInput & { clock?: YieldSourceDisplayClock | null },
): YieldSourceFreshnessDisplay | null {
  if (input.sourceKey == null && input.sourceObservedAt == null && input.sourceAgeSeconds == null) return null;
  const { status, ageSeconds } = assessYieldSourceDisplayAge(input, input.clock);
  const ageContext = status === "unknown" ? null : classifyYieldSourceAgeContext(ageSeconds);
  const display = YIELD_SOURCE_AGE_DISPLAY[ageContext ? status : "unknown"];
  const displayText = !ageContext
    ? display.label
    : status === "stale"
      ? `${display.label} · ${ageContext.relativeText}`
      : `${display.label} ${ageContext.relativeText}`;

  return {
    status: ageContext ? status : "unknown",
    statusLabel: display.label,
    displayText,
    ageContext,
    textClassName: display.text,
    tooltipText: ageContext
      ? `Source observed ${ageContext.relativeText}; age context: ${ageContext.description}.`
      : "Source observation age is unavailable.",
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

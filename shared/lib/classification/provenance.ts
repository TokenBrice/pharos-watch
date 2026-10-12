import type { LiquidityCoverageClass } from "../../types/market";
import type { YieldSourceConfidenceTier } from "../../types/yield-vocabulary";

/**
 * Data-provenance tiers: emerald = first-party/deterministic, sky = curated or
 * secondary, amber = discovered/fallback, violet/cyan = derived. Pills use the
 * `SAFETY_EVIDENCE_BADGE_CLASSES` spelling (`/30 · /10 · 700/300`); an
 * unavailable or fallback tier is muted, because unavailable is not a hue.
 */

const PROVENANCE_MUTED_PILL = "border-border/60 bg-muted/30 text-muted-foreground";

/** Colour only: the pill's layout (padding, radius, size) stays at the call site. */
export const YIELD_SOURCE_CONFIDENCE_CLASSES = {
  deterministic: {
    pill: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
    text: "text-emerald-700 dark:text-emerald-400",
  },
  curated: {
    pill: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    dot: "bg-sky-500",
    text: "text-sky-700 dark:text-sky-400",
  },
  discovered: {
    pill: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
    text: "text-amber-700 dark:text-amber-400",
  },
  fallback: {
    pill: PROVENANCE_MUTED_PILL,
    dot: "bg-muted-foreground",
    text: "text-muted-foreground",
  },
} as const satisfies Record<YieldSourceConfidenceTier, { pill: string; dot: string; text: string }>;

/** Faded `/40` fills for the yield source board quality strips. */
export const YIELD_SOURCE_QUALITY_FILL_CLASSES = {
  deterministic: "bg-emerald-500/40",
  curated: "bg-sky-500/40",
  discovered: "bg-amber-500/40",
  fallback: "bg-muted-foreground/40",
} as const satisfies Record<YieldSourceConfidenceTier, string>;

export const YIELD_SOURCE_DEPTH_FILL_CLASSES = {
  deep: "bg-emerald-500/40",
  moderate: "bg-sky-500/40",
  thin: "bg-amber-500/40",
  unknown: "bg-muted/40",
} as const;

export const YIELD_DATA_SOURCE_BADGE_CLASSES = {
  onchain: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  defillama: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  "defillama-auto": "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  "protocol-api": "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
  "price-derived": "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  "rate-derived": "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
} as const;

export const LIQUIDITY_COVERAGE_BADGE_CLASSES = {
  primary: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  mixed: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  fallback: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  legacy: PROVENANCE_MUTED_PILL,
  unobserved: "border-border/70 bg-muted text-muted-foreground",
} as const satisfies Record<LiquidityCoverageClass, string>;

/** Price-transparency source chips: the source used for the price against other available feeds. */
export const PRICE_SOURCE_STATUS_CLASSES = {
  used: {
    wrap: "border-emerald-500/20 bg-emerald-500/[0.03]",
    badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  available: {
    badge: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    dot: "bg-sky-500",
  },
} as const;

export const REQUEST_SOURCE_FILL_CLASSES = {
  primary: "bg-sky-500/70",
  secondary: "bg-amber-500/70",
} as const;

/** Safety-score data-coverage rail: one swatch per gap owner. */
export const COVERAGE_GAP_OWNER_SWATCH_CLASSES = {
  "issuer-undisclosed": "bg-amber-500",
  "integration-missing": "bg-frost-blue",
  "producer-failed": "bg-rose-500",
  "method-unsupported": "bg-muted-foreground",
  "published-evidence-expired": "bg-sky-500",
} as const;

/** Yield change attribution callout: organic move, source switch, or both. */
export const YIELD_ATTRIBUTION_TONE_CLASSES = {
  organic: { wrapper: "border-emerald-500/25 bg-emerald-500/5", kicker: "text-emerald-700 dark:text-emerald-400" },
  "source-switch": { wrapper: "border-sky-500/25 bg-sky-500/5", kicker: "text-sky-700 dark:text-sky-300" },
  mixed: { wrapper: "border-amber-500/25 bg-amber-500/5", kicker: "text-amber-700 dark:text-amber-300" },
  "insufficient-data": { wrapper: "border-border/60 bg-muted/20", kicker: "text-muted-foreground" },
} as const;

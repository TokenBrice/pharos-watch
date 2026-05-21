/**
 * URL state schema for `/yield/`.
 *
 * Mirrors `YieldViewModelUrlParams` from `src/lib/yield-view-model.ts` — the
 * canonical contract for shareable yield-leaderboard views.
 *
 * Most fields use `kind: "string"` rather than `enum` because the yield page's
 * valid option set is data-derived (peg options reflect the active row set,
 * benchmarks reflect the registry returned by the API). The view-model does
 * the heavy normalization in `normalizeFilters` and reports
 * `invalidParamKeys` so the client can rewrite the URL after hydration.
 *
 * For static enums (`warnings`, `opportunity`, `depth`, `sourceChanged`,
 * `trending`, `watchlist`) we declare the closed allowed-values set so the
 * schema rejects garbage at decode time.
 */
import type { UrlStateSchema } from "@/lib/url-state";

export type YieldWarningsValue = "all" | "hide" | "only";
export type YieldOpportunityValue = "all" | "holder-yield" | "lending-opportunity";
export type YieldDepthValue = "all" | "deep" | "moderate" | "thin" | "unknown" | "hide-thin";
export type YieldSourceChangedValue = "all" | "only" | "none";
export type YieldTrendingValue = "all" | "rising";
export type YieldWatchlistValue = "all" | "only";

export const YIELD_WARNINGS_VALUES = ["all", "hide", "only"] as const satisfies readonly YieldWarningsValue[];
export const YIELD_OPPORTUNITY_VALUES = [
  "all",
  "holder-yield",
  "lending-opportunity",
] as const satisfies readonly YieldOpportunityValue[];
export const YIELD_DEPTH_VALUES = [
  "all",
  "deep",
  "moderate",
  "thin",
  "unknown",
  "hide-thin",
] as const satisfies readonly YieldDepthValue[];
export const YIELD_SOURCE_CHANGED_VALUES = [
  "all",
  "only",
  "none",
] as const satisfies readonly YieldSourceChangedValue[];
export const YIELD_TRENDING_VALUES = ["all", "rising"] as const satisfies readonly YieldTrendingValue[];
export const YIELD_WATCHLIST_VALUES = ["all", "only"] as const satisfies readonly YieldWatchlistValue[];

export interface YieldUrlValues {
  /** Peg currency or aggregate bucket (`USD`, `EUR`, `non-usd`, `aud-cad`, `other`, `all`). Data-derived. */
  peg: string;
  /** Yield type filter (`all`, `rate-derived`, `nav`, etc.). Data-derived. */
  yieldType: string;
  /** Free-text search query. */
  q: string;
  warnings: YieldWarningsValue;
  /** Minimum safety score floor (0 = no filter). Encoded as integer 0–100. */
  minSafety: number;
  /** Minimum TVL floor in USD (0 = no filter). */
  minTvl: number;
  /** Source confidence tier (`all`, `deterministic`, `curated`, `discovered`, `fallback`). */
  sourceConfidence: string;
  /** Benchmark currency key (`all` or one of the registry-provided keys). */
  benchmark: string;
  opportunity: YieldOpportunityValue;
  depth: YieldDepthValue;
  sourceChanged: YieldSourceChangedValue;
  trending: YieldTrendingValue;
  watchlist: YieldWatchlistValue;
}

export const YIELD_URL_SCHEMA: UrlStateSchema<YieldUrlValues> = {
  peg: { kind: "string", defaultValue: "all" },
  yieldType: { kind: "string", defaultValue: "all" },
  q: { kind: "string", defaultValue: "" },
  warnings: {
    kind: "enum",
    defaultValue: "all",
    allowedValues: YIELD_WARNINGS_VALUES,
  },
  minSafety: {
    kind: "boundedNumber",
    defaultValue: 0,
    min: 0,
    max: 100,
    integer: true,
  },
  minTvl: {
    kind: "boundedNumber",
    defaultValue: 0,
    min: 0,
  },
  sourceConfidence: { kind: "string", defaultValue: "all" },
  benchmark: { kind: "string", defaultValue: "all" },
  opportunity: {
    kind: "enum",
    defaultValue: "all",
    allowedValues: YIELD_OPPORTUNITY_VALUES,
  },
  depth: {
    kind: "enum",
    defaultValue: "all",
    allowedValues: YIELD_DEPTH_VALUES,
  },
  sourceChanged: {
    kind: "enum",
    defaultValue: "all",
    allowedValues: YIELD_SOURCE_CHANGED_VALUES,
  },
  trending: {
    kind: "enum",
    defaultValue: "all",
    allowedValues: YIELD_TRENDING_VALUES,
  },
  watchlist: {
    kind: "enum",
    defaultValue: "all",
    allowedValues: YIELD_WATCHLIST_VALUES,
  },
};

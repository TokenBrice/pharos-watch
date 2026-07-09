import { PEG_BADGE_STYLES } from "@shared/lib/classification";
import { YIELD_BENCHMARK_KEY_VALUES } from "@shared/types/yield";
import { type PegCurrency, type YieldBenchmarkKey, type YieldType } from "@shared/types";
import type { YieldSourceDepthLens, YieldSourcePosture } from "@/lib/yield-source-risk";

export type YieldSourceConfidenceFilter =
  | "all"
  | "deterministic"
  | "curated"
  | "discovered"
  | "fallback";
export type YieldPresetKey =
  | "treasury-grade"
  | "best-dollar"
  | "non-usd"
  | "new-rising"
  | "watchlist-warnings";
export type YieldRiskBudgetKey =
  | "conservative"
  | "balanced"
  | "opportunistic"
  | "all";
export type YieldPegFilter = PegCurrency | "all" | "non-usd" | "aud-cad" | "other";
export type YieldWarningsFilter = "all" | "hide" | "only";
export type YieldBenchmarkFilter = "all" | YieldBenchmarkKey;
export type YieldOpportunityFilter = "all" | "holder-yield" | "lending-opportunity";
export type YieldDepthFilter = "all" | YieldSourceDepthLens | "hide-thin";
export type YieldSourceChangedFilter = "all" | "only" | "none";
export type YieldSourcePostureFilter = "all" | YieldSourcePosture | "watch-only";
export type YieldTrendingFilter = "all" | "rising";
export type YieldWatchlistFilter = "all" | "only";
export type YieldAttentionFilter = "all" | "watchlist";

export interface YieldViewModelUrlParams {
  peg?: string | null;
  yieldType?: string | null;
  q?: string | null;
  warnings?: string | null;
  minSafety?: string | null;
  minTvl?: string | null;
  sourceConfidence?: string | null;
  benchmark?: string | null;
  opportunity?: string | null;
  depth?: string | null;
  sourceChanged?: string | null;
  sourcePosture?: string | null;
  trending?: string | null;
  watchlist?: string | null;
  attention?: string | null;
}

export interface YieldFilterOption<T extends string = string> {
  value: T;
  label: string;
  count: number;
}

export interface YieldViewModelFilters {
  peg: YieldPegFilter;
  yieldType: YieldType | "all";
  q: string;
  warnings: YieldWarningsFilter;
  minSafety: number | null;
  minTvl: number | null;
  sourceConfidence: YieldSourceConfidenceFilter;
  benchmark: YieldBenchmarkFilter;
  opportunity: YieldOpportunityFilter;
  depth: YieldDepthFilter;
  sourceChanged: YieldSourceChangedFilter;
  sourcePosture: YieldSourcePostureFilter;
  trending: YieldTrendingFilter;
  watchlist: YieldWatchlistFilter;
  attention: YieldAttentionFilter;
}

// Priority order for the "other" peg bucket sort. USD is excluded because it is
// surfaced first/separately via buildPegOptions. SGD and MXN are excluded because
// they are hidden individual pegs (HIDDEN_INDIVIDUAL_YIELD_PEG_FILTERS). Any peg
// absent from this list falls back to alphabetical label order in compareYieldPegs.
const YIELD_PEG_PRIORITY: readonly PegCurrency[] = [
  "EUR",
  "CHF",
  "GOLD",
  "GBP",
  "JPY",
  "AUD",
  "CAD",
  "BRL",
  "ZAR",
  "CNH",
  "CNY",
  "PHP",
  "TRY",
  "IDR",
  "RUB",
  "UAH",
  "ARS",
  "SILVER",
  "VAR",
  "OTHER",
];

export const HIDDEN_INDIVIDUAL_YIELD_PEG_FILTERS = new Set<PegCurrency>(["SGD", "MXN"]);
// Currencies that get their own tab in the leaderboard currency tab strip.
// Anything not in this set rolls into the "Other" tab. AUD + CAD share a tab.
export const CURRENCY_TAB_PEGS: readonly PegCurrency[] = ["USD", "EUR", "GBP", "JPY", "CHF", "MXN", "BRL"];
export const CURRENCY_TAB_AUD_CAD_PEGS: readonly PegCurrency[] = ["AUD", "CAD"];
export const CURRENCY_TAB_ENUMERATED_PEGS = new Set<PegCurrency>([
  ...CURRENCY_TAB_PEGS,
  ...CURRENCY_TAB_AUD_CAD_PEGS,
]);
export const SOURCE_CONFIDENCE_ORDER: readonly Exclude<YieldSourceConfidenceFilter, "all">[] = [
  "deterministic",
  "curated",
  "discovered",
  "fallback",
];
export const BENCHMARK_ORDER: readonly YieldBenchmarkKey[] = YIELD_BENCHMARK_KEY_VALUES;
export const MIN_SAFETY_OPTIONS = [50, 60, 70, 80] as const;
export const MIN_TVL_OPTIONS = [1_000_000, 10_000_000, 100_000_000] as const;
export const EXTERNAL_OPPORTUNITY_YIELD_TYPES = new Set<YieldType>([
  "lending-opportunity",
  "fixed-yield",
  "structured-tranche",
]);

export const DEFAULT_FILTERS: YieldViewModelFilters = {
  peg: "all",
  yieldType: "all",
  q: "",
  warnings: "all",
  minSafety: null,
  minTvl: null,
  sourceConfidence: "all",
  benchmark: "all",
  opportunity: "all",
  depth: "all",
  sourceChanged: "all",
  sourcePosture: "all",
  trending: "all",
  watchlist: "all",
  attention: "all",
};

export interface YieldPresetSpec {
  key: YieldPresetKey;
  label: string;
  description: string;
  overrides: Partial<YieldViewModelFilters>;
}

// Treasury-grade approximates "rate-derived, NAV, lending vaults, lending opportunities"
// via safety+depth+confidence instead of multi-value yieldType (which is single-select).
// Best-dollar approximates ">5% APY" via PYS ranking + safety floor; the leaderboard
// is already sorted by PYS which correlates with APY for safe rows.
export interface YieldRiskBudgetSpec {
  key: YieldRiskBudgetKey;
  label: string;
  description: string;
  overrides: Partial<YieldViewModelFilters>;
}

// Single source of truth for the per-budget safety floors. Consumed by the
// SPECS below and by the scatter-plot legend so the thresholds cannot drift.
export const YIELD_RISK_BUDGET_MIN_SAFETY = {
  conservative: 80,
  balanced: 70,
  opportunistic: 50,
} as const;

// Risk budget collapses safety/depth/source-confidence/warnings into a single
// conservative→all dimension. Stops are stackable on top of other
// filters via merge semantics in `handleApplyRiskBudget`.
export const YIELD_RISK_BUDGET_SPECS: readonly YieldRiskBudgetSpec[] = [
  {
    key: "conservative",
    label: "Conservative",
    description: "A- safety, clean sources, hide thin venues, hide warnings",
    overrides: {
      minSafety: YIELD_RISK_BUDGET_MIN_SAFETY.conservative,
      depth: "hide-thin",
      sourcePosture: "clean",
      warnings: "hide",
    },
  },
  {
    key: "balanced",
    label: "Balanced",
    description: "B- safety, clean/watch sources, hide thin venues, hide warnings",
    overrides: {
      minSafety: YIELD_RISK_BUDGET_MIN_SAFETY.balanced,
      depth: "hide-thin",
      sourcePosture: "watch",
      warnings: "hide",
    },
  },
  {
    key: "opportunistic",
    label: "Opportunistic",
    description: "C+ safety, all source postures, hide warnings",
    overrides: {
      minSafety: YIELD_RISK_BUDGET_MIN_SAFETY.opportunistic,
      warnings: "hide",
    },
  },
  {
    key: "all",
    label: "All",
    description: "No constraints — show all rows",
    overrides: {},
  },
];

export const YIELD_PRESET_SPECS: readonly YieldPresetSpec[] = [
  {
    key: "treasury-grade",
    label: "Treasury-grade picks",
    description: "A- safety, non-thin depth, deterministic source",
    overrides: { minSafety: 80, depth: "hide-thin", sourceConfidence: "deterministic" },
  },
  {
    key: "best-dollar",
    label: "Best dollar yields",
    description: "USD-pegged, A- safety, ranked by PYS",
    overrides: { peg: "USD", minSafety: 80 },
  },
  {
    key: "non-usd",
    label: "Non-USD opportunities",
    description: "EUR, GBP, JPY, MXN, BRL and other non-USD pegs",
    overrides: { peg: "non-usd" },
  },
  {
    key: "new-rising",
    label: "New & rising",
    description: "Current APY above 30d average, 7+ daily observations",
    overrides: { trending: "rising" },
  },
  {
    key: "watchlist-warnings",
    label: "Watching needs attention",
    description: "Starred rows with warnings or source changes",
    overrides: { attention: "watchlist" },
  },
];

export function getYieldPegLabel(peg: PegCurrency): string {
  return PEG_BADGE_STYLES[peg].label.replace(/\s+Peg$/, "");
}

export function compareYieldPegs(a: PegCurrency, b: PegCurrency): number {
  const aIndex = YIELD_PEG_PRIORITY.indexOf(a);
  const bIndex = YIELD_PEG_PRIORITY.indexOf(b);

  if (aIndex !== -1 || bIndex !== -1) {
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    return aIndex - bIndex;
  }

  return getYieldPegLabel(a).localeCompare(getYieldPegLabel(b));
}

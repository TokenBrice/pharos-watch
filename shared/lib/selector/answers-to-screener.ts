/**
 * Translate selector answers into a Screener filter slice.
 *
 * Returns a partial `ScreenerFilters` plus the divergence warnings for
 * constraints the Screener cannot express (e.g. yield warning signals).
 *
 * Binding: `agents/impl-plan-drafts/02-engine.md` §11.
 */
import type { ReportCardGrade } from "../../types";
import {
  tradingPegScoreFloor,
  treasuryPegScoreFloor,
  yieldPegScoreFloor,
} from "./exclusions";
import type {
  ScreenerDivergenceWarning,
  SelectorInput,
  SelectorScreenerHandoff,
} from "./types";

/**
 * Subset of `ScreenerFilters` (defined in
 * `src/app/screener/screener-filters.ts`) that the handoff populates.
 * We mirror the shape locally to avoid a cross-boundary import that the
 * shared/lib/* lint rule blocks.
 */
type ScreenerFilters = Record<string, unknown>;

const SAFETY_GRADES_TREASURY: ReportCardGrade[] = [
  "A+",
  "A",
  "A-",
  "B+",
  "B",
  "B-",
  "C+",
];

const SAFETY_GRADES_YIELD_TRADING: ReportCardGrade[] = [
  "A+",
  "A",
  "A-",
  "B+",
  "B",
  "B-",
  "C+",
  "C",
  "C-",
];

export function selectorAnswersToScreenerFilters(
  input: SelectorInput,
): SelectorScreenerHandoff {
  const filters: Partial<ScreenerFilters> = {};
  const divergenceWarnings: ScreenerDivergenceWarning[] = [];

  // 1. Profile-level base filter.
  if (input.profile === "treasury") {
    filters.safetyGrades = SAFETY_GRADES_TREASURY;
  } else {
    filters.safetyGrades = SAFETY_GRADES_YIELD_TRADING;
  }
  filters.lifecycle = ["active"];
  filters.pegs = [input.pegCurrency];

  // 2. Per-profile deltas.
  switch (input.profile) {
    case "treasury": {
      applyTreasuryDeltas(input, filters);
      break;
    }
    case "yield": {
      applyYieldDeltas(input, filters, divergenceWarnings);
      break;
    }
    case "trading": {
      applyTradingDeltas(input, filters);
      break;
    }
  }

  // The peg floors come from the engine's pegScore-calibrated helpers, but the
  // Screener filters on `safetyPegStabilityScore` (a different sub-dimension).
  // The numeric floor now matches the engine, but the score it's compared
  // against diverges — surface that so the handoff banner can flag it.
  divergenceWarnings.push({
    kind: "screener-cannot-express",
    reason: "peg-score-field-divergence",
    affectedIds: [],
  });

  return { filters, divergenceWarnings };
}

function applyTreasuryDeltas(
  input: SelectorInput,
  filters: Partial<ScreenerFilters>,
): void {
  filters.safetyPegStabilityMin = treasuryPegScoreFloor(input.depegTolerance);
  filters.safetyResilienceMin = 50;
  filters.safetyDependencyRiskMin = input.horizon === "6mplus" ? 65 : 50;
  filters.dewsMax = 60;
  if (input.decentralization === "required") {
    filters.types = ["decentralized"];
    filters.blacklistable = ["no"];
  }
  if (input.custodyOk === "onchain-only") {
    filters.mechanisms = ["cdp", "algorithmic"];
  }
}

function applyYieldDeltas(
  input: SelectorInput,
  filters: Partial<ScreenerFilters>,
  divergenceWarnings: ScreenerDivergenceWarning[],
): void {
  filters.safetyPegStabilityMin = yieldPegScoreFloor(input.depegTolerance);
  if (input.yieldNativeOnly) {
    filters.mechanisms = ["fiat-cash"];
  }
  if (input.minApy != null) {
    divergenceWarnings.push({
      kind: "screener-cannot-express",
      reason: "minApy",
      affectedIds: [],
    });
  }
  // Yield-specific warning signals (`venueRiskTier`, `warningSignals`,
  // `yieldVariance`, `apy30d`, `pharosYieldScore`) cannot be filtered in the
  // Screener. Surface a divergence warning so the frontend banner appears.
  divergenceWarnings.push({
    kind: "screener-cannot-express",
    reason: "yield-warning-signals",
    affectedIds: [],
  });
}

function applyTradingDeltas(
  input: SelectorInput,
  filters: Partial<ScreenerFilters>,
): void {
  filters.safetyPegStabilityMin = tradingPegScoreFloor(input.depegTolerance);
  filters.safetyLiquidityMin = input.exitSpeed === "1h" ? 65 : 50;
  if (input.exitSpeed === "1h") {
    filters.dewsMax = 35;
  } else if (input.exitSpeed === "24h") {
    filters.dewsMax = 45;
  } else {
    filters.dewsMax = 55;
  }
}

/**
 * Build a Screener URL for the given input. Caller composes the search params
 * via the existing URL codec; this helper only stringifies the filter keys.
 */
export function buildScreenerUrl(
  input: SelectorInput,
  baseUrl: string,
): { url: string; divergenceWarnings: ScreenerDivergenceWarning[] } {
  const { filters, divergenceWarnings } = selectorAnswersToScreenerFilters(input);
  const params: string[] = [];
  for (const [key, value] of Object.entries(filters)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      params.push(`${encodeURIComponent(key)}=${encodeURIComponent(value.join(","))}`);
    } else {
      params.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  const search = params.length > 0 ? `?${params.join("&")}` : "";
  return { url: `${baseUrl}${search}`, divergenceWarnings };
}

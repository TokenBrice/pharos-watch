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
  tradingDewsCeiling,
  tradingPegScoreFloor,
  treasuryPegScoreFloor,
  yieldPegScoreFloor,
} from "./exclusions";
import type {
  ScreenerDivergenceWarning,
  SelectorInput,
  SelectorScreenerFilterProjection,
  SelectorScreenerHandoff,
} from "./types";

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
  coinIds: readonly string[] = [],
): SelectorScreenerHandoff {
  const filters: SelectorScreenerFilterProjection = {};
  const divergenceWarnings: ScreenerDivergenceWarning[] = [];

  // 1. Profile-level base filter.
  if (input.profile === "treasury") {
    filters.safetyGrades = SAFETY_GRADES_TREASURY;
  } else {
    filters.safetyGrades = SAFETY_GRADES_YIELD_TRADING;
  }
  filters.lifecycle = ["active"];
  filters.pegs = [input.pegCurrency];
  filters.supplyMin = 5_000_000;
  if (coinIds.length > 0) {
    filters.coins = Array.from(new Set(coinIds)).slice(0, 8);
  }

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
      applyTradingDeltas(input, filters, divergenceWarnings);
      break;
    }
  }

  if (input.profile === "treasury") {
    divergenceWarnings.push({
      kind: "screener-cannot-express",
      reason: "bluechip-grade-floor",
      affectedIds: [],
    });
  }
  if (input.decentralization === "required") {
    divergenceWarnings.push({
      kind: "screener-cannot-express",
      reason: "inherited-blacklist-status",
      affectedIds: [],
    });
  }

  divergenceWarnings.push({
    kind: "screener-cannot-express",
    reason: "active-depeg-gate",
    affectedIds: [...coinIds],
  });
  divergenceWarnings.push({
    kind: "screener-cannot-express",
    reason: "howey-uncertain-exclusion",
    affectedIds: [],
  });

  return { filters, divergenceWarnings };
}

function applyTreasuryDeltas(
  input: SelectorInput,
  filters: SelectorScreenerFilterProjection,
): void {
  filters.pegScoreMin = treasuryPegScoreFloor(input.depegTolerance);
  filters.safetyBackingMin = 50;
  filters.dewsMax = 60;
  if (input.decentralization === "required") {
    filters.types = ["centralized-dependent", "decentralized"];
    filters.blacklistable = ["no", "possible"];
  }
  applyCustodyFilter(input, filters);
}

function applyYieldDeltas(
  input: SelectorInput,
  filters: SelectorScreenerFilterProjection,
  divergenceWarnings: ScreenerDivergenceWarning[],
): void {
  filters.pegScoreMin = yieldPegScoreFloor(input.depegTolerance);
  if (input.yieldNativeOnly) {
    divergenceWarnings.push({
      kind: "screener-cannot-express",
      reason: "yield-native-only",
      affectedIds: [],
    });
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
  applyCustodyFilter(input, filters);
}

function applyTradingDeltas(
  input: SelectorInput,
  filters: SelectorScreenerFilterProjection,
  divergenceWarnings: ScreenerDivergenceWarning[],
): void {
  filters.pegScoreMin = tradingPegScoreFloor(input.depegTolerance);
  filters.liquidityScoreMin = input.exitSpeed === "1h" ? 65 : 50;
  if (input.exitSpeed === "24h") filters.safetyExitMin = 50;
  filters.dewsMax = tradingDewsCeiling(input.exitSpeed);
  if (input.exitSpeed === "1h") {
    divergenceWarnings.push({
      kind: "screener-cannot-express",
      reason: "effective-tvl-floor-1h",
      affectedIds: [],
    });
  }
  applyCustodyFilter(input, filters);
}

function applyCustodyFilter(
  input: SelectorInput,
  filters: SelectorScreenerFilterProjection,
): void {
  if (input.custodyOk === "onchain-only") {
    filters.custodyModels = ["onchain"];
  } else if (input.custodyOk === "regulated-only") {
    filters.custodyModels = ["institutional-top", "institutional-regulated"];
  }
}

/**
 * Build a Screener URL for the given input. Caller composes the search params
 * via the existing URL codec; this helper only stringifies the filter keys.
 */
export function buildScreenerUrl(
  input: SelectorInput,
  baseUrl: string,
  coinIds: readonly string[] = [],
): { url: string; divergenceWarnings: ScreenerDivergenceWarning[] } {
  const { filters, divergenceWarnings } = selectorAnswersToScreenerFilters(input, coinIds);
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

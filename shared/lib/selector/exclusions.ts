/**
 * Hard-exclusion rules and coverage check.
 *
 * Composition order: universal → profile-specific → input-driven.
 * First hit wins; coverage-too-thin is tracked separately so the engine can
 * distinguish "rule failed" from "we don't know".
 *
 * Binding: `agents/selector-design.md` §3.3, `agents/screener-selector/02-data-engine.md` §2.
 */
import type {
  ExclusionRecord,
  ExclusionReason,
  MergedRow,
  SelectorDepegTolerance,
  SelectorExitSpeed,
  SelectorInput,
  SelectorProfile,
} from "./types";

/**
 * Curated list of yield-bearing wrappers whose security status under U.S.
 * Howey precedent is currently contested. Pre-excluded from the Selector's
 * eligible universe per R2 Compliance P0; the rest of Pharos still tracks
 * and rates them. Yield profile's `recommendedSource` may still route
 * through these wrappers as the underlying rail.
 *
 * IDs verified against `shared/data/stablecoins/canonical-order.json`:
 *   - susde-ethena (Ethena sUSDe)
 *   - susds-sky    (Sky sUSDS)
 *   - sfrxusd-frax (Frax sfrxUSD — formerly sfrxETH/sFRAX rebrand)
 *   - sdai-sky     (Sky sDAI)
 */
export const HOWEY_UNCERTAIN_ASSETS: ReadonlySet<string> = new Set([
  "susde-ethena",
  "susds-sky",
  "sfrxusd-frax",
  "sdai-sky",
]);

// ---------------------------------------------------------------------------
// Threshold helpers
// ---------------------------------------------------------------------------

/** R1 Skeptic P3.8 / Compliance P2 — active-depeg threshold scales with tolerance. */
export function activeDepegThresholdBps(tol: SelectorDepegTolerance): number {
  switch (tol) {
    case "zero":
      return 50;
    case "tight":
      return 100;
    case "moderate":
      return 200;
  }
}

/** R1 Active Trader P1 — DEWS exclusion floor scales with exit speed. */
export function tradingDewsCeiling(exitSpeed: SelectorExitSpeed): number {
  switch (exitSpeed) {
    case "1h":
      return 35;
    case "24h":
      return 45;
    case "any":
      return 55;
  }
}

export function treasuryPegScoreFloor(tol: SelectorDepegTolerance): number {
  switch (tol) {
    case "zero":
      return 80;
    case "tight":
      return 70;
    case "moderate":
      return 60;
  }
}

const TREASURY_GRADE_REJECT: ReadonlySet<string> = new Set(["F", "D", "C-", "C"]);
const YIELD_TRADING_GRADE_REJECT: ReadonlySet<string> = new Set(["F", "D"]);

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

function fail(
  id: string,
  reason: ExclusionReason,
  severity: ExclusionRecord["severity"] = "hard",
  detail?: string,
): ExclusionRecord {
  return detail != null ? { id, reason, severity, detail } : { id, reason, severity };
}

/**
 * Universal exclusions (apply to every profile). Returns the first matching
 * record or `null`.
 */
export function applyUniversalExclusions(
  row: MergedRow,
  input: SelectorInput,
): ExclusionRecord | null {
  if (row.lifecycle !== "active") {
    return fail(row.id, "lifecycle-non-active");
  }
  if (row.pegCurrency !== input.pegCurrency) {
    return fail(row.id, "peg-currency-mismatch");
  }
  if (row.supplyUsd < 5_000_000) {
    return fail(row.id, "below-supply-floor");
  }

  // Howey pre-exclusion runs in the engine before this function; keep the
  // guard here for callers that test rules directly.
  if (HOWEY_UNCERTAIN_ASSETS.has(row.id)) {
    return fail(row.id, "howey-uncertain");
  }

  // Active depeg — scales with depegTolerance.
  if (row.activeDepeg && row.currentDeviationBps != null) {
    const ceiling = activeDepegThresholdBps(input.depegTolerance);
    if (Math.abs(row.currentDeviationBps) > ceiling) {
      return fail(row.id, "active-depeg");
    }
  }

  // Terminal grade.
  if (row.safetyGrade === "F") {
    return fail(row.id, "safety-grade-floor");
  }

  return null;
}

/**
 * Profile-specific exclusions. Returns the first matching record or `null`.
 */
export function applyProfileExclusions(
  row: MergedRow,
  profile: SelectorProfile,
  input: SelectorInput,
): ExclusionRecord | null {
  switch (profile) {
    case "treasury":
      return treasuryExclusions(row, input);
    case "yield":
      return yieldExclusions(row, input);
    case "trading":
      return tradingExclusions(row, input);
  }
}

function treasuryExclusions(row: MergedRow, input: SelectorInput): ExclusionRecord | null {
  if (row.safetyGrade != null && TREASURY_GRADE_REJECT.has(row.safetyGrade)) {
    return fail(row.id, "safety-grade-floor");
  }
  if (row.safetyResilienceScore != null && row.safetyResilienceScore < 50) {
    return fail(row.id, "safety-resilience-floor");
  }
  if (row.safetyDependencyRiskScore != null && row.safetyDependencyRiskScore < 50) {
    return fail(row.id, "safety-dependency-risk-floor");
  }
  if (row.dewsScore != null && row.dewsScore > 60) {
    return fail(row.id, "dews-ceiling");
  }
  const pegScoreFloor = treasuryPegScoreFloor(input.depegTolerance);
  if (row.pegScore != null && row.pegScore < pegScoreFloor) {
    return fail(
      row.id,
      "peg-score-floor",
      "hard",
      `PegScore ${Math.round(row.pegScore)} below ${pegScoreFloor}`,
    );
  }
  if (row.bluechipGrade === "D" || row.bluechipGrade === "F") {
    return fail(row.id, "bluechip-d-or-f");
  }
  return null;
}

function yieldExclusions(row: MergedRow, input: SelectorInput): ExclusionRecord | null {
  if (row.safetyGrade != null && YIELD_TRADING_GRADE_REJECT.has(row.safetyGrade)) {
    return fail(row.id, "safety-grade-floor");
  }
  if (row.pharosYieldScore == null) {
    return fail(row.id, "pys-null");
  }
  if (row.apy30d == null) {
    return fail(row.id, "pys-null");
  }
  const benchmarkFloor =
    row.benchmarkRate != null ? row.benchmarkRate * 0.75 : 0;
  const apyFloor = Math.max(input.minApy ?? 0, benchmarkFloor);
  if (row.apy30d < apyFloor) {
    return fail(row.id, "apy-below-floor");
  }
  if (
    row.venueRiskTier === "high" &&
    (row.safetyGrade === "C" || row.safetyGrade === "C-")
  ) {
    return fail(row.id, "high-venue-on-c-tier");
  }
  if (row.warningSignals.includes("unstable-apy")) {
    return fail(row.id, "yield-warning-unstable");
  }
  if (row.warningSignals.includes("thin-tvl")) {
    return fail(row.id, "yield-warning-thin-tvl");
  }
  // Peg thresholds scale with the user's stated depeg tolerance so the
  // "moderate" branch is genuinely permissive (the strict branch gets the
  // strict floor, the relaxed branch gets the relaxed floor — otherwise the
  // form's tolerance answer is decorative).
  const pegStabilityFloor =
    input.depegTolerance === "zero"
      ? 65
      : input.depegTolerance === "tight"
        ? 55
        : 45;
  if (row.pegStabilityScore != null && row.pegStabilityScore < pegStabilityFloor) {
    return fail(row.id, "peg-stability-floor");
  }
  const depegEventCountCeiling =
    input.depegTolerance === "zero" ? 3 : input.depegTolerance === "tight" ? 4 : 6;
  if (row.depegEventCount >= depegEventCountCeiling) {
    return fail(row.id, "depeg-event-count");
  }
  return null;
}

function tradingExclusions(row: MergedRow, input: SelectorInput): ExclusionRecord | null {
  if (row.safetyGrade != null && YIELD_TRADING_GRADE_REJECT.has(row.safetyGrade)) {
    return fail(row.id, "safety-grade-floor");
  }
  if (row.liquidityScore != null && row.liquidityScore < 50) {
    return fail(row.id, "liquidity-floor");
  }
  if (row.pegStabilityScore != null && row.pegStabilityScore < 75) {
    return fail(row.id, "peg-stability-floor");
  }
  const dewsCeiling = tradingDewsCeiling(input.exitSpeed);
  if (row.dewsScore != null && row.dewsScore > dewsCeiling) {
    return fail(row.id, "dews-ceiling");
  }
  if (input.exitSpeed === "1h") {
    if (row.liquidityScore != null && row.liquidityScore < 65) {
      return fail(row.id, "liquidity-floor");
    }
    if (row.effectiveTvlUsd != null && row.effectiveTvlUsd < 25_000_000) {
      return fail(row.id, "supply-tvl-floor-1h");
    }
  } else if (input.exitSpeed === "24h") {
    if (row.effectiveExitScore != null && row.effectiveExitScore < 50) {
      return fail(row.id, "effective-exit-floor");
    }
  }
  return null;
}

/**
 * Input-driven exclusions (decentralization=required, custody rail preference,
 * yield-native-only). Returns the first matching record or `null`.
 */
export function applyInputDrivenExclusions(
  row: MergedRow,
  input: SelectorInput,
): ExclusionRecord | null {
  if (input.decentralization === "required") {
    if (row.governance === "centralized") {
      return fail(row.id, "decentralization-required-violation");
    }
    if (
      row.canBeBlacklisted === true ||
      row.canBeBlacklisted === "dilutable" ||
      row.canBeBlacklisted === "inherited"
    ) {
      return fail(row.id, "decentralization-required-violation");
    }
  }
  if (input.custodyOk === "regulated-only") {
    if (
      row.custodyModel !== "institutional-top" &&
      row.custodyModel !== "institutional-regulated"
    ) {
      return fail(row.id, "custody-regulated-only-violation");
    }
  }
  if (input.custodyOk === "onchain-only") {
    if (row.custodyModel !== "onchain") {
      return fail(row.id, "custody-onchain-only-violation");
    }
  }
  if (input.profile === "yield" && input.yieldNativeOnly && row.deploymentPlace != null) {
    if (row.deploymentPlace !== "native-wrapper" && row.deploymentPlace !== "issuer-savings") {
      return fail(row.id, "yield-native-only-violation");
    }
  }
  return null;
}

/**
 * Combined exclusion evaluation. Composition: universal → profile → input.
 * Returns the first record that fires or `null` when the row survives.
 */
export function evaluateExclusions(
  row: MergedRow,
  input: SelectorInput,
): ExclusionRecord | null {
  return (
    applyUniversalExclusions(row, input) ??
    applyProfileExclusions(row, input.profile, input) ??
    applyInputDrivenExclusions(row, input)
  );
}

// ---------------------------------------------------------------------------
// Required-signals coverage check
// ---------------------------------------------------------------------------

const REQUIRED_SIGNALS: Record<SelectorProfile, readonly (keyof MergedRow)[]> = {
  treasury: [
    "safetyGrade",
    "safetyResilienceScore",
    "safetyDependencyRiskScore",
    "dewsScore",
    "pegScore",
    "pegStabilityScore",
  ],
  yield: [
    "safetyGrade",
    "pharosYieldScore",
    "pegScore",
    "pegStabilityScore",
    "apy30d",
  ],
  trading: [
    "safetyGrade",
    "liquidityScore",
    "pegScore",
    "pegStabilityScore",
    "dewsScore",
  ],
};

export const REQUIRED_SIGNALS_BY_PROFILE = REQUIRED_SIGNALS;

export interface CoverageResult {
  ok: boolean;
  missing: string[];
}

export function hasRequiredSignals(
  row: MergedRow,
  profile: SelectorProfile,
): CoverageResult {
  const missing: string[] = [];
  for (const signal of REQUIRED_SIGNALS[profile]) {
    if (row[signal] == null) {
      missing.push(String(signal));
    }
  }
  return { ok: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Lower-ranked Slot-A allow-list
// ---------------------------------------------------------------------------

export const PROFILE_DEFINING_EXCLUSIONS: Record<
  SelectorProfile,
  readonly ExclusionReason[]
> = {
  treasury: [
    "safety-grade-floor",
    "safety-resilience-floor",
    "safety-dependency-risk-floor",
    "dews-ceiling",
    "depeg-event-count",
    "peg-score-floor",
    "bluechip-d-or-f",
  ],
  yield: [
    "pys-null",
    "apy-below-floor",
    "yield-warning-unstable",
    "yield-warning-thin-tvl",
    "high-venue-on-c-tier",
    "peg-stability-floor",
  ],
  trading: [
    "liquidity-floor",
    "peg-stability-floor",
    "dews-ceiling",
    "effective-exit-floor",
    "supply-tvl-floor-1h",
  ],
};

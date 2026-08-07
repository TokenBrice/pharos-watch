import {
  bluechip,
  excessApyConcave,
  hhiToDiversity,
  identity,
  invert100,
  pegYieldScore,
  sourceRiskInverted,
  supplyLog,
  yieldVariance,
} from "./normalization";
import { clamp } from "../math";
import type {
  ExclusionReason,
  MergedRow,
  RecommendedSource,
  SelectorComponent,
  SelectorConfidenceReason,
  SelectorInput,
  SelectorProfile,
  WeightKey,
} from "./types";
import { getWeightVectorForInput } from "./weights";

interface NormalizedSlot {
  key: WeightKey;
  rawValue: number | null;
  normalizedValue: number | null;
  /** Profile-allocated weight before redistribution. */
  baseWeight: number;
}

export interface ScoredEntry {
  row: MergedRow;
  score: number;
  components: SelectorComponent[];
  confidence: number;
  confidenceReasons: SelectorConfidenceReason[];
  redistributedSlots: number;
  recommendedSource: RecommendedSource | null;
  perInputStaleness: Record<string, number> | null;
  relaxedReason: ExclusionReason | null;
  concentrationAdjusted?: boolean;
}

export interface ScoreRowResult {
  score: number;
  components: SelectorComponent[];
  confidence: number;
  confidenceReasons: SelectorConfidenceReason[];
  redistributedSlots: number;
  /** True when every signal was null (degenerate row). */
  degenerate: boolean;
}

type MissingPolicy = "penalty" | "ignore";

const CRITICAL_SIGNAL_SET_BY_PROFILE: Readonly<Record<SelectorProfile, ReadonlySet<WeightKey>>> = {
  treasury: new Set(["safetyOverall", "pegStabilityHistory", "dewsInverted"]),
  yield: new Set([
    "pharosYieldScore",
    "yieldVariance",
    "safetyOverall",
    "sourceRiskInverted",
    "pegStabilityLive",
    "liquidity",
  ]),
  trading: new Set(["liquidity", "pegScoreNow", "dewsInverted", "safetyOverall"]),
};

function rawValueFor(
  key: WeightKey,
  row: MergedRow,
): number | null {
  switch (key) {
    case "safetyOverall":
      return row.safetyScore;
    case "pegStabilityHistory":
    case "pegStabilityLive":
    case "pegScoreNow":
      return row.pegScore;
    case "dewsInverted":
      return row.dewsScore;
    case "bluechip":
      return row.bluechipGrade != null ? bluechip(row.bluechipGrade) : null;
    case "supplyLog":
      return row.supplyUsd;
    case "pharosYieldScore":
      return row.pharosYieldScore;
    case "excessApy":
      if (row.apy30d == null || row.benchmarkRate == null) return null;
      return row.apy30d - row.benchmarkRate;
    case "yieldVariance":
      return row.apyVariance30d;
    case "liquidity":
      return row.liquidityScore;
    case "sourceRiskInverted":
      return row.sourceRiskScore;
    case "liquidityDiversification":
      return row.concentrationHhi;
  }
  return null;
}

export function normalizeSelectorComponentValue(
  key: WeightKey,
  raw: number | null,
): number | null {
  switch (key) {
    case "safetyOverall":
    case "pegStabilityHistory":
    case "pegStabilityLive":
    case "pegScoreNow":
    case "liquidity":
      return identity(raw);
    case "dewsInverted":
      return invert100(raw);
    case "bluechip":
      return raw;
    case "supplyLog":
      return supplyLog(raw);
    case "pharosYieldScore":
      return pegYieldScore(raw);
    case "excessApy":
      return excessApyConcave(raw);
    case "yieldVariance":
      return yieldVariance(raw);
    case "sourceRiskInverted":
      return sourceRiskInverted(raw);
    case "liquidityDiversification":
      return hhiToDiversity(raw);
    // Retired slots. They stay in `WEIGHT_KEYS` so stored snapshots keep
    // validating, but no current vector allocates them, so normalizing one
    // yields nothing rather than reviving the double count.
    case "resilience":
    case "dependencyRisk":
    case "decentralization":
    case "effectiveExit":
      return null;
  }
}

function normalizeRow(
  row: MergedRow,
  input: SelectorInput,
): NormalizedSlot[] {
  const vector = getWeightVectorForInput(input);
  const slots: NormalizedSlot[] = [];
  for (const [k, w] of Object.entries(vector)) {
    if (typeof w !== "number") continue;
    if (w === 0) continue;
    if (k === "__profile") continue;
    const key = k as WeightKey;
    const raw = rawValueFor(key, row);
    const normalized = normalizeSelectorComponentValue(key, raw);
    slots.push({ key, rawValue: raw, normalizedValue: normalized, baseWeight: w });
  }
  return slots;
}

function missingPolicy(
  key: WeightKey,
  profile: SelectorProfile,
): MissingPolicy {
  if (key === "bluechip" && profile !== "treasury") return "ignore";
  return "penalty";
}

export function scoreRow(
  row: MergedRow,
  profile: SelectorProfile,
  input: SelectorInput,
): ScoreRowResult | null {
  const slots = normalizeRow(row, input);

  let redistributedSlots = 0;
  let scoreCap = 100;
  const confidenceReasons = new Set<SelectorConfidenceReason>();
  const present: NormalizedSlot[] = [];
  const neutralMissing = new Set<NormalizedSlot>();
  const criticalSignals = CRITICAL_SIGNAL_SET_BY_PROFILE[profile];
  for (const slot of slots) {
    if (slot.rawValue != null && slot.normalizedValue != null) {
      present.push(slot);
      continue;
    }
    const policy = missingPolicy(slot.key, profile);
    if (policy === "penalty") {
      redistributedSlots += 1;
    }
    if (criticalSignals.has(slot.key)) {
      confidenceReasons.add(`missing-critical-${slot.key}`);
      scoreCap = Math.min(scoreCap, 78);
    }
    // Intentional slot shape: sourceRiskInverted has rawValue == null (no
    // sourceRiskScore on the row) but normalizedValue != null because
    // sourceRiskInverted() always returns a number (neutral 50). It is counted
    // as present-but-neutral with a confidence hit, not as plain missing. This
    // relies on sourceRiskInverted() never returning null (see its overloads).
    if (slot.key === "sourceRiskInverted" && slot.normalizedValue != null) {
      present.push(slot);
      neutralMissing.add(slot);
      confidenceReasons.add("source-risk-missing");
    }
  }

  if (present.length === 0) {
    return null;
  }

  const totalBase = present.reduce((acc, s) => acc + s.baseWeight, 0);
  if (totalBase === 0) {
    return {
      score: 0,
      components: [],
      confidence: 0,
      confidenceReasons: ["redistributed-missing-data"],
      redistributedSlots,
      degenerate: true,
    };
  }

  const components: SelectorComponent[] = [];
  let score = 0;
  for (const slot of present) {
    const weight = (slot.baseWeight / totalBase) * 100;
    const contribution = (weight * (slot.normalizedValue ?? 0)) / 100;
    components.push({
      key: slot.key,
      weight,
      rawValue: slot.rawValue,
      normalizedValue: slot.normalizedValue,
      contribution,
      redistributed: neutralMissing.has(slot),
    });
    score += contribution;
  }

  const presentSet = new Set(present);
  for (const slot of slots) {
    if (presentSet.has(slot)) continue;
    components.push({
      key: slot.key,
      weight: 0,
      rawValue: slot.rawValue,
      normalizedValue: slot.normalizedValue,
      contribution: 0,
      redistributed: missingPolicy(slot.key, profile) === "penalty",
    });
  }

  let confidence = 100 - 5 * redistributedSlots;
  if (redistributedSlots > 0) {
    confidenceReasons.add("redistributed-missing-data");
  }
  if (row.isRecentListing) {
    confidence -= 10;
    confidenceReasons.add("recent-listing");
  }
  if (profile === "treasury" && row.depegEventCount >= 2) {
    confidence -= Math.min(12, row.depegEventCount * 3);
    confidenceReasons.add("treasury-depeg-history");
  }
  if (profile === "yield" && row.sourceSwitch) {
    confidence -= 8;
    confidenceReasons.add("yield-source-switched");
  }
  for (const reason of confidenceReasons) {
    if (reason.startsWith("missing-critical-")) confidence -= 8;
  }
  confidence = clamp(confidence, 0, 100);
  if (profile === "yield" && row.yieldHistoryDays < 60) {
    confidence = Math.min(confidence, 80);
    confidenceReasons.add("short-yield-history");
  }
  score = Math.min(score, scoreCap);

  return {
    score,
    components,
    confidence,
    confidenceReasons: Array.from(confidenceReasons).sort(),
    redistributedSlots,
    degenerate: false,
  };
}

/**
 * Score a row as if its exclusion had not fired. Used by lower-ranked Slot A
 * to surface high-quality near-misses.
 */
export function scoreIgnoringExclusion(
  row: MergedRow,
  input: SelectorInput,
): number | null {
  const result = scoreRow(row, input.profile, input);
  return result ? result.score : null;
}

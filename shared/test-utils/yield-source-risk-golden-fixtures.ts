import type { PysSourceRiskPenaltyInput } from "@shared/lib/yield-scoring";
import type { YieldSourceRisk, YieldVenueRiskTier } from "@shared/types/yield";

export type YieldSourceRiskGoldenCaseId =
  | "reward-heavy"
  | "stale-source-age"
  | "low-source-depth"
  | "source-switch-churn"
  | "bootstrap-observation-count"
  | "zero-apy"
  | "negative-apy"
  | "missing-safety";

export type YieldSourceRiskGoldenDriverLabel =
  | "reward-heavy"
  | "thin source depth"
  | "stale source"
  | "limited history"
  | "source changed";

export interface YieldSourceRiskGoldenRow {
  label: YieldSourceRiskGoldenCaseId;
  input: PysSourceRiskPenaltyInput;
  expectedDerivedPenalty: number;
  expectedEvaluationPenalty?: number;
  apy30d?: number;
  safetyScore?: number | null;
  expectedDriverLabel?: YieldSourceRiskGoldenDriverLabel;
}

export const SOURCE_RISK_GOLDEN_ROWS: readonly YieldSourceRiskGoldenRow[] = [
  {
    label: "reward-heavy",
    input: { rewardShare: 0.9 },
    expectedDerivedPenalty: 1.4,
    expectedDriverLabel: "reward-heavy",
  },
  {
    label: "stale-source-age",
    input: { sourceAgeSeconds: 7 * 60 * 60 },
    expectedDerivedPenalty: 1.25,
    expectedDriverLabel: "stale source",
  },
  {
    label: "low-source-depth",
    input: { sourceDepthRatio: 0.0005 },
    expectedDerivedPenalty: 1.35,
    expectedDriverLabel: "thin source depth",
  },
  {
    label: "source-switch-churn",
    input: { sourceSwitchCount30d: 3 },
    expectedDerivedPenalty: 1.3,
    expectedDriverLabel: "source changed",
  },
  {
    label: "bootstrap-observation-count",
    input: { observationCount30d: 3 },
    expectedDerivedPenalty: 1.2,
    expectedDriverLabel: "limited history",
  },
  { label: "zero-apy", input: {}, expectedDerivedPenalty: 1, expectedEvaluationPenalty: 1.2, apy30d: 0 },
  { label: "negative-apy", input: {}, expectedDerivedPenalty: 1, expectedEvaluationPenalty: 1.2, apy30d: -1 },
  { label: "missing-safety", input: {}, expectedDerivedPenalty: 1, safetyScore: null },
];

export const SOURCE_RISK_GOLDEN_UI_DRIVER_LABELS: readonly YieldSourceRiskGoldenDriverLabel[] = [
  "reward-heavy",
  "thin source depth",
  "stale source",
  "limited history",
  "source changed",
];

export const SOURCE_RISK_GOLDEN_PUBLICATION_GENERATION_ID = "yield-1774526400";

export const SOURCE_RISK_GOLDEN_UPDATED_AT = 1_774_526_400;

function normalizeVenueRiskTier(value: string | null | undefined): YieldVenueRiskTier {
  return value === "low" || value === "medium" || value === "high" || value === "unknown"
    ? value
    : "unknown";
}

export function getSourceRiskGoldenRow(label: YieldSourceRiskGoldenCaseId): YieldSourceRiskGoldenRow {
  const row = SOURCE_RISK_GOLDEN_ROWS.find((candidate) => candidate.label === label);
  if (!row) {
    throw new Error(`Unknown source-risk golden row: ${label}`);
  }
  return row;
}

export function buildSourceRiskGoldenFixture(
  label: YieldSourceRiskGoldenCaseId,
  overrides: Partial<YieldSourceRisk> = {},
): YieldSourceRisk {
  const row = getSourceRiskGoldenRow(label);
  return {
    sourceRiskScore: null,
    sourceRiskPenalty: row.expectedEvaluationPenalty ?? row.expectedDerivedPenalty,
    sourceDepthRatio: row.input.sourceDepthRatio ?? null,
    rewardShare: row.input.rewardShare ?? null,
    sourceAgeSeconds: row.input.sourceAgeSeconds ?? null,
    observationCount30d: row.input.observationCount30d ?? null,
    sourceSwitchCount30d: row.input.sourceSwitchCount30d ?? null,
    deploymentPlace: null,
    venueProtocol: null,
    venueChain: null,
    venueRiskTier: normalizeVenueRiskTier(row.input.venueRiskTier),
    investabilityFlags: row.expectedDriverLabel ? [row.label] : [],
    ...overrides,
  };
}

export function mergeSourceRiskGoldenFixtures(
  labels: readonly YieldSourceRiskGoldenCaseId[],
  overrides: Partial<YieldSourceRisk> = {},
): YieldSourceRisk {
  const merged: Record<string, unknown> = {};
  for (const label of labels) {
    for (const [key, value] of Object.entries(buildSourceRiskGoldenFixture(label))) {
      if (value != null) {
        merged[key] = value;
      }
    }
  }
  return {
    ...merged,
    ...overrides,
  } as YieldSourceRisk;
}

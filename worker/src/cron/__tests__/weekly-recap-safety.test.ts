import { describe, expect, it } from "vitest";
import type {
  DigestGradeTransition,
  DigestInputData,
  DigestSafetyContext,
} from "@shared/types/digest";
import type {
  SafetyScoreV8PublicationIdentity,
  SafetyScoreV9PublicationIdentity,
} from "@shared/types/safety-score-publication";
import { buildWeeklyInputData } from "../weekly-recap/input-data";
import { buildWeeklyPrompt } from "../weekly-recap/prompt";
import type { DailyDigestSourceRow } from "../weekly-recap/types";

const v8Identity: SafetyScoreV8PublicationIdentity = {
  model: "v8",
  schemaVersion: 1,
  methodologyVersion: "8.17",
  evaluationBuildDigest: "a".repeat(64),
  baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
  publicationGenerationId: "report-cards:v8:1",
};
const v9Identity: SafetyScoreV9PublicationIdentity = {
  model: "v9",
  schemaVersion: 1,
  methodologyVersion: "9.0",
  policyId: "safety-score-v9",
  policyDigest: "c".repeat(64),
  evaluationBuildDigest: "d".repeat(64),
  baseInputGenerationId: `report-cards-input:v1:${"e".repeat(64)}`,
  publicationGenerationId: "report-cards:v9:current",
};
const pillar = {
  score: 80,
  evidenceLevel: "adequate",
  freshness: "current",
  reasons: [],
};

function v8Transition(recordedAt: number): DigestGradeTransition {
  return {
    historyId: "v8-organic",
    recordedAt,
    model: "v8",
    safetyScoreIdentity: v8Identity,
    symbol: "USDT",
    fromGrade: "A",
    toGrade: "B+",
    fromScore: 90,
    toScore: 84,
    currentDimensions: { peg: 95, liq: 90, resilience: null, decentralization: null },
    mcapUsd: 100_000_000,
  };
}

function v9Transition(
  recordedAt: number,
  identity: SafetyScoreV9PublicationIdentity = v9Identity,
): DigestGradeTransition {
  return {
    historyId: `v9-organic:${identity.evaluationBuildDigest}`,
    recordedAt,
    model: "v9",
    safetyScoreIdentity: {
      ...identity,
      baseInputGenerationId: `report-cards-input:v1:${"f".repeat(64)}`,
      publicationGenerationId: "report-cards:v9:prior",
    },
    symbol: "USDC",
    fromGrade: "A",
    toGrade: "A-",
    fromScore: 92,
    toScore: 89,
    currentPillars: { backing: pillar, exit: pillar, control: pillar },
    reasonCodes: [],
    caps: [],
    bindingCap: null,
    mcapUsd: 80_000_000,
  };
}

function row(
  index: number,
  transitions: DigestGradeTransition[] = [],
  authoredIdentity?: SafetyScoreV8PublicationIdentity | SafetyScoreV9PublicationIdentity,
): DailyDigestSourceRow {
  const generatedAt = 1_784_916_000 + index * 86_400;
  const input: DigestInputData = {
    totalMcapUsd: 180_000_000 + index,
    mcap7dDelta: 0,
    activeDepegCount: 0,
    topDepegs: [],
    biggestSupplyChange: null,
    stabilityIndex: { score: 90, band: "BEDROCK", components: { severity: 0, breadth: 0, trend: 0 } },
    yesterdayIndex: null,
    gradeTransitions: transitions,
    ...(authoredIdentity ? { safetyContext: available(authoredIdentity) } : {}),
  };
  return {
    generated_at: generatedAt,
    digest_title: `Day ${index}`,
    digest_text: "Market context.",
    input_data: JSON.stringify(input),
  };
}

function available(identity: SafetyScoreV8PublicationIdentity | SafetyScoreV9PublicationIdentity): DigestSafetyContext {
  return {
    status: "available",
    expectedModel: identity.model,
    identity,
    publishedAt: 1_785_000_000,
    reason: null,
  };
}

describe("weekly recap safety identity", () => {
  it("keeps only organic transitions comparable with the active V9 policy/build", () => {
    const otherBuild = { ...v9Identity, evaluationBuildDigest: "1".repeat(64) };
    const rows = [
      row(0, [v8Transition(1_784_916_000)]),
      row(1, [v9Transition(1_785_002_400)]),
      row(2, [v9Transition(1_785_088_800, otherBuild)]),
      row(3, [v9Transition(1_785_002_400)]),
      row(4),
    ];

    const weekly = buildWeeklyInputData(rows, [], available(v9Identity));

    expect(weekly?.safetyContext).toMatchObject({
      status: "available",
      identity: v9Identity,
    });
    expect(weekly?.gradeTransitionCount).toBe(1);
    expect(weekly?.weeklySignals.topGradeTransitions).toHaveLength(1);
    expect(weekly?.weeklySignals.topGradeTransitions[0]).toMatchObject({
      historyId: `v9-organic:${v9Identity.evaluationBuildDigest}`,
      model: "v9",
      safetyScoreIdentity: {
        publicationGenerationId: "report-cards:v9:prior",
      },
    });
  });

  it("omits only safety movers when V9 is unavailable and restores V8 movers after rollback", () => {
    const rows = [
      row(0, [v8Transition(1_784_916_000)]),
      row(1),
      row(2),
      row(3),
      row(4),
    ];
    const unavailable: DigestSafetyContext = {
      status: "unavailable",
      expectedModel: "v9",
      identity: null,
      publishedAt: null,
      reason: "v9-identity-mismatch",
    };

    const degraded = buildWeeklyInputData(rows, [], unavailable);
    const restored = buildWeeklyInputData(rows, [], available(v8Identity));

    expect(degraded).toMatchObject({
      totalBlacklistEventsThisWeek: 0,
      gradeTransitionCount: 0,
      degradedSources: ["safety-canonical-snapshot:v9-identity-mismatch"],
    });
    expect(restored?.gradeTransitionCount).toBe(1);
    expect(restored?.weeklySignals.topGradeTransitions[0]).toMatchObject({
      historyId: "v8-organic",
      model: "v8",
    });
  });

  it("withholds natural-language copy whose authored safety identity is incompatible", () => {
    const priorV9Identity: SafetyScoreV9PublicationIdentity = {
      ...v9Identity,
      baseInputGenerationId: `report-cards-input:v1:${"1".repeat(64)}`,
      publicationGenerationId: "report-cards:v9:prior",
    };
    const incompatible = {
      ...row(0, [v8Transition(1_784_916_000)], v8Identity),
      digest_title: "USDT Held An A Grade",
      digest_text: "USDT's report card stayed A.",
    };
    const compatible = {
      ...row(1, [v9Transition(1_785_002_400)], priorV9Identity),
      digest_title: "USDC Moved On V9 Evidence",
      digest_text: "USDC's current policy series changed organically.",
    };
    const rows = [
      incompatible,
      compatible,
      row(2, [], priorV9Identity),
      row(3, [], priorV9Identity),
      row(4, [], priorV9Identity),
    ];

    const weekly = buildWeeklyInputData(rows, [], available(v9Identity));
    expect(weekly?.dailyDigests[0]).toMatchObject({ title: "", text: "" });
    expect(weekly?.dailyDigests[1]).toMatchObject({
      title: "USDC Moved On V9 Evidence",
      text: "USDC's current policy series changed organically.",
    });

    const prompt = buildWeeklyPrompt(weekly!);
    expect(prompt).not.toContain("USDT Held An A Grade");
    expect(prompt).not.toContain("USDT's report card stayed A.");
    expect(prompt).toContain("USDC Moved On V9 Evidence");
  });
});

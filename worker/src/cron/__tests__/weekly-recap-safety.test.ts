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

function unavailable(reason = "v9-publication-held"): DigestSafetyContext {
  return {
    status: "unavailable",
    expectedModel: "v9",
    identity: null,
    publishedAt: null,
    reason,
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
    const degraded = buildWeeklyInputData(rows, [], unavailable("v9-identity-mismatch"));
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

  it("does not prime grade language when canonical safety context is unavailable", () => {
    const rows = [
      row(0, [v9Transition(1_784_916_000)], v9Identity),
      row(1, [], v9Identity),
      row(2, [], v9Identity),
      row(3, [], v9Identity),
      row(4, [], v9Identity),
    ];

    const weekly = buildWeeklyInputData(rows, [], unavailable());
    const prompt = buildWeeklyPrompt(weekly!);

    expect(prompt).toContain("Risk transitions: 0");
    expect(prompt).not.toContain("Grade transitions:");
    expect(prompt).not.toContain("Top grade transitions by mcap");
  });

  it("places the latest capture-matched census and grade movers in one dated safety desk", () => {
    const rows = [0, 1, 2, 3, 4].map((index) => row(index, [], v9Identity));
    const latestInput = JSON.parse(rows[4]!.input_data) as DigestInputData;
    latestInput.safetyMap = {
      imageUrl: "https://pharos.watch/safety-scores/map.png?date=2026-07-26",
      freshness: "carried-forward",
      ageDays: 2,
      manifest: {
        date: "2026-07-26",
        asOfSec: 1_774_000_000,
        renderedAtSec: 1_774_001_000,
        edition: "daily",
        bytes: { png: 1_000_000 },
        mapSummary: {
          date: "2026-07-26",
          asOfSec: 1_774_000_000,
          methodologyVersion: "v9.4",
          gradedCount: 10,
          notRatedCount: 2,
          totalMcapUsd: 100_000_000_000,
          floorMcapByTier: { a: 1_000_000, other: 100_000 },
          tiers: [
            { tier: "A", range: "90-100", count: 2, mcapUsd: 70_000_000_000, sharePct: 70, leaders: [{ symbol: "USDT", score: 95, mcapUsd: 60_000_000_000 }] },
            { tier: "B", range: "80-89", count: 2, mcapUsd: 15_000_000_000, sharePct: 15, leaders: [] },
            { tier: "C", range: "70-79", count: 2, mcapUsd: 8_000_000_000, sharePct: 8, leaders: [] },
            { tier: "D", range: "60-69", count: 2, mcapUsd: 5_000_000_000, sharePct: 5, leaders: [] },
            { tier: "F", range: "0-59", count: 2, mcapUsd: 2_000_000_000, sharePct: 2, leaders: [] },
          ],
        },
      },
    };
    rows[4] = { ...rows[4]!, input_data: JSON.stringify(latestInput) };

    const weekly = buildWeeklyInputData(rows, [], available(v9Identity));
    const prompt = buildWeeklyPrompt(weekly!);

    expect(prompt).toContain("Safety desk:");
    expect(prompt).toContain("Safety Map census (carried-forward, age 2 days; depicts 2026-07-26 UTC)");
    expect(prompt).toContain("Grade movers this week: none recorded");
    expect(prompt).not.toContain("Top grade transitions by mcap");
  });
});

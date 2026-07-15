import { describe, expect, it } from "vitest";
import type { DimensionKey, ReportCard, ReportCardDimension, ReportCardGrade } from "@shared/types";
import {
  assessAlertSafetySourceCache,
  alertSafetyIdentitiesAreComparable,
  buildAlertSafetySnapshotEnvelope,
  buildAlertSafetySourceEnvelope,
  buildAlertSafetyV9SourceEnvelope,
  getAlertSafetySourceGeneration,
  parseAlertSafetySnapshotEnvelope,
} from "../alert-safety-source-cache";
import { makeWorkerReportCardsV9Response, makeWorkerV9Card } from "../../test-helpers/report-cards-v9";

const DIMENSION_KEYS: readonly DimensionKey[] = [
  "pegStability",
  "liquidity",
  "resilience",
  "decentralization",
  "dependencyRisk",
];

function sourceEnvelope(
  snapshot: Record<string, Record<string, unknown>>,
  methodologyVersion: string,
  publishedAt: number,
  generation = getAlertSafetySourceGeneration(methodologyVersion),
) {
  const publicationGenerationId = `report-cards:${methodologyVersion}:${publishedAt}`;
  const notRatedIds = Object.entries(snapshot).flatMap(([id, row]) => (row.score === null ? [id] : []));
  return {
    generation,
    safetyScoreIdentity: {
      model: "v8" as const,
      schemaVersion: 1 as const,
      methodologyVersion,
      evaluationBuildDigest: "a".repeat(64),
      baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
      publicationGenerationId,
    },
    publicationGenerationId,
    methodologyVersion,
    publishedAt,
    completeness: {
      generationId: publicationGenerationId,
      methodologyVersion,
      expectedCount: Object.keys(snapshot).length,
      scoredCount: Object.keys(snapshot).length - notRatedIds.length,
      notRatedCount: notRatedIds.length,
      notRatedIds,
    },
    snapshot,
  };
}

function buildSource(cards: ReportCard[], methodologyVersion: string, publishedAt: number) {
  const publicationGenerationId = `report-cards:${methodologyVersion}:${publishedAt}`;
  const liveCards = cards.filter((card) => !card.isDefunct);
  const notRatedIds = liveCards.filter((card) => card.overallScore === null).map((card) => card.id);
  return buildAlertSafetySourceEnvelope(
    cards,
    methodologyVersion,
    publishedAt,
    {
      generationId: publicationGenerationId,
      methodologyVersion,
      expectedCount: liveCards.length,
      scoredCount: liveCards.length - notRatedIds.length,
      notRatedCount: notRatedIds.length,
      notRatedIds,
    },
    sourceEnvelope({}, methodologyVersion, publishedAt).safetyScoreIdentity,
  );
}

describe("alert safety source cache", () => {
  it("treats model and V9 policy changes as alert-baseline boundaries", () => {
    const v8 = sourceEnvelope({}, "8.0", 1).safetyScoreIdentity;
    const v9 = {
      model: "v9" as const,
      schemaVersion: 1 as const,
      methodologyVersion: "9.0",
      policyId: "safety-score-v9",
      policyDigest: "c".repeat(64),
      evaluationBuildDigest: "d".repeat(64),
      baseInputGenerationId: `report-cards-input:v1:${"e".repeat(64)}`,
      publicationGenerationId: "report-cards:v9:1",
    };
    expect(alertSafetyIdentitiesAreComparable(v8, v9)).toBe(false);
    expect(alertSafetyIdentitiesAreComparable(v9, { ...v9, policyDigest: "f".repeat(64) })).toBe(false);
    expect(alertSafetyIdentitiesAreComparable(v9, { ...v9, publicationGenerationId: "report-cards:v9:2" })).toBe(true);
  });

  it("builds a strict opt-in V9 envelope with native explanations", () => {
    const cap = {
      kind: "structural-ceiling",
      limit: 80,
      source: "structural" as const,
      reason: "Single-entity controls bind the result.",
      binding: true,
    };
    const response = makeWorkerReportCardsV9Response({
      cards: [makeWorkerV9Card({
        caps: [cap],
        bindingCap: cap,
        evidence: {
          level: "limited",
          freshness: "current",
          reasons: [{ code: "mint-control-question", message: "Mint authority remains concentrated.", path: null }],
        },
      })],
    });

    expect(buildAlertSafetyV9SourceEnvelope(response, { allowShadowLifecycle: false })).toBeNull();
    expect(buildAlertSafetyV9SourceEnvelope(response, { allowShadowLifecycle: true })).toMatchObject({
      lifecycle: "shadow",
      safetyScoreIdentity: response.safetyScoreIdentity,
      snapshot: {
        "usdc-circle": {
          v9Explain: {
            reasons: [{ code: "mint-control-question", message: "Mint authority remains concentrated." }],
            bindingCap: { kind: "structural-ceiling", limit: 80 },
            weakestPillar: { pillar: "backing", score: 80 },
          },
        },
      },
    });
    expect(buildAlertSafetyV9SourceEnvelope(
      { ...response, completeness: { ...response.completeness, expectedCount: 2 } },
      { allowShadowLifecycle: true },
    )).toBeNull();
  });

  it("builds a generation-aware envelope with explain data", () => {
    const envelope = buildSource(
      [
        reportCard({
          id: "usdc-circle",
          name: "USD Coin",
          symbol: "USDC",
          overallGrade: "A",
          overallScore: 90,
          baseScore: 90,
        }),
      ],
      "7.09",
      1_700_000_000,
    );

    expect(envelope.generation).toBe(getAlertSafetySourceGeneration("7.09"));
    expect(envelope.snapshot["usdc-circle"]).toMatchObject({
      grade: "A",
      score: 90,
      methodologyVersion: "7.09",
      explain: {
        schemaVersion: 1,
        stages: {
          baseScore: 90,
          finalScore: 90,
          noLiquidityPenaltyApplied: false,
          activeDepegCapApplied: false,
          variantCapApplied: false,
        },
        rawInputs: {
          pegScore: 100,
          activeDepeg: false,
          liquidityScore: 90,
          canBeBlacklisted: false,
          dependencyCount: 0,
        },
      },
    });
    expect(envelope.snapshot["usdc-circle"].explain?.dimensions.liquidity).toEqual({
      grade: "A",
      score: 90,
      detail: "Exit liquidity detail",
    });
  });

  it("marks wrong-generation and stale source snapshots explicitly", () => {
    const wrongGeneration = assessAlertSafetySourceCache(
      {
        value: JSON.stringify(
          sourceEnvelope(
            {
              "usdc-circle": { grade: "A", score: 90, methodologyVersion: "7.09" },
            },
            "7.09",
            1_700_000_000,
            "legacy-generation",
          ),
        ),
        updatedAt: 1_700_000_000,
      },
      {
        expectedGeneration: getAlertSafetySourceGeneration("7.09"),
        nowSec: 1_700_000_060,
        producerIntervalSec: 900,
      },
    );
    expect(wrongGeneration.state).toBe("wrong-generation");

    const stale = assessAlertSafetySourceCache(
      {
        value: JSON.stringify(
          sourceEnvelope(
            {
              "usdc-circle": { grade: "A", score: 90, methodologyVersion: "7.09" },
            },
            "7.09",
            1_700_000_000,
          ),
        ),
        updatedAt: 1_700_000_000,
      },
      {
        expectedGeneration: getAlertSafetySourceGeneration("7.09"),
        nowSec: 1_700_002_000,
        producerIntervalSec: 900,
      },
    );
    expect(stale.state).toBe("stale");
  });

  it("parses legacy snapshot rows without explain data", () => {
    const parsed = parseAlertSafetySnapshotEnvelope({
      value: JSON.stringify({
        "usdc-circle": { grade: "A", score: 90, methodologyVersion: "7.09" },
      }),
      updatedAt: 1_700_000_000,
    });

    expect(parsed).toEqual({
      generation: "",
      snapshot: {
        "usdc-circle": { grade: "A", score: 90, methodologyVersion: "7.09" },
      },
    });
  });

  it("drops malformed or future explain data without dropping valid rows", () => {
    const parsed = parseAlertSafetySnapshotEnvelope({
      value: JSON.stringify({
        generation: getAlertSafetySourceGeneration("7.09"),
        snapshot: {
          malformed: {
            grade: "B",
            score: 72,
            methodologyVersion: "7.09",
            explain: { schemaVersion: 1, stages: "bad" },
          },
          future: {
            grade: "C+",
            score: 61,
            methodologyVersion: "7.09",
            explain: { schemaVersion: 999, stages: {}, dimensions: {}, rawInputs: {} },
          },
        },
      }),
      updatedAt: 1_700_000_000,
    });

    expect(parsed?.snapshot).toEqual({
      malformed: { grade: "B", score: 72, methodologyVersion: "7.09" },
      future: { grade: "C+", score: 61, methodologyVersion: "7.09" },
    });
  });

  it("sanitizes malformed explain data in source envelopes without corrupting core rows", () => {
    const assessed = assessAlertSafetySourceCache(
      {
        value: JSON.stringify(
          sourceEnvelope(
            {
              malformed: {
                grade: "B",
                score: 72,
                methodologyVersion: "7.09",
                explain: { schemaVersion: 1, stages: "bad" },
              },
              future: {
                grade: "C+",
                score: 61,
                methodologyVersion: "7.09",
                explain: { schemaVersion: 999, stages: {}, dimensions: {}, rawInputs: {} },
              },
              corrupt: {
                grade: "A",
                score: "90",
                methodologyVersion: "7.09",
              },
            },
            "7.09",
            1_700_000_000,
          ),
        ),
        updatedAt: 1_700_000_000,
      },
      {
        expectedGeneration: getAlertSafetySourceGeneration("7.09"),
        nowSec: 1_700_000_060,
        producerIntervalSec: 900,
      },
    );

    expect(assessed.state).toBe("ok");
    expect(assessed.envelope?.snapshot).toEqual({
      malformed: { grade: "B", score: 72, methodologyVersion: "7.09" },
      future: { grade: "C+", score: 61, methodologyVersion: "7.09" },
    });
  });

  it("marks source envelopes corrupt when every core row is invalid", () => {
    const assessed = assessAlertSafetySourceCache(
      {
        value: JSON.stringify(
          sourceEnvelope(
            {
              corrupt: {
                grade: "A",
                score: "90",
                methodologyVersion: "7.09",
              },
            },
            "7.09",
            1_700_000_000,
          ),
        ),
        updatedAt: 1_700_000_000,
      },
      {
        expectedGeneration: getAlertSafetySourceGeneration("7.09"),
        nowSec: 1_700_000_060,
        producerIntervalSec: 900,
      },
    );

    expect(assessed.state).toBe("corrupt");
    expect(assessed.envelope).toBeNull();
  });

  it("derives the post-peg stage from the unrounded weighted mean, not rounded baseScore", () => {
    // Dimension scores chosen so the weighted mean (60.2778) rounds to a
    // baseScore (60.3) that, after the peg multiplier, would round to a
    // different post-peg stage (55.2) than the engine's actual value (55.1).
    const envelope = buildSource(
      [
        reportCard({
          id: "divergent",
          overallGrade: "D",
          overallScore: 55,
          baseScore: 60.3,
          dimensions: {
            pegStability: dimension("C", 80, "Peg detail"),
            liquidity: dimension("D", 60, "Liquidity detail"),
            resilience: dimension("D", 60, "Resilience detail"),
            decentralization: dimension("D", 60, "Decentralization detail"),
            dependencyRisk: dimension("D", 61, "Dependency detail"),
          },
          rawInputs: { ...reportCard().rawInputs, pegScore: 80, liquidityScore: 60 },
        }),
      ],
      "7.09",
      1_700_000_000,
    );

    const stages = envelope.snapshot["divergent"].explain?.stages;
    expect(stages?.baseScore).toBe(60.3);
    expect(stages?.postPegScore).toBe(55.1);
  });

  it("keeps explain data through the source-cache to alert-snapshot envelope path", () => {
    const source = buildSource([reportCard()], "7.09", 1_700_000_000);
    const alertSnapshot = buildAlertSafetySnapshotEnvelope(
      source.snapshot,
      source.generation,
      source.safetyScoreIdentity,
    );
    const parsed = parseAlertSafetySnapshotEnvelope({
      value: JSON.stringify(alertSnapshot),
      updatedAt: 1_700_000_000,
    });

    expect(parsed?.generation).toBe(source.generation);
    expect(parsed?.snapshot["usdc-circle"].explain?.stages.postPegScore).toBe(90);
    expect(parsed?.snapshot["usdc-circle"].explain?.rawInputs.dependencyCount).toBe(0);
  });

  it("keeps the serialized source cache within the D1 row budget", () => {
    const longDetail = "x".repeat(1_000);
    const cards = Array.from({ length: 401 }, (_, index) =>
      reportCard({
        id: `coin-${index}`,
        name: `Coin ${index}`,
        symbol: `C${index}`,
        dimensions: {
          pegStability: dimension("A+", 100, longDetail),
          liquidity: dimension("A", 90, longDetail),
          resilience: dimension("A", 90, longDetail),
          decentralization: dimension("A", 90, longDetail),
          dependencyRisk: dimension("A", 90, longDetail),
        },
      }),
    );
    const envelope = buildSource(cards, "7.09", 1_700_000_000);

    expect(Buffer.byteLength(JSON.stringify(envelope), "utf8")).toBeLessThanOrEqual(1_500_000);
    expect(envelope.snapshot["coin-0"].explain?.dimensions.liquidity.detail?.length).toBeLessThanOrEqual(160);
  });
});

function reportCard(overrides: Partial<ReportCard> = {}): ReportCard {
  return {
    id: "usdc-circle",
    name: "USD Coin",
    symbol: "USDC",
    overallGrade: "A",
    overallScore: 90,
    baseScore: 90,
    dimensions: {
      pegStability: dimension("A+", 100, "Peg stability detail"),
      liquidity: dimension("A", 90, "Exit liquidity detail"),
      resilience: dimension("A", 90, "Resilience detail"),
      decentralization: dimension("A", 90, "Decentralization detail"),
      dependencyRisk: dimension("A", 90, "Dependency detail"),
    },
    ratedDimensions: DIMENSION_KEYS.length,
    rawInputs: {
      pegScore: 100,
      activeDepeg: false,
      activeDepegBps: null,
      depegEventCount: 0,
      lastEventAt: null,
      liquidityScore: 90,
      effectiveExitScore: 90,
      redemptionBackstopScore: null,
      redemptionRouteFamily: null,
      redemptionModelConfidence: null,
      redemptionUsedForLiquidity: false,
      redemptionImmediateCapacityUsd: null,
      redemptionImmediateCapacityRatio: null,
      concentrationHhi: 0.1,
      bluechipGrade: null,
      canBeBlacklisted: false,
      chainTier: "ethereum",
      deploymentModel: "single-chain",
      collateralQuality: "rwa",
      custodyModel: "institutional-regulated",
      governanceTier: "centralized",
      governanceQuality: "regulated-entity",
      dependencies: [],
      variantParentId: null,
      variantKind: null,
      navToken: false,
      collateralFromLive: false,
      dependencyFromLive: false,
    },
    isDefunct: false,
    ...overrides,
  };
}

function dimension(grade: ReportCardGrade, score: number | null, detail: string): ReportCardDimension {
  return { grade, score, detail };
}

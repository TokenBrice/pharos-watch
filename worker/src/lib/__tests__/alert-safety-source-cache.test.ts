import { describe, expect, it } from "vitest";
import type { DimensionKey, ReportCard, ReportCardDimension, ReportCardGrade } from "@shared/types";
import {
  assessAlertSafetySourceCache,
  buildAlertSafetySnapshotEnvelope,
  buildAlertSafetySourceEnvelope,
  getAlertSafetySourceGeneration,
  parseAlertSafetySnapshotEnvelope,
} from "../alert-safety-source-cache";

const DIMENSION_KEYS: readonly DimensionKey[] = [
  "pegStability",
  "liquidity",
  "resilience",
  "decentralization",
  "dependencyRisk",
];

describe("alert safety source cache", () => {
  it("builds a generation-aware envelope with explain data", () => {
    const envelope = buildAlertSafetySourceEnvelope([
      reportCard({
        id: "usdc-circle",
        name: "USD Coin",
        symbol: "USDC",
        overallGrade: "A",
        overallScore: 90,
        baseScore: 90,
      }),
    ], "7.09", 1_700_000_000);

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
        value: JSON.stringify({
          generation: "legacy-generation",
          methodologyVersion: "7.09",
          publishedAt: 1_700_000_000,
          snapshot: {
            "usdc-circle": { grade: "A", score: 90, methodologyVersion: "7.09" },
          },
        }),
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
        value: JSON.stringify({
          generation: getAlertSafetySourceGeneration("7.09"),
          methodologyVersion: "7.09",
          publishedAt: 1_700_000_000,
          snapshot: {
            "usdc-circle": { grade: "A", score: 90, methodologyVersion: "7.09" },
          },
        }),
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
        value: JSON.stringify({
          generation: getAlertSafetySourceGeneration("7.09"),
          methodologyVersion: "7.09",
          publishedAt: 1_700_000_000,
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
            corrupt: {
              grade: "A",
              score: "90",
              methodologyVersion: "7.09",
            },
          },
        }),
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
        value: JSON.stringify({
          generation: getAlertSafetySourceGeneration("7.09"),
          methodologyVersion: "7.09",
          publishedAt: 1_700_000_000,
          snapshot: {
            corrupt: {
              grade: "A",
              score: "90",
              methodologyVersion: "7.09",
            },
          },
        }),
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

  it("keeps explain data through the source-cache to alert-snapshot envelope path", () => {
    const source = buildAlertSafetySourceEnvelope([reportCard()], "7.09", 1_700_000_000);
    const alertSnapshot = buildAlertSafetySnapshotEnvelope(source.snapshot, source.generation);
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
    const cards = Array.from({ length: 401 }, (_, index) => reportCard({
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
    }));
    const envelope = buildAlertSafetySourceEnvelope(cards, "7.09", 1_700_000_000);

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

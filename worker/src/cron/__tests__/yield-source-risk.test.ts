import { describe, expect, it } from "vitest";
import { buildYieldSourceRisk } from "../yield-sync/source-risk";
import type { EvaluatedYieldSource } from "../yield-sync/evaluation-types";

function makeSource(overrides: Partial<EvaluatedYieldSource> = {}): EvaluatedYieldSource {
  return {
    sourceKey: "aave-v3-onchain:ethereum:0xasset",
    dataSource: "onchain",
    yieldType: "lending-vault",
    currentApy: 5,
    apyReward: null,
    sourceRisk: null,
    sourceRiskPenalty: 1,
    sourceDepthRatio: null,
    observationCount30d: null,
    sourceSwitchCount30d: null,
    venueProtocol: null,
    venueChain: null,
    ...overrides,
  } as EvaluatedYieldSource;
}

describe("yield source-risk registry", () => {
  it("publishes the reviewed venue tier on built source-risk evidence", () => {
    const sourceRisk = buildYieldSourceRisk({
      source: makeSource(),
      provenance: { sourceAgeSeconds: 300 },
      isBest: true,
    });

    expect(sourceRisk).toMatchObject({
      sourceRiskPenalty: 1,
      venueProtocol: "aave-v3",
      venueChain: "ethereum",
      venueRiskTier: "low",
      venueRiskScores: { audits: 1, centralization: 2, fundsManagement: 1, liquidity: 1, operational: 1 },
    });
    expect(sourceRisk.venueRiskWeighted).toBeCloseTo(1.3, 5);
  });

  it("treats fixed-yield Pendle rows as lending-market opportunities with reviewed venue risk", () => {
    const sourceRisk = buildYieldSourceRisk({
      source: makeSource({
        sourceKey: "protocol-api:pendle:ethereum:0xpool",
        dataSource: "protocol-api",
        yieldType: "fixed-yield",
      }),
      provenance: { sourceAgeSeconds: 300 },
      isBest: true,
    });

    expect(sourceRisk).toMatchObject({
      deploymentPlace: "lending-market",
      venueProtocol: "pendle",
      venueChain: "ethereum",
      venueRiskTier: "low",
    });
  });

  it("preserves opportunity-level risk evidence for published source-risk payloads", () => {
    const opportunityRisk = {
      opportunityClass: "lending" as const,
      underlyingSafetyScore: 82,
      opportunitySafetyScore: 77,
      opportunitySafetyPenalty: 5,
      venueReviewed: true,
      missingCriticalEvidence: [],
    };

    const sourceRisk = buildYieldSourceRisk({
      source: makeSource({
        yieldType: "lending-opportunity",
        sourceRisk: { opportunityRisk },
      }),
      provenance: { sourceAgeSeconds: 300 },
      isBest: true,
    });

    expect(sourceRisk.opportunityRisk).toEqual(opportunityRisk);
  });

  it("normalizes sourceRiskScore from the resolved sourceRiskPenalty", () => {
    const neutralSource = buildYieldSourceRisk({
      source: makeSource({ sourceRiskPenalty: 1 }),
      provenance: { sourceAgeSeconds: 300 },
      isBest: true,
    });
    expect(neutralSource.sourceRiskScore).toBe(0);

    const elevatedSource = buildYieldSourceRisk({
      source: makeSource({ sourceRiskPenalty: 1.75 }),
      provenance: { sourceAgeSeconds: 300 },
      isBest: true,
    });
    expect(elevatedSource.sourceRiskScore).toBe(50);

    const maxedSource = buildYieldSourceRisk({
      source: makeSource({ sourceRiskPenalty: 2.5 }),
      provenance: { sourceAgeSeconds: 300 },
      isBest: true,
    });
    expect(maxedSource.sourceRiskScore).toBe(100);
  });

  it("emits rewardShare 0 for a base-only payload and never a stored value (A9)", () => {
    const baseOnly = buildYieldSourceRisk({
      source: makeSource({ apyBase: 5, apyReward: null, currentApy: 5 }),
      provenance: { sourceAgeSeconds: 300 },
      isBest: true,
    });
    expect(baseOnly.rewardShare).toBe(0);

    // The same row on a previous publication stored a reward-heavy share. The
    // payload proves reward = 0, so the stored value must not be republished —
    // it would price a reward driver the row does not pay.
    const withStoredShare = buildYieldSourceRisk({
      source: makeSource({
        apyBase: 5,
        apyReward: null,
        currentApy: 5,
        sourceRisk: { rewardShare: 0.83 } as EvaluatedYieldSource["sourceRisk"],
      }),
      provenance: { sourceAgeSeconds: 300 },
      isBest: true,
    });
    expect(withStoredShare.rewardShare).toBe(0);

    // A genuine split still resolves to the derived share.
    const rewardHeavy = buildYieldSourceRisk({
      source: makeSource({ apyBase: 1, apyReward: 4, currentApy: 5 }),
      provenance: { sourceAgeSeconds: 300 },
      isBest: true,
    });
    expect(rewardHeavy.rewardShare).toBeCloseTo(0.8, 5);

    // No split and no base-only proof stays unknown rather than defaulting to 0.
    const unknownSplit = buildYieldSourceRisk({
      source: makeSource({ apyBase: 3, apyReward: null, currentApy: 5 }),
      provenance: { sourceAgeSeconds: 300 },
      isBest: true,
    });
    expect(unknownSplit.rewardShare).toBeNull();
  });

  it("resolves the wrapper venue of tracked variant children (A8)", () => {
    const resolved = buildYieldSourceRisk({
      source: makeSource({ id: "susds-sky", sourceKey: "onchain:susds-sky", dataSource: "onchain" }),
      provenance: { sourceAgeSeconds: 300 },
      isBest: true,
    });
    expect(resolved.venueProtocol).toBe("spark-savings");
    expect(resolved.venueRiskTier).toBe("low");

    // An unreviewed wrapper venue publishes the venue but keeps the tier unknown.
    for (const [id, venue] of [
      ["susde-ethena", "ethena"],
      ["sfrxusd-frax", "frax"],
      ["wsrusd-reservoir", "reservoir-protocol"],
    ] as const) {
      const sourceRisk = buildYieldSourceRisk({
        source: makeSource({ id, sourceKey: `onchain:${id}`, dataSource: "onchain" }),
        provenance: { sourceAgeSeconds: 300 },
        isBest: true,
      });
      expect(sourceRisk.venueProtocol, id).toBe(venue);
      expect(sourceRisk.venueRiskTier, id).toBe("unknown");
    }
  });

  it("resolves a parent override before the child-id map for projected wrapper rows (A8)", () => {
    const projected = buildYieldSourceRisk({
      source: makeSource({
        id: "usds-sky",
        sourceKey: "linked-variant:susds-sky:onchain:susds-sky",
        dataSource: "onchain",
        venueProtocol: "spark-savings",
      }),
      provenance: { sourceAgeSeconds: 300 },
      isBest: true,
    });
    expect(projected.venueProtocol).toBe("spark-savings");
    expect(projected.venueRiskTier).toBe("low");
  });
});

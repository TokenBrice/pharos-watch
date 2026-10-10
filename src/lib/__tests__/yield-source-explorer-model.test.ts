import { describe, expect, it } from "vitest";
import { buildYieldSourceExplorerModel } from "@/lib/yield-source-explorer-model";
import { YIELD_DECISION_REJECTION_REASON_LABELS } from "@/lib/yield-presentation";
import { buildYieldDecisionLedgerDisplay } from "@/lib/yield-decision-ledger";
import {
  SOURCE_RISK_GOLDEN_UI_DRIVER_LABELS,
  mergeSourceRiskGoldenFixtures,
} from "@shared/test-utils/yield-source-risk-golden-fixtures";
import type { AltYieldSource, YieldDecisionRejectionReasonCode, YieldRanking } from "@shared/types";
import { makeAltYieldSource, makeYieldProvenance, makeYieldRanking } from "@shared/test-utils/yield-ranking-fixtures";

function ranking(overrides: Partial<YieldRanking> = {}): YieldRanking {
  return makeYieldRanking({
    currentApy: 0.052,
    apy7d: 0.051,
    apy30d: 0.05,
    yieldSource: "Aave",
    yieldSourceUrl: null,
    yieldType: "lending-vault",
    dataSource: "defillama",
    sourceTvlUsd: 10_000_000,
    pharosYieldScore: 42,
    safetyScore: 90,
    yieldToRisk: 1,
    excessYield: 0.01,
    benchmarkRate: 0.04,
    benchmarkLabel: "T-bill",
    benchmarkSelectionMode: "native",
    benchmarkIsFallback: false,
    apyVariance30d: 0.001,
    apyMin30d: 0.04,
    apyMax30d: 0.06,
    provenance: makeYieldProvenance({
      sourceKey: "aave-usdc",
      sourceObservedAt: 1_700_000_000,
      sourceAgeSeconds: 60,
      selectionReason: "Higher confidence than retained alternates.",
      benchmarkRecordDate: null,
    }),
    ...overrides,
  });
}

describe("buildYieldSourceExplorerModel", () => {
  it("returns selected source, retained alternates, risk labels, switch metadata, and benchmark context", () => {
    const model = buildYieldSourceExplorerModel(ranking({
      sourceRisk: mergeSourceRiskGoldenFixtures([
        "reward-heavy",
        "low-source-depth",
        "stale-source-age",
        "bootstrap-observation-count",
        "source-switch-churn",
      ], { sourceRiskPenalty: 2.5 }),
      provenance: {
        sourceKey: "aave-usdc",
        sourceObservedAt: 1_700_000_000,
        sourceAgeSeconds: 60,
        sourceFreshness: "stale",
        confidenceTier: "curated",
        selectionMethod: "confidence-weighted",
        selectionReason: "Higher confidence than retained alternates.",
        sourceSwitch: true,
        previousBestSourceKey: "compound-usdc",
        usedLegacyHistory: false,
        usedDefaultSafety: false,
        benchmarkRecordDate: null,
        benchmarkIsFallback: false,
        benchmarkFallbackMode: null,
        anomalies: [],
      },
      altSources: [
        {
          sourceKey: "compound-usdc",
          yieldSource: "Compound",
          yieldSourceUrl: "https://example.com/compound",
          yieldType: "lending-vault",
          currentApy: 0.04,
          apy30d: 0.039,
          sourceTvlUsd: 20_000_000,
          dataSource: "defillama",
        },
      ],
    }));

    expect(model.selectedSource.sourceKey).toBe("aave-usdc");
    expect(model.retainedAlternates.map((source) => source.sourceKey)).toEqual(["compound-usdc"]);
    expect(model.sourceRiskDrivers.map((driver) => driver.label)).toEqual(SOURCE_RISK_GOLDEN_UI_DRIVER_LABELS);
    expect(model.sourceSwitch).toMatchObject({
      changed: true,
      previousSourceKey: "compound-usdc",
      previousSourceDisplayLabel: "Compound",
    });
    expect(model.benchmarkContext).toMatchObject({
      label: "T-bill",
      rate: 0.04,
      isFallback: false,
      selectionMode: "native",
    });
  });

  it("keeps duplicate labels identifiable and missing URLs safe", () => {
    const model = buildYieldSourceExplorerModel(ranking({
      yieldSourceUrl: undefined,
      altSources: [
        {
          sourceKey: "aave-usdt",
          yieldSource: "Aave",
          yieldSourceUrl: null,
          yieldType: "lending-vault",
          currentApy: 0.041,
          apy30d: 0.04,
          sourceTvlUsd: 5_000_000,
          dataSource: "defillama",
        },
      ],
    }));

    expect(model.selectedSource.displayLabel).toBe("Aave (aave-usdc)");
    expect(model.retainedAlternates[0]?.displayLabel).toBe("Aave (aave-usdt)");
    expect(model.sourceIdentity.url).toBeNull();
    expect(model.historySources.map((source) => source.yieldSource)).toEqual([
      "Aave (aave-usdc)",
      "Aave (aave-usdt)",
    ]);
  });

  it("does not present an unretained source key as a human-readable previous venue", () => {
    const missingKey = "75ff7280-not-retained";
    const model = buildYieldSourceExplorerModel(ranking({
      provenance: makeYieldProvenance({ sourceSwitch: true, previousBestSourceKey: missingKey }),
      altSources: [],
    }));
    expect(model.sourceSwitch.previousSourceKey).toBe(missingKey);
    expect(model.sourceSwitch.previousSourceDisplayLabel).not.toContain(missingKey);
    expect(model.sourceSwitch.previousSourceDisplayLabel).toMatch(/not retained/i);
  });
});

function altSource(overrides: Partial<AltYieldSource> & Pick<AltYieldSource, "sourceKey">): AltYieldSource {
  return makeAltYieldSource({
    yieldSource: "Alt",
    yieldSourceUrl: null,
    yieldType: "lending-vault",
    currentApy: 0.04,
    apy30d: 0.039,
    sourceTvlUsd: 10_000_000,
    dataSource: "defillama",
    sourceRisk: null,
    ...overrides,
  });
}

describe("buildYieldSourceExplorerModel — published rejection reasons", () => {
  it.each(["thinner", "stale", "rewards-only", "lower-confidence", "smaller"] as YieldDecisionRejectionReasonCode[])(
    "maps published %s without reconstructing arbitration",
    (code) => {
      const model = buildYieldSourceExplorerModel(ranking({
        altSources: [altSource({ sourceKey: "alt", rejectionReasonCode: code })],
      }));
      expect(model.retainedAlternates[0]?.rejectionHint).toMatchObject({
        code,
        label: YIELD_DECISION_REJECTION_REASON_LABELS[code],
      });
    },
  );

  it.each([undefined, "unspecified"] as const)("keeps %s reasons unavailable even with stale reward-heavy evidence", (code) => {
    const model = buildYieldSourceExplorerModel(ranking({
      altSources: [altSource({
        sourceKey: "alt",
        rejectionReasonCode: code,
        confidenceTier: "discovered",
        sourceRisk: { sourceAgeSeconds: 999999, rewardShare: 0.9 },
      })],
    }));
    expect(model.retainedAlternates[0]?.rejectionHint).toBeNull();
  });

  it("preserves published lower-confidence over a reward-heavy alternate and agrees with the ledger", () => {
    const code: YieldDecisionRejectionReasonCode = "lower-confidence";
    const alternate = altSource({
      sourceKey: "reward-alt",
      confidenceTier: "discovered",
      rejectionReasonCode: code,
      sourceRisk: { rewardShare: 0.9 },
    });
    const ledger = buildYieldDecisionLedgerDisplay({
      selectedReasonCode: "curated-over-discovered", previousBestSourceKey: null,
      sourceSwitch: false, apy30dDeltaFromPrevious: null, rejectedCount: 1,
      alternatives: [{ sourceKey: alternate.sourceKey, yieldSource: alternate.yieldSource, apy30dDelta: -0.5, rejectionReasonCode: code }],
    });
    const model = buildYieldSourceExplorerModel(ranking({
      provenance: makeYieldProvenance({ confidenceTier: "curated" }),
      altSources: [alternate],
    }));
    expect(model.retainedAlternates[0]?.rejectionHint?.code).toBe(code);
    expect(model.retainedAlternates[0]?.rejectionHint?.label).toBe(ledger?.alternatives[0]?.rejectionLabel);
  });

  it("renders the published confidence tier on alternates even when lane inference disagrees (B33)", () => {
    const model = buildYieldSourceExplorerModel(ranking({
      dataSource: "protocol-api",
      provenance: makeYieldProvenance({
        sourceKey: "primary-source", sourceObservedAt: 1_700_000_000, sourceAgeSeconds: 60,
        confidenceTier: "curated",
        selectionReason: "Higher confidence than retained alternates.", benchmarkRecordDate: null,
      }),
      sourceRisk: null,
      altSources: [
        altSource({
          sourceKey: "onchain-alt",
          dataSource: "onchain", // lane inference says "deterministic"
          confidenceTier: "discovered", // API publishes a lower tier
          rejectionReasonCode: "lower-confidence",
          sourceTvlUsd: 10_000_000,
          sourceRisk: { sourceDepthRatio: 0.05, sourceAgeSeconds: 60, rewardShare: 0 },
        }),
      ],
    }));

    // Fails pre-fix (B33): the tier was fabricated from dataSource.
    expect(model.retainedAlternates[0]?.confidenceTier).toBe("discovered");
    expect(model.retainedAlternates[0]?.rejectionHint?.code).toBe("lower-confidence");
  });

});

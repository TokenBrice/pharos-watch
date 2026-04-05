import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "../stablecoins";
import { computeTreasuryStableExposureEntity, resolveTrackedTreasuryStablecoin } from "../treasury-stable-exposure";
import type { ReportCard, TreasurySeed } from "../../types";

function makeReportCard(id: string, overallScore: number | null, overallGrade: ReportCard["overallGrade"]): ReportCard {
  return {
    id,
    name: id,
    symbol: id.toUpperCase(),
    overallGrade,
    overallScore,
    baseScore: null,
    dimensions: {
      pegStability: { grade: overallGrade, score: overallScore, detail: "" },
      liquidity: { grade: overallGrade, score: overallScore, detail: "" },
      resilience: { grade: overallGrade, score: overallScore, detail: "" },
      decentralization: { grade: overallGrade, score: overallScore, detail: "" },
      dependencyRisk: { grade: overallGrade, score: overallScore, detail: "" },
    },
    ratedDimensions: overallScore == null ? 0 : 5,
    rawInputs: {
      pegScore: null,
      activeDepeg: false,
      activeDepegBps: null,
      depegEventCount: 0,
      lastEventAt: null,
      liquidityScore: null,
      effectiveExitScore: null,
      redemptionBackstopScore: null,
      redemptionRouteFamily: null,
      redemptionModelConfidence: null,
      redemptionUsedForLiquidity: false,
      redemptionImmediateCapacityUsd: null,
      redemptionImmediateCapacityRatio: null,
      concentrationHhi: null,
      bluechipGrade: null,
      canBeBlacklisted: false,
      chainTier: "ethereum",
      deploymentModel: "single-chain",
      collateralQuality: "native",
      custodyModel: "onchain",
      governanceTier: "decentralized",
      governanceQuality: "dao-governance",
      dependencies: [],
      navToken: false,
      collateralFromLive: false,
    },
    isDefunct: false,
  };
}

function makeSeed(): TreasurySeed {
  return {
    protocolId: "test-protocol",
    slug: "test-protocol",
    name: "Test Protocol",
    category: "Protocol treasury",
    launchEligible: true,
    launchPriority: 1,
    source: "defillama-github",
    adapterFile: "test.js",
    extractionMode: "static-seeded",
    chains: ["ethereum"],
    owners: [{ chain: "ethereum", address: "0x1234" }],
  };
}

describe("treasury stable exposure normalization", () => {
  it("resolves tracked stablecoins by evm chain id and contract address", () => {
    const usdc = TRACKED_META_BY_ID.get("usdc-circle");
    const ethereumUsdc = usdc?.contracts?.find((deployment) => deployment.chain === "ethereum");
    expect(ethereumUsdc).toBeTruthy();

    const resolved = resolveTrackedTreasuryStablecoin(1, ethereumUsdc!.address);
    expect(resolved?.stablecoinId).toBe("usdc-circle");
    expect(resolved?.governance).toBe("centralized");
  });

  it("computes direct-only treasury totals, sleeve percentages, and weighted safety", () => {
    const decentralizedCoin = ACTIVE_STABLECOINS.find(
      (stablecoin) =>
        stablecoin.flags.governance === "decentralized"
        && stablecoin.contracts?.some((deployment) => deployment.chain === "ethereum"),
    );
    expect(decentralizedCoin).toBeTruthy();

    const usdc = TRACKED_META_BY_ID.get("usdc-circle");
    const usdcContract = usdc?.contracts?.find((deployment) => deployment.chain === "ethereum");
    const decentralizedContract = decentralizedCoin?.contracts?.find((deployment) => deployment.chain === "ethereum");

    expect(usdcContract).toBeTruthy();
    expect(decentralizedContract).toBeTruthy();

    const entity = computeTreasuryStableExposureEntity(
      makeSeed(),
      [
        {
          treasuryBalances: [
            { chainId: 1, tokenAddress: "native", usdValue: 3_000 },
            { chainId: 1, tokenAddress: usdcContract!.address, usdValue: 1_000 },
            { chainId: 1, tokenAddress: decentralizedContract!.address, usdValue: 500 },
            { chainId: 1, tokenAddress: "0x0000000000000000000000000000000000000bad", usdValue: 500 },
          ],
          stablecoinBalances: [
            { chainId: 1, tokenAddress: usdcContract!.address, usdValue: 1_000 },
            { chainId: 1, tokenAddress: decentralizedContract!.address, usdValue: 500 },
            { chainId: 1, tokenAddress: "0x0000000000000000000000000000000000000bad", usdValue: 250 },
          ],
        },
      ],
      [
        makeReportCard("usdc-circle", 92, "A"),
        makeReportCard(decentralizedCoin!.id, 70, "B-"),
      ],
    );

    expect(entity.directWalletUsd).toBe(5_000);
    expect(entity.treasuryUsd).toBe(5_000);
    expect(entity.coverage.denominatorStatus).toBe("direct-only");
    expect(entity.stablecoinSleeveUsd).toBe(1_750);
    expect(entity.trackedStableUsd).toBe(1_500);
    expect(entity.coverage.untrackedStableUsd).toBe(250);
    expect(entity.coverage.trackedStablePctOfStableSleeve).toBeCloseTo(85.71, 2);
    expect(entity.coverage.trackedStablePctOfTreasury).toBe(30);
    expect(entity.decentralizedStableUsd).toBe(500);
    expect(entity.decentralizedStablePctOfTreasury).toBe(10);
    expect(entity.decentralizedStablePctOfStableSleeve).toBeCloseTo(28.57, 2);
    expect(entity.weightedSafetyScore).toBeCloseTo(84.7, 1);
    expect(entity.holdings[0]?.stablecoinId).toBe("usdc-circle");
    expect(entity.holdings[1]?.stablecoinId).toBe(decentralizedCoin!.id);
    expect(entity.coverage.notes).toContain(
      "Stable-sleeve percentages include stable exposure that could not be mapped to a tracked Pharos stablecoin.",
    );
  });

  it("adjusts the treasury denominator when DeFi positions replace consumed direct balances", () => {
    const usdc = TRACKED_META_BY_ID.get("usdc-circle");
    const usdcContract = usdc?.contracts?.find((deployment) => deployment.chain === "ethereum");
    expect(usdcContract).toBeTruthy();

    const entity = computeTreasuryStableExposureEntity(
      makeSeed(),
      [
        {
          treasuryBalances: [
            {
              chainId: 1,
              tokenAddress: "0x000000000000000000000000000000000000beef",
              usdValue: 800,
              balanceKey: "0x1234:1:0x000000000000000000000000000000000000beef",
            },
            { chainId: 1, tokenAddress: "native", usdValue: 200, balanceKey: "0x1234:1:native" },
          ],
          stablecoinBalances: [
            {
              chainId: 1,
              tokenAddress: "0x000000000000000000000000000000000000beef",
              usdValue: 800,
              balanceKey: "0x1234:1:0x000000000000000000000000000000000000beef",
            },
          ],
          derivedPositions: [
            {
              positionUsd: 1_200,
              stableLegs: [
                {
                  chainId: 1,
                  tokenAddress: usdcContract!.address,
                  usdValue: 800,
                  balanceKey: `0x1234:1:${usdcContract!.address.toLowerCase()}`,
                },
              ],
              consumedBalanceKeys: ["0x1234:1:0x000000000000000000000000000000000000beef"],
            },
          ],
        },
      ],
      [makeReportCard("usdc-circle", 92, "A")],
    );

    expect(entity.directWalletUsd).toBe(1_000);
    expect(entity.treasuryUsd).toBe(1_400);
    expect(entity.coverage.denominatorStatus).toBe("adjusted-with-defi");
    expect(entity.coverage.consumedDirectBalanceUsd).toBe(800);
    expect(entity.coverage.defiPositionUsd).toBe(1_200);
    expect(entity.stablecoinSleeveUsd).toBe(800);
    expect(entity.coverage.trackedStablePctOfTreasury).toBeCloseTo(57.14, 2);
    expect(entity.coverage.notes).toContain(
      "Stable sleeve includes supported LP, vault, and lending positions decomposed to underlying stablecoins.",
    );
  });

  it("publishes sleeve-only metrics when DeFi stable exposure cannot support a treasury denominator", () => {
    const usdc = TRACKED_META_BY_ID.get("usdc-circle");
    const usdcContract = usdc?.contracts?.find((deployment) => deployment.chain === "ethereum");
    expect(usdcContract).toBeTruthy();

    const entity = computeTreasuryStableExposureEntity(
      makeSeed(),
      [
        {
          treasuryBalances: [
            { chainId: 1, tokenAddress: "0x000000000000000000000000000000000000beef", usdValue: 800 },
          ],
          stablecoinBalances: [
            { chainId: 1, tokenAddress: "0x000000000000000000000000000000000000beef", usdValue: 800 },
          ],
          derivedPositions: [
            {
              positionUsd: null,
              stableLegs: [
                {
                  chainId: 1,
                  tokenAddress: usdcContract!.address,
                  usdValue: 800,
                },
              ],
              consumedBalanceKeys: ["1:0x000000000000000000000000000000000000beef"],
              partialStableExposure: true,
            },
          ],
        },
      ],
      [makeReportCard("usdc-circle", 92, "A")],
    );

    expect(entity.directWalletUsd).toBe(800);
    expect(entity.treasuryUsd).toBeNull();
    expect(entity.coverage.denominatorStatus).toBe("partial");
    expect(entity.coverage.trackedStablePctOfTreasury).toBeNull();
    expect(entity.holdings[0]?.pctOfTreasury).toBeNull();
    expect(entity.coverage.skippedDerivedPositionCount).toBe(1);
    expect(entity.coverage.notes).toContain(
      "Treasury-relative metrics are unavailable because one or more derived positions could not be valued end to end.",
    );
  });

  it("downgrades mathematically impossible rows to invalid and filters rounded-zero holdings", () => {
    const usdc = TRACKED_META_BY_ID.get("usdc-circle");
    const usdcContract = usdc?.contracts?.find((deployment) => deployment.chain === "ethereum");
    expect(usdcContract).toBeTruthy();

    const entity = computeTreasuryStableExposureEntity(
      makeSeed(),
      [
        {
          treasuryBalances: [
            { chainId: 1, tokenAddress: "native", usdValue: 100 },
          ],
          stablecoinBalances: [
            { chainId: 1, tokenAddress: usdcContract!.address, usdValue: 200 },
            { chainId: 1, tokenAddress: usdcContract!.address, usdValue: 0.001 },
          ],
        },
      ],
      [makeReportCard("usdc-circle", 92, "A")],
    );

    expect(entity.coverage.denominatorStatus).toBe("invalid");
    expect(entity.treasuryUsd).toBeNull();
    expect(entity.decentralizedStablePctOfTreasury).toBeNull();
    expect(entity.coverage.trackedStablePctOfTreasury).toBeNull();
    expect(entity.holdings).toHaveLength(1);
    expect(entity.coverage.notes).toContain(
      "Treasury-relative metrics are suppressed because the effective treasury denominator failed validation.",
    );
  });
});

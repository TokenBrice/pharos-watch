import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockRegistry } from "../../test-helpers/cron";

vi.mock("@shared/lib/stablecoins/registry", () => {
  const stablecoins = [
    {
      id: "apyusd-apyx",
      symbol: "apyUSD",
      flags: { pegCurrency: "USD", yieldBearing: true, navToken: true },
      contracts: [{ chain: "ethereum", address: "0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a", decimals: 18 }],
      tradedContracts: [],
    },
    {
      id: "nusd-neutrl",
      symbol: "NUSD",
      flags: { pegCurrency: "USD", yieldBearing: true, navToken: false },
      contracts: [{ chain: "ethereum", address: "0xe556aba6fe6036275ec1f87eda296be72c811bce", decimals: 18 }],
      tradedContracts: [],
    },
  ];

  return mockRegistry({ stablecoins });
});

import { fetchRoycoDawnSources } from "../yield-sync/royco-dawn";

function makeVault(params: {
  address: string;
  apy: number;
  tvlUsd: number;
  depositAddress: string;
  depositSymbol: string;
  shareAddress: string;
}) {
  return {
    address: params.address,
    name: `${params.depositSymbol} vault`,
    apy: params.apy,
    tvl: { tokenAmountUsd: params.tvlUsd },
    depositToken: {
      symbol: params.depositSymbol,
      chainId: 1,
      contractAddress: params.depositAddress,
    },
    shareToken: {
      symbol: `roy${params.depositSymbol}`,
      chainId: 1,
      contractAddress: params.shareAddress,
    },
  };
}

describe("fetchRoycoDawnSources", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-03T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("emits senior and junior tranche candidates for tracked deposit tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            count: 1,
            data: [
              {
                chainId: 1,
                marketId: "0xcfbdea0990f21b103c8d123d0d5273b4ea269cb4",
                name: "Apyx apyUSD",
                listingType: "verified",
                status: "normal",
                tvlUsd: 4_600_000,
                coverage: { currentRatio: 0.36, requiredRatio: 0.15 },
                utilization: { currentRatio: 0.41, requiredRatio: 0.9 },
                drawdown: { ratio: 0 },
                totalDrawdowns: 0,
                juniorRedemptionDelay: 0,
                seniorVault: makeVault({
                  address: "0xbd373c9d3d8976a4fecc504a93c768bbe8c3227c",
                  apy: 0.099,
                  tvlUsd: 2_900_000,
                  depositAddress: "0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a",
                  depositSymbol: "apyUSD",
                  shareAddress: "0xbd373c9d3d8976a4fecc504a93c768bbe8c3227c",
                }),
                juniorVault: makeVault({
                  address: "0xab2ab53e1e2e2c5d7202918ec8c873712bcc4a2d",
                  apy: 0.136,
                  tvlUsd: 1_700_000,
                  depositAddress: "0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a",
                  depositSymbol: "apyUSD",
                  shareAddress: "0xab2ab53e1e2e2c5d7202918ec8c873712bcc4a2d",
                }),
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const candidates = await fetchRoycoDawnSources();

    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.stablecoinId)).toEqual(["apyusd-apyx", "apyusd-apyx"]);
    expect(candidates.map((candidate) => candidate.yield.sourceKey)).toEqual([
      "royco-dawn:1:0xcfbdea0990f21b103c8d123d0d5273b4ea269cb4:senior",
      "royco-dawn:1:0xcfbdea0990f21b103c8d123d0d5273b4ea269cb4:junior",
    ]);
    expect(candidates[0]?.yield).toMatchObject({
      currentApy: 9.9,
      yieldType: "structured-tranche",
      dataSource: "protocol-api",
      sourceTvlUsd: 2_900_000,
      sourceRisk: {
        trancheSide: "senior",
        marketCoverageRatio: 0.36,
        marketMinCoverageRatio: 0.15,
        marketUtilizationRatio: 0.41,
        marketStatus: "normal",
        venueRiskTier: "unknown",
        kycRequired: null,
        accessRestricted: null,
      },
    });
    expect(candidates[1]?.yield.sourceRisk?.trancheSide).toBe("junior");
  });

  it("maps Royco sNUSD deposit tokens to the tracked Neutrl USD parent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            count: 1,
            data: [
              {
                chainId: 1,
                marketId: "0x1111111111111111111111111111111111111111",
                name: "Staked Neutrl USD",
                listingType: "verified",
                status: "normal",
                tvlUsd: 2_000_000,
                coverage: { currentRatio: 0.08, requiredRatio: 0.07 },
                utilization: { currentRatio: 0.79, requiredRatio: 0.9 },
                drawdown: { ratio: 0 },
                totalDrawdowns: 0,
                juniorRedemptionDelay: 86_400,
                seniorVault: makeVault({
                  address: "0x2222222222222222222222222222222222222222",
                  apy: 0.045,
                  tvlUsd: 1_100_000,
                  depositAddress: "0x08EFCC2F3e61185D0EA7F8830B3FEc9Bfa2EE313",
                  depositSymbol: "sNUSD",
                  shareAddress: "0x2222222222222222222222222222222222222222",
                }),
                juniorVault: makeVault({
                  address: "0x3333333333333333333333333333333333333333",
                  apy: 0.087,
                  tvlUsd: 900_000,
                  depositAddress: "0x08EFCC2F3e61185D0EA7F8830B3FEc9Bfa2EE313",
                  depositSymbol: "sNUSD",
                  shareAddress: "0x3333333333333333333333333333333333333333",
                }),
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const candidates = await fetchRoycoDawnSources();

    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.stablecoinId)).toEqual(["nusd-neutrl", "nusd-neutrl"]);
    expect(candidates[1]?.yield.sourceRisk).toMatchObject({
      trancheSide: "junior",
      withdrawalDelaySeconds: 86_400,
      trancheDepositTokenAddress: "0x08efcc2f3e61185d0ea7f8830b3fec9bfa2ee313",
    });
  });

  it("resolves each tranche vault to its own tracked deposit token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            count: 1,
            data: [
              {
                chainId: 1,
                marketId: "0x4444444444444444444444444444444444444444",
                name: "Mixed deposit market",
                listingType: "verified",
                status: "normal",
                tvlUsd: 2_000_000,
                coverage: { currentRatio: 0.12, requiredRatio: 0.1 },
                utilization: { currentRatio: 0.4, requiredRatio: 0.9 },
                drawdown: { ratio: 0 },
                totalDrawdowns: 0,
                juniorRedemptionDelay: 0,
                seniorVault: makeVault({
                  address: "0x5555555555555555555555555555555555555555",
                  apy: 0.05,
                  tvlUsd: 1_200_000,
                  depositAddress: "0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a",
                  depositSymbol: "apyUSD",
                  shareAddress: "0x5555555555555555555555555555555555555555",
                }),
                juniorVault: makeVault({
                  address: "0x6666666666666666666666666666666666666666",
                  apy: 0.09,
                  tvlUsd: 800_000,
                  depositAddress: "0x08EFCC2F3e61185D0EA7F8830B3FEc9Bfa2EE313",
                  depositSymbol: "sNUSD",
                  shareAddress: "0x6666666666666666666666666666666666666666",
                }),
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const candidates = await fetchRoycoDawnSources();

    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => [candidate.yield.sourceRisk?.trancheSide, candidate.stablecoinId])).toEqual([
      ["senior", "apyusd-apyx"],
      ["junior", "nusd-neutrl"],
    ]);
  });

  it("drops tranche vaults below the tranche TVL floor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            count: 1,
            data: [
              {
                chainId: 1,
                marketId: "0x7777777777777777777777777777777777777777",
                name: "Thin junior market",
                listingType: "verified",
                status: "normal",
                tvlUsd: 2_000_000,
                coverage: { currentRatio: 0.12, requiredRatio: 0.1 },
                utilization: { currentRatio: 0.4, requiredRatio: 0.9 },
                drawdown: { ratio: 0 },
                totalDrawdowns: 0,
                juniorRedemptionDelay: 0,
                seniorVault: makeVault({
                  address: "0x8888888888888888888888888888888888888888",
                  apy: 0.05,
                  tvlUsd: 1_200_000,
                  depositAddress: "0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a",
                  depositSymbol: "apyUSD",
                  shareAddress: "0x8888888888888888888888888888888888888888",
                }),
                juniorVault: makeVault({
                  address: "0x9999999999999999999999999999999999999999",
                  apy: 0.09,
                  tvlUsd: 4_500,
                  depositAddress: "0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a",
                  depositSymbol: "apyUSD",
                  shareAddress: "0x9999999999999999999999999999999999999999",
                }),
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const candidates = await fetchRoycoDawnSources();

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.yield.sourceRisk?.trancheSide).toBe("senior");
  });
});

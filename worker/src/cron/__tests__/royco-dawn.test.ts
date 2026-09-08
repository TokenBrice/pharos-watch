import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockRegistry } from "../../test-helpers/cron";
import { makeMarket, makeVault } from "./royco-dawn.test-support";
import { mockFetch } from "@shared/test-utils/mock-fetch";

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
    mockFetch([{ match: "https://dawn.royco.org/api/v1/market/explore", body: {
            count: 1,
            data: [
              makeMarket({
                marketId: "0xcfbdea0990f21b103c8d123d0d5273b4ea269cb4",
                name: "Apyx apyUSD",
                tvlUsd: 4_600_000,
                coverage: { currentRatio: 0.36, requiredRatio: 0.15 },
                utilization: { currentRatio: 0.41, requiredRatio: 0.9 },
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
              }),
            ],
          },
        }]);

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
    mockFetch([{ match: "https://dawn.royco.org/api/v1/market/explore", body: {
            count: 1,
            data: [
              makeMarket({
                marketId: "0x1111111111111111111111111111111111111111",
                name: "Staked Neutrl USD",
                tvlUsd: 2_000_000,
                coverage: { currentRatio: 0.08, requiredRatio: 0.07 },
                utilization: { currentRatio: 0.79, requiredRatio: 0.9 },
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
              }),
            ],
          },
        }]);

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
    mockFetch([{ match: "https://dawn.royco.org/api/v1/market/explore", body: {
            count: 1,
            data: [
              makeMarket({
                marketId: "0x4444444444444444444444444444444444444444",
                name: "Mixed deposit market",
                tvlUsd: 2_000_000,
                coverage: { currentRatio: 0.12, requiredRatio: 0.1 },
                utilization: { currentRatio: 0.4, requiredRatio: 0.9 },
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
              }),
            ],
          },
        }]);

    const candidates = await fetchRoycoDawnSources();

    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => [candidate.yield.sourceRisk?.trancheSide, candidate.stablecoinId])).toEqual([
      ["senior", "apyusd-apyx"],
      ["junior", "nusd-neutrl"],
    ]);
  });

  it("drops tranche vaults below the tranche TVL floor", async () => {
    mockFetch([{ match: "https://dawn.royco.org/api/v1/market/explore", body: {
            count: 1,
            data: [
              makeMarket({
                marketId: "0x7777777777777777777777777777777777777777",
                name: "Thin junior market",
                tvlUsd: 2_000_000,
                coverage: { currentRatio: 0.12, requiredRatio: 0.1 },
                utilization: { currentRatio: 0.4, requiredRatio: 0.9 },
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
              }),
            ],
          },
        }]);

    const candidates = await fetchRoycoDawnSources();

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.yield.sourceRisk?.trancheSide).toBe("senior");
  });
});

describe("Royco discovery boundaries", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requests distinct pages and retains candidates from both", async () => {
    const pages: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (String(url) !== "https://dawn.royco.org/api/v1/market/explore") throw new Error("unexpected URL");
      const index = JSON.parse(init.body).page.index;
      pages.push(index);
      return Response.json({ count: 101, data: index === 0 ? Array.from({ length: 100 }, (_, i) => makeMarket({ marketId: `first-${i}` })) : [makeMarket({ marketId: "last" })] });
    }));
    const result = await fetchRoycoDawnSources();
    expect(pages).toEqual([0, 1]);
    expect(result.map((candidate) => candidate.yield.sourceKey)).toEqual([...Array.from({ length: 100 }, (_, i) => `royco-dawn:1:first-${i}:senior`), "royco-dawn:1:last:senior"]);
  });

  it("retains earlier candidates when a later page fails", async () => {
    const pages: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const index = JSON.parse(init.body).page.index;
      pages.push(index);
      return index === 0 ? Response.json({ count: 101, data: [makeMarket({ marketId: "survivor" }), ...Array.from({ length: 99 }, () => makeMarket({ listingType: "unverified" }))] }) : new Response("unavailable", { status: 503 });
    }));
    expect((await fetchRoycoDawnSources()).map((candidate) => candidate.yield.sourceKey)).toEqual(["royco-dawn:1:survivor:senior"]);
    expect(pages).toEqual([0, 1]);
  });

  it("rejects caller cancellation during a request", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => {
      controller.abort(new Error("cancelled by caller"));
      throw controller.signal.reason;
    }));
    await expect(fetchRoycoDawnSources(controller.signal)).rejects.toThrow("cancelled by caller");
  });

  it("rejects unverified and unknown chain or token markets", async () => {
    const valid = makeMarket();
    mockFetch([{ match: "https://dawn.royco.org/api/v1/market/explore", body: { count: 3, data: [
      makeMarket({ listingType: "unverified" }), makeMarket({ chainId: 99999999 }),
      makeMarket({ seniorVault: { ...valid.seniorVault, depositToken: { ...valid.seniorVault.depositToken, contractAddress: "0x9999999999999999999999999999999999999999" } } }),
    ] } }]);
    expect(await fetchRoycoDawnSources()).toEqual([]);
  });

  it("accepts exact APY and TVL bounds but rejects values beyond them", async () => {
    const valid = makeMarket();
    mockFetch([{ match: "https://dawn.royco.org/api/v1/market/explore", body: { count: 3, data: [
      makeMarket({ marketId: "boundary", seniorVault: { ...valid.seniorVault, apy: 2 } }),
      makeMarket({ marketId: "high-apy", seniorVault: { ...valid.seniorVault, apy: 2.0001 } }),
      makeMarket({ marketId: "low-tvl", seniorVault: { ...valid.seniorVault, tvl: { tokenAmountUsd: 99_999 } } }),
    ] } }]);
    const result = await fetchRoycoDawnSources();
    expect(result.map((candidate) => candidate.yield.sourceKey)).toEqual(["royco-dawn:1:boundary:senior"]);
    expect(result[0].yield).toMatchObject({ currentApy: 200, sourceTvlUsd: 100_000 });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContractDeployment } from "@shared/types/core";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { crawlTezosPoolsStage } from "../crawl-tezos-pools";
import { createCrawlStageContext } from "../staged-pool";
import type { StagedPool } from "../types";

const UUSD_ADDRESS = "KT1XRPEPXbZK25r3Htzp2o1x7xdMMmfocKNW";
const USDT_ADDRESS = "KT1XnTn74bUtxHfDtBmm2bGZAQfhPbvKWR8o";
const POOL_ADDRESS = "KT1UJBvm4hv11Uvu6r4c8zE5K2EfmwiRVgsm";

function target(address = UUSD_ADDRESS): ContractDeployment {
  return { chain: "tezos", address, decimals: 12 };
}

function context(options?: { stablecoinId?: string; deadlineMs?: number }) {
  const pools: StagedPool[] = [];
  return {
    pools,
    value: createCrawlStageContext({
      stablecoinId: options?.stablecoinId ?? "uusd-youves",
      knownPoolIds: new Set(),
      nowSec: 1_800_000_000,
      pools,
      priceObs: [],
      deadlineMs: options?.deadlineMs,
      references: {
        rates: {},
        type: "fresh",
        updatedAt: 1_800_000_000,
      },
    }),
  };
}

function balanceRow(
  account: string,
  alias: string,
  tokenContract: string,
  tokenId: string,
  balance: string,
  symbol: string,
  decimals: string,
) {
  return {
    account: { address: account, alias },
    balance,
    token: {
      contract: { address: tokenContract },
      tokenId,
      metadata: { symbol, decimals },
    },
  };
}

function mockCensus(holderRows: unknown[], reserveRows: unknown) {
  return mockFetch([
    {
      match: (request) => {
        const url = new URL(request.url);
        return url.pathname === "/v1/tokens/balances" && url.searchParams.has("token.contract");
      },
      body: holderRows,
    },
    {
      match: (request) => {
        const url = new URL(request.url);
        return url.pathname === "/v1/tokens/balances" && url.searchParams.has("account.in");
      },
      body: reserveRows,
    },
  ], { requireMatch: true });
}

describe("Tezos uUSD pool discovery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("discovers holder contracts and emits a staged stable pool from current token reserves", async () => {
    const fetchMock = mockCensus(
      [{ account: { address: POOL_ADDRESS, alias: "uUSD/USDT FlatYouves" }, balance: "20000000000000000" }],
      [
        balanceRow(POOL_ADDRESS, "uUSD/USDT FlatYouves", UUSD_ADDRESS, "0", "20000000000000000", "uUSD", "12"),
        balanceRow(POOL_ADDRESS, "uUSD/USDT FlatYouves", USDT_ADDRESS, "0", "15000000000", "USDt", "6"),
      ],
    );
    const stageContext = context();

    const result = await crawlTezosPoolsStage({
      coinTargets: [target()],
      context: stageContext.value,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      providerChecks: [
        {
          chain: "tezos",
          address: UUSD_ADDRESS,
          provider: "tezos",
          status: "success",
          observedPoolCount: 1,
        },
      ],
    });
    expect(stageContext.pools).toHaveLength(1);
    expect(stageContext.pools[0]).toMatchObject({
      poolId: `tezos:${POOL_ADDRESS}`,
      stablecoinId: "uusd-youves",
      source: "tezos",
      chain: "tezos",
      protocol: "youves-flat",
      dexId: "flatyouves",
      symbol: "uUSD / USDt",
      tvlUsd: 30000,
      priceUsd: 0.75,
      poolType: "tezos-flat-curve",
      baseToken: UUSD_ADDRESS,
      quoteToken: USDT_ADDRESS,
      quoteSymbol: "USDt",
    });
  });

  it("records a completed sub-floor census as an honest verified-empty result", async () => {
    const fetchMock = mockCensus(
      [{ account: { address: POOL_ADDRESS, alias: "uUSD/USDT FlatYouves" }, balance: "1000000000000" }],
      [
        balanceRow(POOL_ADDRESS, "uUSD/USDT FlatYouves", UUSD_ADDRESS, "0", "1000000000000", "uUSD", "12"),
        balanceRow(POOL_ADDRESS, "uUSD/USDT FlatYouves", USDT_ADDRESS, "0", "900000", "USDt", "6"),
      ],
    );
    const stageContext = context();

    const result = await crawlTezosPoolsStage({ coinTargets: [target()], context: stageContext.value });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.providerChecks).toEqual([
      {
        chain: "tezos",
        address: UUSD_ADDRESS,
        provider: "tezos",
        status: "success",
        observedPoolCount: 0,
      },
    ]);
    expect(stageContext.pools).toEqual([]);
  });

  it("fails closed when the reserve census response is malformed", async () => {
    mockCensus(
      [{ account: { address: POOL_ADDRESS, alias: "uUSD/USDT FlatYouves" }, balance: "20000000000000000" }],
      { malformed: true },
    );
    const stageContext = context();

    const result = await crawlTezosPoolsStage({ coinTargets: [target()], context: stageContext.value });

    expect(result.providerChecks).toEqual([
      {
        chain: "tezos",
        address: UUSD_ADDRESS,
        provider: "tezos",
        status: "failure",
      },
    ]);
    expect(stageContext.pools).toEqual([]);
  });

  it("does not certify a pool whose non-USD reserve cannot be valued", async () => {
    const fetchMock = mockCensus(
      [{ account: { address: POOL_ADDRESS, alias: "Vortex uUSD-XTZ DEX" }, balance: "20000000000000000" }],
      [balanceRow(POOL_ADDRESS, "Vortex uUSD-XTZ DEX", UUSD_ADDRESS, "0", "20000000000000000", "uUSD", "12")],
    );
    const stageContext = context();

    const result = await crawlTezosPoolsStage({ coinTargets: [target()], context: stageContext.value });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.providerChecks).toEqual([
      {
        chain: "tezos",
        address: UUSD_ADDRESS,
        provider: "tezos",
        status: "degraded",
        observedPoolCount: 0,
      },
    ]);
    expect(stageContext.pools).toEqual([]);
  });
  it("keeps an unlabeled contract holder degraded instead of certifying empty", async () => {
    mockCensus(
      [{ account: { address: POOL_ADDRESS }, balance: "20000000000000000" }],
      [balanceRow(POOL_ADDRESS, "", UUSD_ADDRESS, "0", "20000000000000000", "uUSD", "12")],
    );
    const stageContext = context();

    const result = await crawlTezosPoolsStage({ coinTargets: [target()], context: stageContext.value });

    expect(result.providerChecks).toEqual([
      {
        chain: "tezos",
        address: UUSD_ADDRESS,
        provider: "tezos",
        status: "degraded",
        observedPoolCount: 0,
      },
    ]);
    expect(stageContext.pools).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContractDeployment } from "@shared/types/core";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { createCrawlStageContext } from "../staged-pool";
import {
  crawlCosmosPoolsStage,
  isNobleSwapDiscoveryDeployment,
  isOsmosisSqsDiscoveryDeployment,
  resetCosmosDiscoveryStateForTests,
} from "../crawl-cosmos-pools";
import type { StagedPool } from "../types";

const OSMOSIS_USDX_DENOM = "ibc/C78F65E1648A3DFE0BAEB6C4CDA69CC2A75437F1793C0E6386DFDA26393790AE";
const OSMOSIS_OSMO_DENOM = "uosmo";
const OSMOSIS_POOLS_URL = `https://sqsprod.osmosis.zone/pools?filter%5Bdenom%5D=${encodeURIComponent(
  OSMOSIS_USDX_DENOM,
)}`;
const NOBLE_POOLS_URL = "https://api.noble.xyz/noble/swap/v1/pools";

function osmosisTarget(address = OSMOSIS_USDX_DENOM): ContractDeployment {
  return { chain: "osmosis", address, decimals: 6 };
}

function nobleTarget(address = "uusdn"): ContractDeployment {
  return { chain: "noble", address, decimals: 6 };
}

function context(stablecoinId = "usdx-kava") {
  const pools: StagedPool[] = [];
  return {
    pools,
    value: createCrawlStageContext({
      stablecoinId,
      knownPoolIds: new Set<string>(),
      nowSec: 1_800_000_000,
      pools,
      priceObs: [],
    }),
  };
}

function osmosisPool(options: {
  id: number;
  liquidityCap: string;
  denoms?: string[];
  type?: number;
  spreadFactor?: string;
  liquidityCapError?: string;
}) {
  const denoms = options.denoms ?? [OSMOSIS_USDX_DENOM, OSMOSIS_OSMO_DENOM];
  return {
    chain_model: {
      address: `osmo1pool${options.id}`,
      id: options.id,
      pool_assets: denoms.map((denom) => ({ token: { denom, amount: "1000" }, weight: "1" })),
    },
    balances: denoms.map((denom) => ({ denom, amount: "1000" })),
    type: options.type ?? 0,
    spread_factor: options.spreadFactor ?? "0.002000000000000000",
    liquidity_cap: options.liquidityCap,
    liquidity_cap_error: options.liquidityCapError ?? "",
  };
}

function noblePool(id: string, denoms: string[]) {
  return {
    id,
    address: `noble1pool${id}`,
    algorithm: "STABLESWAP",
    liquidity: denoms.map((denom) => ({ denom, amount: "1000000" })),
  };
}

beforeEach(() => {
  resetCosmosDiscoveryStateForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetCosmosDiscoveryStateForTests();
});

describe("Osmosis sidecar pool discovery", () => {
  it("stages only pools at or above the retained-pool floor and reports the observed count", async () => {
    const retained = osmosisPool({ id: 1926, liquidityCap: "2572405", type: 2 });
    const dust = osmosisPool({ id: 792, liquidityCap: "2" });
    const fetchMock = mockFetch(
      [{ match: OSMOSIS_POOLS_URL, body: { data: [retained, dust], meta: { total_items: 2 } } }],
      { requireMatch: true, strictUrl: true },
    );
    const stageContext = context();

    const result = await crawlCosmosPoolsStage({
      coinTargets: [osmosisTarget()],
      context: stageContext.value,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      providerChecks: [
        {
          chain: "osmosis",
          address: OSMOSIS_USDX_DENOM,
          provider: "osmosis-sqs",
          status: "success",
          observedPoolCount: 1,
        },
      ],
    });
    expect(stageContext.pools).toHaveLength(1);
    expect(stageContext.pools[0]).toMatchObject({
      poolId: "osmosis:1926",
      stablecoinId: "usdx-kava",
      source: "osmosis-sqs",
      chain: "osmosis",
      protocol: "osmosis",
      dexId: "osmosis",
      symbol: "ibc/C78F65E1 / uosmo",
      tvlUsd: 2_572_405,
      poolType: "osmosis-concentrated",
      feeTier: 20,
      baseToken: OSMOSIS_USDX_DENOM,
      quoteToken: OSMOSIS_OSMO_DENOM,
      quoteSymbol: "uosmo",
      priceUsd: null,
      volume24h: null,
      balanceRatio: null,
    });
  });

  it("certifies a completed empty census when every pool sits below the floor", async () => {
    mockFetch(
      [
        {
          match: OSMOSIS_POOLS_URL,
          body: {
            data: [
              osmosisPool({ id: 1390, liquidityCap: "274" }),
              osmosisPool({ id: 792, liquidityCap: "2" }),
            ],
            meta: { total_items: 2 },
          },
        },
      ],
      { requireMatch: true, strictUrl: true },
    );
    const stageContext = context();

    const result = await crawlCosmosPoolsStage({
      coinTargets: [osmosisTarget()],
      context: stageContext.value,
    });

    expect(result.providerChecks).toEqual([
      {
        chain: "osmosis",
        address: OSMOSIS_USDX_DENOM,
        provider: "osmosis-sqs",
        status: "success",
        observedPoolCount: 0,
      },
    ]);
    expect(stageContext.pools).toEqual([]);
  });

  it("keeps a partially priced pool when the sidecar could not price the counterpart leg", async () => {
    mockFetch(
      [
        {
          match: OSMOSIS_POOLS_URL,
          body: {
            data: [
              osmosisPool({
                id: 3573,
                liquidityCap: "45000",
                liquidityCapError: "zero cap for denom (ibc/DEADBEEF)",
                type: 1,
              }),
            ],
            meta: { total_items: 1 },
          },
        },
      ],
      { requireMatch: true, strictUrl: true },
    );
    const stageContext = context();

    const result = await crawlCosmosPoolsStage({
      coinTargets: [osmosisTarget()],
      context: stageContext.value,
    });

    expect(result.providerChecks[0]).toMatchObject({ status: "success", observedPoolCount: 1 });
    expect(stageContext.pools[0]).toMatchObject({
      poolId: "osmosis:3573",
      tvlUsd: 45_000,
      poolType: "osmosis-stableswap",
      isStable: true,
    });
  });

  it("does not certify an empty census when a returned pool cannot corroborate the denom", async () => {
    mockFetch(
      [
        {
          match: OSMOSIS_POOLS_URL,
          body: {
            data: [osmosisPool({ id: 5, liquidityCap: "500000", denoms: ["uatom", OSMOSIS_OSMO_DENOM] })],
            meta: { total_items: 1 },
          },
        },
      ],
      { requireMatch: true, strictUrl: true },
    );
    const stageContext = context();

    const result = await crawlCosmosPoolsStage({
      coinTargets: [osmosisTarget()],
      context: stageContext.value,
    });

    expect(result.providerChecks).toEqual([
      {
        chain: "osmosis",
        address: OSMOSIS_USDX_DENOM,
        provider: "osmosis-sqs",
        status: "degraded",
      },
    ]);
    expect(stageContext.pools).toEqual([]);
  });

  it("does not certify an empty census when the sidecar response is malformed", async () => {
    mockFetch([{ match: OSMOSIS_POOLS_URL, body: { data: [{ chain_model: {} }] } }], {
      requireMatch: true,
      strictUrl: true,
    });
    const stageContext = context();

    const result = await crawlCosmosPoolsStage({
      coinTargets: [osmosisTarget()],
      context: stageContext.value,
    });

    expect(result.providerChecks).toEqual([
      {
        chain: "osmosis",
        address: OSMOSIS_USDX_DENOM,
        provider: "osmosis-sqs",
        status: "degraded",
      },
    ]);
  });

  it("marks a 5xx sidecar response as a retryable failure rather than a hard outage", async () => {
    mockFetch([{ match: OSMOSIS_POOLS_URL, body: { error: "bad gateway" }, status: 502 }], {
      requireMatch: true,
      strictUrl: true,
    });
    const stageContext = context();

    const result = await crawlCosmosPoolsStage({
      coinTargets: [osmosisTarget()],
      context: stageContext.value,
    });

    expect(result.providerChecks).toEqual([
      {
        chain: "osmosis",
        address: OSMOSIS_USDX_DENOM,
        provider: "osmosis-sqs",
        status: "failure",
        retryable: true,
      },
    ]);
  });
});

describe("Noble swap-module pool discovery", () => {
  it("reads the module once and answers every tracked Noble deployment", async () => {
    const fetchMock = mockFetch(
      [{ match: NOBLE_POOLS_URL, body: { pools: [noblePool("0", ["uusdc", "uusdn"])] } }],
      { requireMatch: true, strictUrl: true },
    );
    const stageContext = context("usdn-noble");

    const result = await crawlCosmosPoolsStage({
      coinTargets: [nobleTarget("uusdn"), nobleTarget("ausdy")],
      context: stageContext.value,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.providerChecks).toEqual([
      {
        chain: "noble",
        address: "uusdn",
        provider: "noble-swap",
        status: "success",
        observedPoolCount: 1,
      },
      {
        chain: "noble",
        address: "ausdy",
        provider: "noble-swap",
        status: "success",
        observedPoolCount: 0,
      },
    ]);
    expect(stageContext.pools).toHaveLength(1);
    expect(stageContext.pools[0]).toMatchObject({
      poolId: "noble:0",
      source: "noble-swap",
      chain: "noble",
      protocol: "noble-swap",
      dexId: "noble-swap",
      symbol: "uusdn / uusdc",
      poolType: "noble-stableswap",
      isStable: true,
      tvlUsd: null,
      priceUsd: null,
      baseToken: "uusdn",
      quoteToken: "uusdc",
    });
  });

  it("does not certify an empty census when the module response is malformed", async () => {
    mockFetch([{ match: NOBLE_POOLS_URL, body: { pools: [{ id: "0" }] } }], {
      requireMatch: true,
      strictUrl: true,
    });
    const stageContext = context("usdn-noble");

    const result = await crawlCosmosPoolsStage({
      coinTargets: [nobleTarget()],
      context: stageContext.value,
    });

    expect(result.providerChecks).toEqual([
      { chain: "noble", address: "uusdn", provider: "noble-swap", status: "degraded" },
    ]);
    expect(stageContext.pools).toEqual([]);
  });

  it("treats a removed module route as a non-retryable provider failure", async () => {
    mockFetch([{ match: NOBLE_POOLS_URL, body: { code: 5, message: "Not Found" }, status: 404 }], {
      requireMatch: true,
      strictUrl: true,
    });
    const stageContext = context("usdn-noble");

    const result = await crawlCosmosPoolsStage({
      coinTargets: [nobleTarget()],
      context: stageContext.value,
    });

    expect(result.providerChecks).toEqual([
      { chain: "noble", address: "uusdn", provider: "noble-swap", status: "failure" },
    ]);
  });
});

describe("Cosmos census registration", () => {
  it("issues no request for a coin with no Osmosis or Noble deployment", async () => {
    const fetchMock = mockFetch([], { requireMatch: false });
    const stageContext = context();

    const result = await crawlCosmosPoolsStage({
      coinTargets: [{ chain: "ethereum", address: "0x0000000000000000000000000000000000000001", decimals: 6 }],
      context: stageContext.value,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ providerChecks: [] });
  });

  it("never routes a MANTRA Cosmos denom to an Osmosis or Noble index", () => {
    const mantraIbc = "ibc/6749D16BC09F419C090C330FC751FFF1C96143DB7A4D2FCAEC2F348A3E17618A";
    expect(isOsmosisSqsDiscoveryDeployment("mantra", mantraIbc)).toBe(false);
    expect(isNobleSwapDiscoveryDeployment("mantra", mantraIbc)).toBe(false);
    expect(isOsmosisSqsDiscoveryDeployment("osmosis", mantraIbc)).toBe(true);
  });
});

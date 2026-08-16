import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "../../test-helpers/__shared/mock-fetch";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { DECIMALS_SELECTOR, LATEST_ROUND_DATA_SELECTOR } from "../../lib/evm-selectors";
import { fetchMidasMmevNavOracleSource } from "../yield-sync/midas-mmev-nav-oracle";

const MIDAS_MMEV_NAV_ORACLE = "0x5f09Aff8B9b1f488B7d1bbaD4D89648579e55d61";
const NOW_SEC = 1_780_000_000;

function makeChainRpcs(): Map<string, ChainRpcConfig> {
  return new Map([[
    "ethereum",
    {
      chainId: "ethereum",
      chainName: "Ethereum",
      type: "evm",
      rpcUrl: "https://rpc.ethereum.test",
      explorerUrl: "https://etherscan.io",
    },
  ]]);
}

function encodeWord(value: bigint | number): string {
  return BigInt(value).toString(16).padStart(64, "0");
}

function encodeLatestRoundData(answer: bigint, updatedAt: number): `0x${string}` {
  return `0x${[
    encodeWord(1n),
    encodeWord(answer),
    encodeWord(0n),
    encodeWord(updatedAt),
    encodeWord(1n),
  ].join("")}` as `0x${string}`;
}

function mockMidasRpc(params: {
  decimals?: bigint;
  answer: bigint;
  updatedAt: number;
}): ReturnType<typeof mockFetch> {
  const fetchSpy = mockFetch([
    {
      match: "https://rpc.ethereum.test",
      respond: async (request) => {
        const body = await request.clone().json() as {
      params?: Array<{ to?: string; data?: string }>;
        };
    const call = body.params?.[0];
    if (call?.to !== MIDAS_MMEV_NAV_ORACLE) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" }), { status: 200 });
    }
    if (call.data === DECIMALS_SELECTOR) {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: `0x${encodeWord(params.decimals ?? 8n)}`,
      }), { status: 200 });
    }
    if (call.data === LATEST_ROUND_DATA_SELECTOR) {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: encodeLatestRoundData(params.answer, params.updatedAt),
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" }), { status: 200 });
      },
    },
  ], { requireMatch: true });
  return fetchSpy;
}

describe("fetchMidasMmevNavOracleSource", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("emits a deterministic NAV-appreciation candidate from a fresh mMEV oracle round", async () => {
    const updatedAt = NOW_SEC - 60 * 60;
    const fetchSpy = mockMidasRpc({ answer: 104_200_000n, updatedAt });

    const result = await fetchMidasMmevNavOracleSource({
      prevExchangeRate: 1.03,
      daysDelta: 7,
      comparisonAnchorObservedAt: NOW_SEC - 7 * 86_400,
      chainRpcs: makeChainRpcs(),
      nowSec: NOW_SEC,
    });

    expect(result).toEqual(expect.objectContaining({
      stablecoinId: "mmev-midas",
      symbol: "mMEV",
      chain: "ethereum",
      address: "0x030b69280892c888670edcdcd8b69fd8026a0bf3",
    }));
    expect(result?.yield).toEqual(expect.objectContaining({
      dataSource: "protocol-api",
      exchangeRate: expect.closeTo(1.042, 6),
      sourceKey: "protocol-api:midas-mmev-nav-oracle",
      sourcePool: MIDAS_MMEV_NAV_ORACLE,
      yieldSource: "Midas mMEV/USD Oracle",
      yieldType: "nav-appreciation",
      sourceObservedAt: updatedAt,
      comparisonAnchorObservedAt: NOW_SEC - 7 * 86_400,
    }));
    expect(result?.yield.currentApy).toBeGreaterThan(0);
    expect(result?.yield.apyBase).toBe(result?.yield.currentApy);

    const requestDatas = fetchSpy.mock.calls.map(([, init]) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { params?: Array<{ data?: string }> };
      return body.params?.[0]?.data;
    });
    expect(requestDatas).toEqual(expect.arrayContaining([DECIMALS_SELECTOR, LATEST_ROUND_DATA_SELECTOR]));
  });

  it("returns a seed candidate when no prior NAV anchor is available", async () => {
    mockMidasRpc({ answer: 104_200_000n, updatedAt: NOW_SEC - 60 });

    const result = await fetchMidasMmevNavOracleSource({
      chainRpcs: makeChainRpcs(),
      nowSec: NOW_SEC,
    });

    expect(result?.yield).toEqual(expect.objectContaining({
      currentApy: 0,
      apyBase: null,
      exchangeRate: expect.closeTo(1.042, 6),
      comparisonAnchorObservedAt: null,
    }));
  });

  it("returns null when the oracle round is stale", async () => {
    mockMidasRpc({ answer: 104_200_000n, updatedAt: NOW_SEC - 3 * 86_400 - 1 });

    await expect(fetchMidasMmevNavOracleSource({
      chainRpcs: makeChainRpcs(),
      nowSec: NOW_SEC,
    })).resolves.toBeNull();
  });

  it("returns null when the latest answer is not positive", async () => {
    mockMidasRpc({ answer: 0n, updatedAt: NOW_SEC - 60 });

    await expect(fetchMidasMmevNavOracleSource({
      chainRpcs: makeChainRpcs(),
      nowSec: NOW_SEC,
    })).resolves.toBeNull();
  });
});

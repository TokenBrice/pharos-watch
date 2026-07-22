import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSunSwapPools, parseSunSwapV2Pool } from "../fetch-sunswap";

const POOL = "TFGDbUyP8xez44C76fin3bn3Ss6jugoUwJ";
const WTRX = "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR";
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

function row(overrides: Record<string, unknown> = {}) {
  return {
    protocol: "V2",
    poolAddress: POOL,
    poolType: "2pool",
    contractIndex: 1,
    feeRate: 0.003,
    tokenAddressList: [WTRX, USDT],
    tokenAmountList: ["141334853.510414", "46475941.487844"],
    tokenAmountVol1dList: ["2246535.492642", "737800.059857"],
    reserveUsd: 92_836_495,
    volumeUsd1d: 738_928,
    tokenSymbolList: ["WTRX", "USDT"],
    tokenDecimalList: [6, 6],
    tokenPriceUsdList: [0.3284, 0.9995],
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("parseSunSwapV2Pool", () => {
  it("maps a canonical two-token V2 row with normalized balances", () => {
    expect(parseSunSwapV2Pool(row())).toMatchObject({
      source: "sunswap",
      chain: "tron",
      poolAddress: POOL,
      poolType: "sunswap-v2",
      feeRate: 0.003,
      balancesNormalized: true,
      balances: [141334853.510414, 46475941.487844],
    });
  });

  it("rejects non-V2 fees, invalid identities, and rows below the liquidity floor", () => {
    expect(parseSunSwapV2Pool(row({ feeRate: 0.0005 }))).toBeNull();
    expect(parseSunSwapV2Pool(row({ poolAddress: "not-a-tron-address" }))).toBeNull();
    expect(parseSunSwapV2Pool(row({ reserveUsd: 9_999 }))).toBeNull();
  });
});

describe("fetchSunSwapPools", () => {
  it("scans by monotonically increasing contract index until hasMore is false", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        msg: "SUCCESS",
        data: { list: [row({ contractIndex: 7 })], meta: { hasMore: true, returnSize: 1 } },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        msg: "SUCCESS",
        data: { list: [row({ contractIndex: 9, poolAddress: "TRaQussyGeM6rhRGM3wfEj3B8vofTJj3EB" })], meta: { hasMore: false, returnSize: 1 } },
      })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchSunSwapPools();

    expect(result).toMatchObject({ ok: true, degraded: false, pagination: { state: "complete", pagesFetched: 2 } });
    expect(result.pools).toHaveLength(2);
    expect(fetchMock.mock.calls[0]![0]).toContain("pageSize=100");
    expect(fetchMock.mock.calls[1]![0]).toContain("contractIndex=7");
  });

  it("stops at the 60-page census cap with a resumable degraded result", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const contractIndex = Number(new URL(url).searchParams.get("contractIndex"));
      return new Response(JSON.stringify({
        code: 0,
        msg: "SUCCESS",
        data: {
          list: [row({ contractIndex: contractIndex + 1 })],
          meta: { hasMore: true, returnSize: 1 },
        },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchSunSwapPools();

    expect(fetchMock).toHaveBeenCalledTimes(60);
    expect(result).toMatchObject({ ok: true, degraded: true, pagination: { state: "partial", pagesFetched: 60 } });
    expect(result.errors).toContain("pagination cap reached; resumeFromContractIndex=60");
  });

  it("fails closed when the scan cursor does not advance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      msg: "SUCCESS",
      data: { list: [row({ contractIndex: 0 })], meta: { hasMore: true, returnSize: 1 } },
    }))));

    const result = await fetchSunSwapPools();
    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.errors).toContain("page 1 did not advance contractIndex");
  });
});

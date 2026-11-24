import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";

const fetchEvmBlockNumberMock = vi.fn();
const fetchEvmBlockTimestampMock = vi.fn();
const fetchEvmRpcBatchMock = vi.fn();

vi.mock("../evm-rpc", async (importOriginal) => ({
  ...await importOriginal<typeof import("../evm-rpc")>(),
  fetchEvmBlockNumber: (...args: unknown[]) => fetchEvmBlockNumberMock(...args),
  fetchEvmBlockTimestamp: (...args: unknown[]) => fetchEvmBlockTimestampMock(...args),
  fetchEvmRpcBatch: (...args: unknown[]) => fetchEvmRpcBatchMock(...args),
}));

import {
  fetchStbtCurvePoolPrice,
  stbtCurvePoolProvider,
} from "../authoritative-price-sources/stbt-curve-pool";
import type { LivePriceContext } from "../authoritative-price-sources/helpers";

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const STBT = "0x530824da86689c9c17cdc2871ff29b058345b44a";
const CRV3 = "0x6c3f90f043a72fa612cbac8115ee7e52bde6e490";
// 2026-10-31 review pin: the metapool held ~317,690 STBT against ~91,514 3Crv.
// Its STBT -> 3Crv get_dy was ~0.9572, and redeeming that base LP priced
// get_dy_underlying(0, 2) at ~0.994 USDC per STBT; 1-versus-10 STBT public sell
// routes produced 0.99439 and 0.99412 USDC.
const PINNED_STBT_BALANCE = 317_689_503_690_088_755_058_052n;
const PINNED_CRV3_BALANCE = 91_514_210_472_296_804_462_841n;
const PINNED_SMALL_QUOTE = 994_390n;
const PINNED_IMPACT_QUOTE = 9_941_196n;
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const addressWord = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}` as `0x${string}`;
const uintResult = (value: bigint) => `0x${word(value)}` as `0x${string}`;

function trustedUsdc(observedAgoSec = 0, price = 1): PeggedAsset {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: "usdc-circle",
    symbol: "USDC",
    price,
    priceSource: "coingecko+defillama-list",
    priceConfidence: "high",
    priceObservedAt: now - observedAgoSec,
    priceObservedAtMode: "local_fetch",
    priceSyncedAt: now,
  } as PeggedAsset;
}

function healthyPool(overrides: {
  coin0?: string;
  coin1?: string;
  stbtBalance?: bigint;
  crv3Balance?: bigint;
  smallOutput?: bigint;
  impactOutput?: bigint;
} = {}) {
  return [
    addressWord(overrides.coin0 ?? STBT),
    addressWord(overrides.coin1 ?? CRV3),
    uintResult(overrides.stbtBalance ?? PINNED_STBT_BALANCE),
    uintResult(overrides.crv3Balance ?? PINNED_CRV3_BALANCE),
    uintResult(overrides.smallOutput ?? PINNED_SMALL_QUOTE),
    uintResult(overrides.impactOutput ?? PINNED_IMPACT_QUOTE),
  ];
}

function mockHealthyPool(overrides?: Parameters<typeof healthyPool>[0]): void {
  fetchEvmRpcBatchMock.mockResolvedValue(healthyPool(overrides));
}

const ctx = (observedAgoSec = 0, price = 1): LivePriceContext => ({
  assetsById: new Map([["usdc-circle", trustedUsdc(observedAgoSec, price)]]),
});

describe("STBT exact Curve metapool price", () => {
  beforeEach(() => {
    fetchEvmBlockNumberMock.mockReset().mockResolvedValue(26_313_576);
    fetchEvmBlockTimestampMock.mockReset().mockResolvedValue(Math.floor(Date.now() / 1000) - 12);
    fetchEvmRpcBatchMock.mockReset();
  });

  it("accepts a fresh identity-bound metapool quote as fallback display evidence", async () => {
    mockHealthyPool();
    await expect(fetchStbtCurvePoolPrice(ctx())).resolves.toMatchObject({
      price: 0.99439, source: "curve-thin-onchain", confidence: "fallback", observedAtMode: "upstream",
    });
  });

  it("batches six direct reads at one pinned block, quoting underlying STBT into USDC", async () => {
    mockHealthyPool();
    const signal = new AbortController().signal;
    await fetchStbtCurvePoolPrice(ctx(), signal);
    expect(fetchEvmRpcBatchMock).toHaveBeenCalledTimes(1);
    const [chain, calls, options] = fetchEvmRpcBatchMock.mock.calls[0];
    expect(chain).toBe("ethereum");
    expect(options.signal).toBe(signal);
    expect(calls).toEqual([
      `0xc6610657${word(0n)}`, `0xc6610657${word(1n)}`,
      `0x4903b0d1${word(0n)}`, `0x4903b0d1${word(1n)}`,
      `0x07211ef7${word(0n)}${word(2n)}${word(10n ** 18n)}`,
      `0x07211ef7${word(0n)}${word(2n)}${word(10n * 10n ** 18n)}`,
    ].map((data) => ({
      method: "eth_call",
      params: [{ to: "0x892d701d94a43bdbcb5ea28891daca2fa22a690b", data }, `0x${(26_313_576).toString(16)}`],
    })));
  });

  it.each([null, [], [null, null, null, null, null, null]])("rejects an unavailable or incomplete batch (%j)", async (result) => {
    fetchEvmRpcBatchMock.mockResolvedValue(result);
    const context = ctx();
    await expect(fetchStbtCurvePoolPrice(context)).resolves.toBeNull();
    expect(context.lastRejectionReason).toBe("curve-thin-onchain:state-unavailable");
  });

  it.each([
    ["reversed token order", { coin0: CRV3 }, "identity"],
    ["non-3Crv base LP", { coin1: USDC }, "identity"],
    ["STBT below floor", { stbtBalance: 999n * 10n ** 18n }, "inventory"],
    ["3Crv below floor", { crv3Balance: 999n * 10n ** 18n }, "inventory"],
    ["zero sell quote", { smallOutput: 0n }, "quote-invalid"],
    ["excessive impact", { impactOutput: 8_500_000n }, "quote-depth"],
  ])("rejects %s", async (_name, overrides, reason) => {
    mockHealthyPool(overrides);
    const context = ctx();
    await expect(fetchStbtCurvePoolPrice(context)).resolves.toBeNull();
    expect(context.lastRejectionReason).toBe(`curve-thin-onchain:${reason}`);
  });

  it.each([
    ["block-unavailable", () => fetchEvmBlockNumberMock.mockResolvedValue(null)],
    ["block-age-unavailable", () => fetchEvmBlockTimestampMock.mockResolvedValue(null)],
    ["block-age-future", () => fetchEvmBlockTimestampMock.mockResolvedValue(Math.floor(Date.now() / 1000) + 61)],
    ["block-age-stale", () => fetchEvmBlockTimestampMock.mockResolvedValue(Math.floor(Date.now() / 1000) - 301)],
    ["state-malformed", () => fetchEvmRpcBatchMock.mockResolvedValue(["0x1234", ...healthyPool().slice(1)])],
    ["dependency-age", () => {
      const base = Date.now();
      const spy = vi.spyOn(Date, "now").mockReturnValue(base);
      fetchEvmBlockTimestampMock.mockResolvedValue(Math.floor(base / 1000) - 299);
      fetchEvmRpcBatchMock.mockImplementation(async () => { spy.mockReturnValue(base + 5_000); return healthyPool(); });
    }],
  ])("records curve-thin-onchain:%s on guard rejection", async (reason, setup) => {
    try {
      setup();
      const context = ctx();
      await expect(fetchStbtCurvePoolPrice(context)).resolves.toBeNull();
      expect(context.lastRejectionReason).toBe(`curve-thin-onchain:${reason}`);
      if (reason.startsWith("block-")) expect(fetchEvmRpcBatchMock).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("routes every read through the Worker's configured chain RPCs before the public tail", async () => {
    const rpc = await vi.importActual<typeof import("../evm-rpc")>("../evm-rpc");
    fetchEvmBlockNumberMock.mockImplementation(rpc.fetchEvmBlockNumber);
    fetchEvmBlockTimestampMock.mockImplementation(rpc.fetchEvmBlockTimestamp);
    fetchEvmRpcBatchMock.mockImplementation(rpc.fetchEvmRpcBatch);
    const configured = "https://worker-rpc.example.test";
    const publicRpc = "https://ethereum-rpc.publicnode.com";
    const chainRpcs: LivePriceContext["chainRpcs"] = new Map([["ethereum", {
      chainId: "ethereum", chainName: "Ethereum", type: "evm", explorerUrl: "",
      endpoints: [{ url: configured, operator: "alchemy", keyed: false, position: "registry",
        stateHistory: "archive", logsHistory: "unknown" }],
    }]]);
    const context = { assetsById: new Map([["usdc-circle", trustedUsdc()]]), chainRpcs };
    const number = "0x1918128";
    const pool = healthyPool();
    const routeOrder: Array<[method: string, url: string]> = [];
    const fetchRpc = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const request = JSON.parse(init?.body as string);
      const method = (Array.isArray(request) ? request[0].method : request.method) as string;
      if (url === configured) {
        // Let any speculative public request start before returning the configured failure.
        await new Promise<void>((resolve) => setImmediate(resolve));
        routeOrder.push([method, configured]);
        return new Response(null, { status: 403 });
      }
      if (url !== publicRpc) throw new Error(`Unexpected RPC URL: ${url}`);
      routeOrder.push([method, publicRpc]);
      return Response.json(Array.isArray(request)
        ? request.map(({ id }, i) => ({ jsonrpc: "2.0", id, result: pool[i] }))
        : { jsonrpc: "2.0", id: request.id, result: request.method === "eth_blockNumber" ? number : {
          number, timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`, hash: uintResult(1n),
        } });
    });
    try {
      await expect(fetchStbtCurvePoolPrice(context)).resolves.toMatchObject({ price: 0.99439 });
      expect(fetchRpc.mock.calls.filter(([url]) => url === configured)).toHaveLength(3);
      expect(fetchRpc.mock.calls.filter(([url]) => url === publicRpc)).toHaveLength(3);
      for (const method of ["eth_blockNumber", "eth_getBlockByNumber", "eth_call"]) {
        expect(routeOrder.filter(([name]) => name === method).map(([, url]) => url))
          .toEqual([configured, publicRpc]);
      }
    } finally {
      fetchRpc.mockRestore();
    }
  });

  it("reports the older USDC parent clock instead of renewing it with a fresh block", async () => {
    mockHealthyPool();
    const blockTimestamp = Math.floor(Date.now() / 1000) - 12;
    fetchEvmBlockTimestampMock.mockResolvedValue(blockTimestamp);
    const parent = trustedUsdc(240, 0.99);

    const result = await fetchStbtCurvePoolPrice({
      assetsById: new Map([["usdc-circle", parent]]),
    });

    expect(result).toMatchObject({
      source: "curve-thin-onchain",
      confidence: "fallback",
      observedAt: parent.priceObservedAt,
      observedAtMode: "local_fetch",
    });
    expect(result?.observedAt).toBeLessThan(blockTimestamp);
    expect(result?.price).toBeCloseTo(0.9844461, 10);
  });

  it("rejects when the older dependency clock exceeds the five-minute budget", async () => {
    mockHealthyPool();
    fetchEvmBlockTimestampMock.mockResolvedValue(Math.floor(Date.now() / 1000) - 12);
    const context: LivePriceContext = { assetsById: new Map([["usdc-circle", trustedUsdc(800)]]) };

    await expect(fetchStbtCurvePoolPrice(context)).resolves.toBeNull();
    expect(context.lastUntrustedParent ?? null).toBeNull();
    expect(context.lastRejectionReason).toBe("curve-thin-onchain:parent-age");
    expect(fetchEvmBlockNumberMock).not.toHaveBeenCalled();
  });

  it("registers as the missing-only STBT lane bound to its own circuit", () => {
    expect(stbtCurvePoolProvider).toMatchObject({
      source: "curve-thin-onchain",
      liveMissingOnly: true,
      liveCircuitSource: "stbt-curve-pool",
      liveParentByAssetId: { "stbt-matrixdock": "usdc-circle" },
    });
    expect(stbtCurvePoolProvider.matches("stbt-matrixdock")).toBe(true);
    expect(stbtCurvePoolProvider.matches("usdc-circle")).toBe(false);
  });

  it("does not replace an existing usable market price with the thin fallback", async () => {
    const now = Math.floor(Date.now() / 1000);
    const asset = {
      id: "stbt-matrixdock",
      symbol: "STBT",
      price: 0.9945,
      priceSource: "coingecko",
      priceConfidence: "single-source",
      priceObservedAt: now - 60,
      priceObservedAtMode: "upstream",
      priceSyncedAt: now,
    } as PeggedAsset;

    await expect(stbtCurvePoolProvider.fetchLivePrice?.(asset, {
      assetsById: new Map([
        [asset.id, asset],
        ["usdc-circle", trustedUsdc()],
      ]),
    })).resolves.toBeNull();
    expect(fetchEvmBlockNumberMock).not.toHaveBeenCalled();
  });

  it("rejects an unavailable USDC parent before spending block or pool reads", async () => {
    const context: LivePriceContext = { assetsById: new Map() };
    await expect(fetchStbtCurvePoolPrice(context)).resolves.toBeNull();
    expect(context.lastRejectionReason).toBe("curve-thin-onchain:parent-unavailable");
    expect(fetchEvmBlockNumberMock).not.toHaveBeenCalled();
  });

  it("rejects an unpriced USDC parent for a missing STBT price before spending block or pool reads", async () => {
    const asset = { id: "stbt-matrixdock", symbol: "STBT", price: null } as unknown as PeggedAsset;
    const context: LivePriceContext = {
      assetsById: new Map([[asset.id, asset], ["usdc-circle", { ...trustedUsdc(), price: null }]]),
    };

    await expect(stbtCurvePoolProvider.fetchLivePrice?.(asset, context)).resolves.toBeNull();
    expect(context.lastUntrustedParent).toEqual({ parentId: "usdc-circle", reason: "parent-price-missing" });
    expect(fetchEvmBlockNumberMock).not.toHaveBeenCalled();
  });
});

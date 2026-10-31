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

function mockHealthyPool(overrides: {
  coin0?: string;
  coin1?: string;
  stbtBalance?: bigint;
  crv3Balance?: bigint;
  impactOutput?: bigint;
} = {}): void {
  fetchEvmRpcBatchMock.mockResolvedValue([
    addressWord(overrides.coin0 ?? STBT),
    addressWord(overrides.coin1 ?? CRV3),
    uintResult(overrides.stbtBalance ?? PINNED_STBT_BALANCE),
    uintResult(overrides.crv3Balance ?? PINNED_CRV3_BALANCE),
    uintResult(PINNED_SMALL_QUOTE),
    uintResult(overrides.impactOutput ?? PINNED_IMPACT_QUOTE),
  ]);
}

describe("STBT exact Curve metapool price", () => {
  beforeEach(() => {
    fetchEvmBlockNumberMock.mockReset().mockResolvedValue(26_313_576);
    fetchEvmBlockTimestampMock.mockReset().mockResolvedValue(Math.floor(Date.now() / 1000) - 12);
    fetchEvmRpcBatchMock.mockReset();
  });

  it("accepts a fresh identity-bound metapool quote as fallback display evidence", async () => {
    mockHealthyPool();

    await expect(fetchStbtCurvePoolPrice({
      assetsById: new Map([["usdc-circle", trustedUsdc()]]),
    })).resolves.toMatchObject({
      price: 0.99439,
      source: "curve-thin-onchain",
      confidence: "fallback",
      observedAtMode: "upstream",
    });
  });

  it("batches six direct reads at one pinned block, quoting underlying STBT into USDC", async () => {
    mockHealthyPool();
    const signal = new AbortController().signal;
    await fetchStbtCurvePoolPrice({ assetsById: new Map([["usdc-circle", trustedUsdc()]]) }, signal);
    expect(fetchEvmRpcBatchMock).toHaveBeenCalledTimes(1);
    const [chain, calls, options] = fetchEvmRpcBatchMock.mock.calls[0];
    expect(chain).toBe("ethereum");
    expect(options.signal).toBe(signal);
    expect(calls).toEqual([
      `0xc6610657${word(0n)}`,
      `0xc6610657${word(1n)}`,
      `0x4903b0d1${word(0n)}`,
      `0x4903b0d1${word(1n)}`,
      `0x07211ef7${word(0n)}${word(2n)}${word(10n ** 18n)}`,
      `0x07211ef7${word(0n)}${word(2n)}${word(10n * 10n ** 18n)}`,
    ].map((data) => ({
      method: "eth_call",
      params: [{ to: "0x892d701d94a43bdbcb5ea28891daca2fa22a690b", data }, `0x${(26_313_576).toString(16)}`],
    })));
  });

  it.each([null, [], [null, null, null, null, null, null]])("rejects an unavailable or incomplete batch (%j)", async (result) => {
    fetchEvmRpcBatchMock.mockResolvedValue(result);
    await expect(fetchStbtCurvePoolPrice({
      assetsById: new Map([["usdc-circle", trustedUsdc()]]),
    })).resolves.toBeNull();
  });

  it.each([
    ["the metapool token order reversed", { coin0: CRV3 }],
    ["a base LP token other than the reviewed 3Crv", { coin1: USDC }],
    ["a STBT side below the reviewed quote-reserve floor", { stbtBalance: 999n * 10n ** 18n }],
    ["a 3Crv side below the reviewed quote-reserve floor", { crv3Balance: 999n * 10n ** 18n }],
    ["excessive executable quote impact", { impactOutput: 8_500_000n }],
  ])("rejects %s", async (_name, overrides) => {
    mockHealthyPool(overrides);

    await expect(fetchStbtCurvePoolPrice({
      assetsById: new Map([["usdc-circle", trustedUsdc()]]),
    })).resolves.toBeNull();
  });

  it("routes every read through the Worker's configured chain RPCs before the public tail", async () => {
    mockHealthyPool();
    const chainRpcs: LivePriceContext["chainRpcs"] = new Map();
    await fetchStbtCurvePoolPrice({ assetsById: new Map([["usdc-circle", trustedUsdc()]]), chainRpcs });
    for (const mock of [fetchEvmBlockNumberMock, fetchEvmBlockTimestampMock, fetchEvmRpcBatchMock]) {
      const call = mock.mock.calls[0] ?? [];
      expect(call[call.length - 1]).toMatchObject({ chainRpcs });
    }
  });

  it("rejects a stale block before pool calls", async () => {
    fetchEvmBlockTimestampMock.mockResolvedValue(Math.floor(Date.now() / 1000) - 301);

    await expect(fetchStbtCurvePoolPrice({
      assetsById: new Map([["usdc-circle", trustedUsdc()]]),
    })).resolves.toBeNull();
    expect(fetchEvmRpcBatchMock).not.toHaveBeenCalled();
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
    await expect(fetchStbtCurvePoolPrice({ assetsById: new Map() })).resolves.toBeNull();
    expect(fetchEvmBlockNumberMock).not.toHaveBeenCalled();
  });
});

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
  fetchSwanusdCurvePoolPrice,
  swanusdCurvePoolProvider,
} from "../authoritative-price-sources/swanusd-curve-pool";
import type { LivePriceContext } from "../authoritative-price-sources/helpers";

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const SWANUSD = "0x9bf2b2f57a2968a0e81546ed50cbbbb7c9d6e05e";
// Ethereum block 26299913, the swanUSD review pin: balances(0/1) and the
// get_dy(1 -> 0) quotes reproduced from agents/swanusd/research/r2.
const PINNED_USDC_BALANCE = 40_592_908_865n;
const PINNED_SWANUSD_BALANCE = 40_131_077_540_877_386_791_237n;
const PINNED_SMALL_QUOTE = 999_945n;
const PINNED_IMPACT_QUOTE = 9_999_445n;
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
  usdcBalance?: bigint;
  swanusdBalance?: bigint;
  impactOutput?: bigint;
} = {}): void {
  fetchEvmRpcBatchMock.mockResolvedValue([
    addressWord(overrides.coin0 ?? USDC),
    addressWord(SWANUSD),
    uintResult(overrides.usdcBalance ?? PINNED_USDC_BALANCE),
    uintResult(overrides.swanusdBalance ?? PINNED_SWANUSD_BALANCE),
    uintResult(PINNED_SMALL_QUOTE),
    uintResult(overrides.impactOutput ?? PINNED_IMPACT_QUOTE),
  ]);
}

describe("swanUSD exact Curve pool price", () => {
  beforeEach(() => {
    fetchEvmBlockNumberMock.mockReset().mockResolvedValue(26_299_913);
    fetchEvmBlockTimestampMock.mockReset().mockResolvedValue(Math.floor(Date.now() / 1000) - 12);
    fetchEvmRpcBatchMock.mockReset();
  });

  it("accepts a fresh identity-bound executable quote as fallback display evidence", async () => {
    mockHealthyPool();

    await expect(fetchSwanusdCurvePoolPrice({
      assetsById: new Map([["usdc-circle", trustedUsdc()]]),
    })).resolves.toMatchObject({
      price: 0.999945,
      source: "curve-thin-onchain",
      confidence: "fallback",
      observedAtMode: "upstream",
    });
  });

  it("batches six direct calls at the original block with the same abort signal", async () => {
    mockHealthyPool();
    const signal = new AbortController().signal;
    await fetchSwanusdCurvePoolPrice({ assetsById: new Map([["usdc-circle", trustedUsdc()]]) }, signal);
    expect(fetchEvmRpcBatchMock).toHaveBeenCalledTimes(1);
    const [chain, calls, options] = fetchEvmRpcBatchMock.mock.calls[0];
    expect(chain).toBe("ethereum");
    expect(options.signal).toBe(signal);
    expect(calls).toEqual([
      `0xc6610657${word(0n)}`,
      `0xc6610657${word(1n)}`,
      `0x4903b0d1${word(0n)}`,
      `0x4903b0d1${word(1n)}`,
      `0x5e0d443f${word(1n)}${word(0n)}${word(10n ** 18n)}`,
      `0x5e0d443f${word(1n)}${word(0n)}${word(10n * 10n ** 18n)}`,
    ].map((data) => ({
      method: "eth_call",
      params: [{ to: "0xc1488f04027afea94fa68586b4ff245098a59432", data }, `0x${(26_299_913).toString(16)}`],
    })));
  });

  it.each([null, [], [null, null, null, null, null, null]])("rejects an unavailable or incomplete batch (%j)", async (result) => {
    fetchEvmRpcBatchMock.mockResolvedValue(result);
    await expect(fetchSwanusdCurvePoolPrice({
      assetsById: new Map([["usdc-circle", trustedUsdc()]]),
    })).resolves.toBeNull();
  });

  it.each([
    ["token-index reversal", { coin0: SWANUSD }],
    ["a USDC side below the reviewed quote-reserve floor", { usdcBalance: 999n * 10n ** 6n }],
    ["a swanUSD side below the reviewed quote-reserve floor", { swanusdBalance: 999n * 10n ** 18n }],
    ["excessive executable quote impact", { impactOutput: 8_500_000n }],
  ])("rejects %s", async (_name, overrides) => {
    mockHealthyPool(overrides);

    await expect(fetchSwanusdCurvePoolPrice({
      assetsById: new Map([["usdc-circle", trustedUsdc()]]),
    })).resolves.toBeNull();
  });

  it("rejects a stale block before pool calls", async () => {
    fetchEvmBlockTimestampMock.mockResolvedValue(Math.floor(Date.now() / 1000) - 301);

    await expect(fetchSwanusdCurvePoolPrice({
      assetsById: new Map([["usdc-circle", trustedUsdc()]]),
    })).resolves.toBeNull();
    expect(fetchEvmRpcBatchMock).not.toHaveBeenCalled();
  });

  it("reports the older USDC parent clock instead of renewing it with a fresh block", async () => {
    mockHealthyPool();
    const blockTimestamp = Math.floor(Date.now() / 1000) - 12;
    fetchEvmBlockTimestampMock.mockResolvedValue(blockTimestamp);
    const parent = trustedUsdc(240, 0.99);

    const result = await fetchSwanusdCurvePoolPrice({
      assetsById: new Map([["usdc-circle", parent]]),
    });

    // A 12 s block cannot refresh a 240 s parent: the derived price publishes at
    // the parent's conversion clock and observation mode while still using the parent's price.
    expect(result).toMatchObject({
      source: "curve-thin-onchain",
      confidence: "fallback",
      observedAt: parent.priceObservedAt,
      observedAtMode: "local_fetch",
    });
    expect(result?.observedAt).toBeLessThan(blockTimestamp);
    expect(result?.price).toBeCloseTo(0.98994555, 10);
  });

  it("rejects when the older dependency clock exceeds the five-minute budget", async () => {
    mockHealthyPool();
    fetchEvmBlockTimestampMock.mockResolvedValue(Math.floor(Date.now() / 1000) - 12);
    // The 800 s USDC row still passes its own 900 s admission, so only the
    // derived source's budget can reject it, before the block and pool reads.
    const context: LivePriceContext = { assetsById: new Map([["usdc-circle", trustedUsdc(800)]]) };

    await expect(fetchSwanusdCurvePoolPrice(context)).resolves.toBeNull();
    expect(context.lastUntrustedParent ?? null).toBeNull();
    expect(fetchEvmBlockNumberMock).not.toHaveBeenCalled();
  });

  it("does not replace an existing usable market price with the thin fallback", async () => {
    const now = Math.floor(Date.now() / 1000);
    const asset = {
      id: "swanusd-swan",
      symbol: "swanUSD",
      price: 0.99904,
      priceSource: "coingecko",
      priceConfidence: "single-source",
      priceObservedAt: now - 60,
      priceObservedAtMode: "upstream",
      priceSyncedAt: now,
    } as PeggedAsset;

    await expect(swanusdCurvePoolProvider.fetchLivePrice?.(asset, {
      assetsById: new Map([
        [asset.id, asset],
        ["usdc-circle", trustedUsdc()],
      ]),
    })).resolves.toBeNull();
    expect(fetchEvmBlockNumberMock).not.toHaveBeenCalled();
  });
});

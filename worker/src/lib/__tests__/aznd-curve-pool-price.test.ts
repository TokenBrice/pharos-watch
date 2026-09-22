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
  azndCurvePoolProvider,
  fetchAzndCurvePoolPrice,
} from "../authoritative-price-sources/aznd-curve-pool";

const AZND = "0x52c66b5e7f8fde20843de900c5c8b4b0f23708a0";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const addressWord = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}` as `0x${string}`;
const uintResult = (value: bigint) => `0x${word(value)}` as `0x${string}`;

function trustedUsdc(): PeggedAsset {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: "usdc-circle",
    symbol: "USDC",
    price: 1,
    priceSource: "coingecko+defillama-list",
    priceConfidence: "high",
    priceObservedAt: now,
    priceObservedAtMode: "local_fetch",
    priceSyncedAt: now,
  } as PeggedAsset;
}

function mockHealthyPool(overrides: { coin0?: string; usdcBalance?: bigint; impactOutput?: bigint } = {}): void {
  fetchEvmRpcBatchMock.mockResolvedValue([
    addressWord(overrides.coin0 ?? AZND),
    addressWord(USDC),
    uintResult(22_000n * 10n ** 18n),
    uintResult(overrides.usdcBalance ?? 120n * 10n ** 6n),
    uintResult(220_000n),
    uintResult(overrides.impactOutput ?? 2_180_000n),
  ]);
}

describe("AZND exact Curve pool price", () => {
  beforeEach(() => {
    fetchEvmBlockNumberMock.mockReset().mockResolvedValue(25_543_520);
    fetchEvmBlockTimestampMock.mockReset().mockResolvedValue(Math.floor(Date.now() / 1000) - 12);
    fetchEvmRpcBatchMock.mockReset();
  });

  it("accepts a fresh identity-bound executable quote as fallback display evidence", async () => {
    mockHealthyPool();

    await expect(fetchAzndCurvePoolPrice({
      assetsById: new Map([["usdc-circle", trustedUsdc()]]),
    })).resolves.toMatchObject({
      price: 0.22,
      source: "curve-thin-onchain",
      confidence: "fallback",
      observedAtMode: "upstream",
    });
  });

  it("batches six direct calls at the original block with the same abort signal", async () => {
    mockHealthyPool();
    const signal = new AbortController().signal;
    await fetchAzndCurvePoolPrice({ assetsById: new Map([["usdc-circle", trustedUsdc()]]) }, signal);
    expect(fetchEvmRpcBatchMock).toHaveBeenCalledTimes(1);
    const [chain, calls, options] = fetchEvmRpcBatchMock.mock.calls[0];
    expect(chain).toBe("ethereum");
    expect(options.signal).toBe(signal);
    expect(calls).toEqual([
      `0xc6610657${word(0n)}`,
      `0xc6610657${word(1n)}`,
      `0x4903b0d1${word(0n)}`,
      `0x4903b0d1${word(1n)}`,
      `0x5e0d443f${word(0n)}${word(1n)}${word(10n ** 18n)}`,
      `0x5e0d443f${word(0n)}${word(1n)}${word(10n * 10n ** 18n)}`,
    ].map((data) => ({
      method: "eth_call",
      params: [{ to: "0x0d381fc68487365e90c32c90323352b325e21d23", data }, `0x${(25_543_520).toString(16)}`],
    })));
  });

  it.each([null, [], [null, null, null, null, null, null]])("rejects an unavailable or incomplete batch (%j)", async (result) => {
    fetchEvmRpcBatchMock.mockResolvedValue(result);
    await expect(fetchAzndCurvePoolPrice({
      assetsById: new Map([["usdc-circle", trustedUsdc()]]),
    })).resolves.toBeNull();
  });

  it("rejects token-index reversal", async () => {
    mockHealthyPool({ coin0: USDC });

    await expect(fetchAzndCurvePoolPrice({
      assetsById: new Map([["usdc-circle", trustedUsdc()]]),
    })).resolves.toBeNull();
  });

  it("rejects a pool below the reviewed quote-reserve floor", async () => {
    mockHealthyPool({ usdcBalance: 99n * 10n ** 6n });

    await expect(fetchAzndCurvePoolPrice({
      assetsById: new Map([["usdc-circle", trustedUsdc()]]),
    })).resolves.toBeNull();
  });

  it("rejects excessive executable quote impact", async () => {
    mockHealthyPool({ impactOutput: 1_500_000n });

    await expect(fetchAzndCurvePoolPrice({
      assetsById: new Map([["usdc-circle", trustedUsdc()]]),
    })).resolves.toBeNull();
  });

  it("rejects a stale block before pool calls", async () => {
    fetchEvmBlockTimestampMock.mockResolvedValue(Math.floor(Date.now() / 1000) - 301);

    await expect(fetchAzndCurvePoolPrice({
      assetsById: new Map([["usdc-circle", trustedUsdc()]]),
    })).resolves.toBeNull();
    expect(fetchEvmRpcBatchMock).not.toHaveBeenCalled();
  });

  it("does not replace an existing usable market price with the thin fallback", async () => {
    const now = Math.floor(Date.now() / 1000);
    const asset = {
      id: "aznd-mu-digital",
      symbol: "AZND",
      price: 0.31,
      priceSource: "coingecko",
      priceConfidence: "high",
      priceObservedAt: now - 60,
      priceObservedAtMode: "upstream",
      priceSyncedAt: now,
    } as PeggedAsset;

    await expect(azndCurvePoolProvider.fetchLivePrice?.(asset, {
      assetsById: new Map([
        [asset.id, asset],
        ["usdc-circle", trustedUsdc()],
      ]),
    })).resolves.toBeNull();
    expect(fetchEvmBlockNumberMock).not.toHaveBeenCalled();
  });
});

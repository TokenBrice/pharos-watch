import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";

const fetchEvmBlockNumberMock = vi.fn();
const fetchEvmBlockTimestampMock = vi.fn();
const fetchEvmCallHexAtBlockMock = vi.fn();

vi.mock("../evm-rpc", () => ({
  fetchEvmBlockNumber: (...args: unknown[]) => fetchEvmBlockNumberMock(...args),
  fetchEvmBlockTimestamp: (...args: unknown[]) => fetchEvmBlockTimestampMock(...args),
  fetchEvmCallHexAtBlock: (...args: unknown[]) => fetchEvmCallHexAtBlockMock(...args),
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
  fetchEvmCallHexAtBlockMock
    .mockResolvedValueOnce(addressWord(overrides.coin0 ?? AZND))
    .mockResolvedValueOnce(addressWord(USDC))
    .mockResolvedValueOnce(uintResult(22_000n * 10n ** 18n))
    .mockResolvedValueOnce(uintResult(overrides.usdcBalance ?? 120n * 10n ** 6n))
    .mockResolvedValueOnce(uintResult(220_000n))
    .mockResolvedValueOnce(uintResult(overrides.impactOutput ?? 2_180_000n));
}

describe("AZND exact Curve pool price", () => {
  beforeEach(() => {
    fetchEvmBlockNumberMock.mockReset().mockResolvedValue(25_543_520);
    fetchEvmBlockTimestampMock.mockReset().mockResolvedValue(Math.floor(Date.now() / 1000) - 12);
    fetchEvmCallHexAtBlockMock.mockReset();
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
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  it("does not replace an existing usable market price with the thin fallback", async () => {
    const asset = { id: "aznd-mu-digital", symbol: "AZND", price: 0.31 } as PeggedAsset;

    await expect(azndCurvePoolProvider.fetchLivePrice?.(asset, {
      assetsById: new Map([
        [asset.id, asset],
        ["usdc-circle", trustedUsdc()],
      ]),
    })).resolves.toBeNull();
    expect(fetchEvmBlockNumberMock).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";

const fetchEvmCallHexAtBlockMock = vi.fn();

vi.mock("../evm-rpc", () => ({
  fetchEvmCallHexAtBlock: (...args: unknown[]) => fetchEvmCallHexAtBlockMock(...args),
}));

import { fetchUsxStablePoolPrice } from "../authoritative-price-sources/usx-stable-pools";

const word = (value: bigint) => value.toString(16).padStart(64, "0");
const addressWord = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}` as `0x${string}`;
const reserves = (reserve0: bigint, reserve1: bigint) => `0x${word(reserve0)}${word(reserve1)}${word(0n)}` as `0x${string}`;
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

function mockRouteCalls(secondRouteOutput = 390_000_000n): void {
  fetchEvmCallHexAtBlockMock
    .mockResolvedValueOnce(addressWord("0x0b2c639c533813f4aa9d7837caf62653d097ff85"))
    .mockResolvedValueOnce(addressWord("0xbfd291da8a403daaf7e5e9dc1ec0aceacd4848b9"))
    .mockResolvedValueOnce(reserves(60_000n * 10n ** 6n, 400_000n * 10n ** 18n))
    .mockResolvedValueOnce(uintResult(389_000_000n))
    .mockResolvedValueOnce(addressWord("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"))
    .mockResolvedValueOnce(addressWord("0xc142171b138db17a1b7cb999c44526094a4dae05"))
    .mockResolvedValueOnce(reserves(75_000n * 10n ** 6n, 530_000n * 10n ** 18n))
    .mockResolvedValueOnce(uintResult(secondRouteOutput));
}

describe("USX exact stable-pool price", () => {
  beforeEach(() => {
    fetchEvmCallHexAtBlockMock.mockReset();
  });

  it("accepts two identity-bound executable USDC routes that agree", async () => {
    mockRouteCalls();

    const result = await fetchUsxStablePoolPrice({
      assetsById: new Map([["usdc-circle", trustedUsdc()]]),
    });

    expect(result).toMatchObject({
      price: 0.3895,
      source: "aerodrome-onchain+velodrome-onchain",
      confidence: "high",
      observedAtMode: "local_fetch",
    });
  });

  it("fails closed when the two executable routes materially disagree", async () => {
    mockRouteCalls(500_000_000n);

    await expect(fetchUsxStablePoolPrice({
      assetsById: new Map([["usdc-circle", trustedUsdc()]]),
    })).resolves.toBeNull();
  });

  it("rejects a route whose exact pool token identity does not match", async () => {
    mockRouteCalls();
    fetchEvmCallHexAtBlockMock.mockReset();
    fetchEvmCallHexAtBlockMock
      .mockResolvedValueOnce(addressWord("0x0000000000000000000000000000000000000001"))
      .mockResolvedValueOnce(addressWord("0xbfd291da8a403daaf7e5e9dc1ec0aceacd4848b9"))
      .mockResolvedValueOnce(reserves(60_000n * 10n ** 6n, 400_000n * 10n ** 18n))
      .mockResolvedValueOnce(uintResult(389_000_000n));

    await expect(fetchUsxStablePoolPrice({
      assetsById: new Map([["usdc-circle", trustedUsdc()]]),
    })).resolves.toBeNull();
  });

  it("rejects routes below the reviewed quote-reserve floor", async () => {
    mockRouteCalls();
    fetchEvmCallHexAtBlockMock.mockReset();
    fetchEvmCallHexAtBlockMock
      .mockResolvedValueOnce(addressWord("0x0b2c639c533813f4aa9d7837caf62653d097ff85"))
      .mockResolvedValueOnce(addressWord("0xbfd291da8a403daaf7e5e9dc1ec0aceacd4848b9"))
      .mockResolvedValueOnce(reserves(1_000n * 10n ** 6n, 400_000n * 10n ** 18n))
      .mockResolvedValueOnce(uintResult(389_000_000n));

    await expect(fetchUsxStablePoolPrice({
      assetsById: new Map([["usdc-circle", trustedUsdc()]]),
    })).resolves.toBeNull();
  });
});

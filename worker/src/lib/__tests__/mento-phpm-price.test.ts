import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";

const fetchEvmCallHexAtBlockMock = vi.fn();
const fetchEvmBlockNumberMock = vi.fn();
const fetchEvmBlockTimestampMock = vi.fn();

vi.mock("../evm-rpc", () => ({
  fetchEvmCallHexAtBlock: (...args: unknown[]) => fetchEvmCallHexAtBlockMock(...args),
  fetchEvmBlockNumber: (...args: unknown[]) => fetchEvmBlockNumberMock(...args),
  fetchEvmBlockTimestamp: (...args: unknown[]) => fetchEvmBlockTimestampMock(...args),
}));

import { fetchMentoPhpmPrice } from "../authoritative-price-sources/mento-phpm";

const word = (value: bigint) => value.toString(16).padStart(64, "0");
const addressWord = (address: string) => address.slice(2).toLowerCase().padStart(64, "0");
const uintResult = (value: bigint) => `0x${word(value)}` as `0x${string}`;

function poolResult(input: {
  asset0?: string;
  asset1?: string;
  bucket0?: bigint;
  bucket1?: bigint;
} = {}): `0x${string}` {
  return `0x${[
    addressWord(input.asset0 ?? "0x765de816845861e75a25fca122bb6898b8b1282a"),
    addressWord(input.asset1 ?? "0x105d4a9306d2e55a71d2eb95b81553ae1dc20d7b"),
    addressWord("0xdebed1f6f6ce9f6e73aa25f95acbffe2397550fb"),
    word(input.bucket0 ?? 10_000_000n * 10n ** 18n),
    word(input.bucket1 ?? 600_000_000n * 10n ** 18n),
    word(1_700_000_000n),
    word(3n * 10n ** 21n),
  ].join("")}` as `0x${string}`;
}

function trustedUsdM(): PeggedAsset {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: "cusd-celo",
    symbol: "USDm",
    price: 1,
    priceSource: "coingecko+defillama-list",
    priceConfidence: "high",
    priceObservedAt: now,
    priceObservedAtMode: "local_fetch",
    priceSyncedAt: now,
  } as PeggedAsset;
}

describe("Mento PHPm protocol price", () => {
  beforeEach(() => {
    fetchEvmCallHexAtBlockMock.mockReset();
    fetchEvmBlockNumberMock.mockReset().mockResolvedValue(33_333_333);
    fetchEvmBlockTimestampMock.mockReset().mockImplementation(async () => Math.floor(Date.now() / 1_000) - 30);
  });

  it("prices PHPm from the exact funded Broker exchange", async () => {
    fetchEvmCallHexAtBlockMock
      .mockResolvedValueOnce(poolResult())
      .mockResolvedValueOnce(uintResult(16_174_689_920_000_000_000n));

    const result = await fetchMentoPhpmPrice({
      assetsById: new Map([["cusd-celo", trustedUsdM()]]),
    });

    expect(result).toMatchObject({
      price: 0.01617468992,
      source: "protocol-redeem",
      confidence: "high",
      observedAtMode: "upstream",
    });
    expect(fetchEvmCallHexAtBlockMock.mock.calls.every((call) => call[3] === 33_333_333)).toBe(true);
  });

  it("fails closed when the exact exchange token identity changes", async () => {
    fetchEvmCallHexAtBlockMock
      .mockResolvedValueOnce(poolResult({ asset1: "0x0000000000000000000000000000000000000001" }))
      .mockResolvedValueOnce(uintResult(16_174_689_920_000_000_000n));

    await expect(fetchMentoPhpmPrice({
      assetsById: new Map([["cusd-celo", trustedUsdM()]]),
    })).resolves.toBeNull();
  });

  it("fails closed when the USDm counter bucket falls below the reviewed floor", async () => {
    fetchEvmCallHexAtBlockMock
      .mockResolvedValueOnce(poolResult({ bucket0: 100_000n * 10n ** 18n }))
      .mockResolvedValueOnce(uintResult(16_174_689_920_000_000_000n));

    await expect(fetchMentoPhpmPrice({
      assetsById: new Map([["cusd-celo", trustedUsdM()]]),
    })).resolves.toBeNull();
  });

  it("fails closed when the USDm dependency is stale", async () => {
    const usdM = trustedUsdM();
    usdM.priceObservedAt = Math.floor(Date.now() / 1000) - 2 * 60 * 60;
    usdM.priceSyncedAt = usdM.priceObservedAt;

    await expect(fetchMentoPhpmPrice({
      assetsById: new Map([["cusd-celo", usdM]]),
    })).resolves.toBeNull();
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  it("fails closed on a stale Celo block before reading exchange state", async () => {
    fetchEvmBlockTimestampMock.mockResolvedValue(Math.floor(Date.now() / 1_000) - 301);

    await expect(fetchMentoPhpmPrice({
      assetsById: new Map([["cusd-celo", trustedUsdM()]]),
    })).resolves.toBeNull();
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });
});

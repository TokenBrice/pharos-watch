import { describe, expect, it } from "vitest";
import { StablecoinListResponseSchema } from "@shared/types/market";
import type { PeggedAsset } from "../enrich-prices-shared";
import {
  mergeSupplementalLastKnownGood,
  normalizeStablecoinsPayload,
  replaceZeroSupplyPrimaryAssets,
  SUPPLEMENTAL_RESTORE_MAX_FUTURE_SKEW_SEC,
  SUPPLEMENTAL_RESTORE_MAX_AGE_SEC,
} from "../shared";

const NOW_SEC = 1_780_000_000;

function asset(input: Partial<PeggedAsset> & Pick<PeggedAsset, "id" | "symbol">): PeggedAsset {
  return {
    name: input.symbol,
    pegType: "peggedUSD",
    pegMechanism: "fiat-backed",
    price: null,
    priceSource: "missing",
    circulating: {},
    chainCirculating: {},
    chains: [],
    ...input,
  } as PeggedAsset;
}

function chainRow(current: number): Record<string, unknown> {
  return {
    current,
    circulatingPrevDay: 0,
    circulatingPrevWeek: 0,
    circulatingPrevMonth: 0,
  };
}

function syrupChainCirculating(
  overrides: Record<string, Record<string, unknown>> = {},
): Record<string, Record<string, unknown>> {
  return {
    Ethereum: chainRow(70_000_000),
    Base: chainRow(10_000_000),
    Arbitrum: chainRow(5_000_000),
    Solana: chainRow(10_000_000),
    Ink: chainRow(0),
    Monad: chainRow(5_000_000),
    "Robinhood Chain": chainRow(0),
    Tempo: chainRow(0),
    ...overrides,
  };
}

describe("mergeSupplementalLastKnownGood carry-forward ceiling", () => {
  it("atomically restores a fresh curated aggregate supply packet over a positive CoinGecko fallback", () => {
    const current = asset({
      id: "syrupusdc-maple",
      symbol: "syrupUSDC",
      price: 1.12,
      priceSource: "defillama",
      priceUpdatedAt: NOW_SEC,
      supplySource: "coingecko-fallback",
      circulating: { peggedUSD: 105_000_000 },
      circulatingPrevDay: { peggedUSD: 104_000_000 },
      chainCirculating: {},
    });
    const previous = asset({
      id: "syrupusdc-maple",
      symbol: "syrupUSDC",
      price: 1.1,
      priceSource: "coingecko",
      supplySource: "onchain-total-supply",
      circulating: { peggedUSD: 100_000_000 },
      circulatingPrevDay: { peggedUSD: 90_000_000 },
      chainCirculating: syrupChainCirculating(),
      supplyObservedAt: NOW_SEC - 900,
    });

    const result = mergeSupplementalLastKnownGood(
      [current],
      new Map([["syrupusdc-maple", previous]]),
      new Set(),
      NOW_SEC,
    );

    expect(result.restoredCount).toBe(1);
    expect(result.expiredRestoreIds).toEqual([]);
    expect(result.assets[0]).toMatchObject({
      circulating: { peggedUSD: 100_000_000 },
      circulatingPrevDay: { peggedUSD: 104_000_000 },
      chainCirculating: previous.chainCirculating,
      supplySource: "onchain-total-supply",
      supplyObservedAt: NOW_SEC - 900,
      supplyRestored: true,
      price: 1.12,
      priceSource: "defillama",
      priceUpdatedAt: NOW_SEC,
    });
    expect(result.assets[0].chainCirculating).not.toBe(previous.chainCirculating);
    expect(
      StablecoinListResponseSchema.safeParse(normalizeStablecoinsPayload({ peggedAssets: result.assets })).success,
    ).toBe(true);
  });

  it("does not restore a reconciled curated aggregate packet with an extra stale chain", () => {
    const current = asset({
      id: "syrupusdc-maple",
      symbol: "syrupUSDC",
      supplySource: "coingecko-fallback",
      circulating: { peggedUSD: 105_000_000 },
      chainCirculating: {},
    });
    const previous = asset({
      id: "syrupusdc-maple",
      symbol: "syrupUSDC",
      supplySource: "onchain-total-supply",
      circulating: { peggedUSD: 100_000_000 },
      chainCirculating: syrupChainCirculating({
        Ethereum: chainRow(69_000_000),
        "Removed Chain": chainRow(1_000_000),
      }),
      supplyObservedAt: NOW_SEC - 900,
    });

    const result = mergeSupplementalLastKnownGood(
      [current],
      new Map([["syrupusdc-maple", previous]]),
      new Set(),
      NOW_SEC,
    );

    expect(result.restoredCount).toBe(0);
    expect(result.assets[0]).toBe(current);
  });

  it("does not restore a curated packet with a negative extra circulating bucket", () => {
    const current = asset({
      id: "syrupusdc-maple",
      symbol: "syrupUSDC",
      supplySource: "coingecko-fallback",
      circulating: { peggedUSD: 105_000_000 },
      chainCirculating: {},
    });
    const previous = asset({
      id: "syrupusdc-maple",
      symbol: "syrupUSDC",
      supplySource: "onchain-total-supply",
      circulating: { peggedUSD: 101_000_000, unexpected: -1_000_000 },
      chainCirculating: syrupChainCirculating(),
      supplyObservedAt: NOW_SEC - 900,
    });

    const result = mergeSupplementalLastKnownGood(
      [current],
      new Map([["syrupusdc-maple", previous]]),
      new Set(),
      NOW_SEC,
    );

    expect(result.restoredCount).toBe(0);
    expect(result.assets[0]).toBe(current);
  });

  it("does not restore a curated packet with malformed chain history", () => {
    const current = asset({
      id: "syrupusdc-maple",
      symbol: "syrupUSDC",
      supplySource: "coingecko-fallback",
      circulating: { peggedUSD: 105_000_000 },
      chainCirculating: {},
    });
    const previous = asset({
      id: "syrupusdc-maple",
      symbol: "syrupUSDC",
      supplySource: "onchain-total-supply",
      circulating: { peggedUSD: 100_000_000 },
      chainCirculating: syrupChainCirculating({
        Ethereum: { ...chainRow(70_000_000), circulatingPrevWeek: -1 },
      }),
      supplyObservedAt: NOW_SEC - 900,
    });

    const result = mergeSupplementalLastKnownGood(
      [current],
      new Map([["syrupusdc-maple", previous]]),
      new Set(),
      NOW_SEC,
    );

    expect(result.restoredCount).toBe(0);
    expect(result.assets[0]).toBe(current);
  });

  it("expires a curated aggregate packet while retaining the fresh CoinGecko fallback", () => {
    const current = asset({
      id: "syrupusdc-maple",
      symbol: "syrupUSDC",
      supplySource: "coingecko-fallback",
      circulating: { peggedUSD: 105_000_000 },
      chainCirculating: {},
    });
    const previous = asset({
      id: "syrupusdc-maple",
      symbol: "syrupUSDC",
      supplySource: "onchain-total-supply",
      circulating: { peggedUSD: 100_000_000 },
      chainCirculating: syrupChainCirculating(),
      supplyObservedAt: NOW_SEC - SUPPLEMENTAL_RESTORE_MAX_AGE_SEC - 1,
    });

    const result = mergeSupplementalLastKnownGood(
      [current],
      new Map([["syrupusdc-maple", previous]]),
      new Set(),
      NOW_SEC,
    );

    expect(result.restoredCount).toBe(0);
    expect(result.expiredRestoreIds).toEqual(["syrupusdc-maple"]);
    expect(result.assets[0]).toBe(current);
  });

  it("rejects a future-dated curated aggregate packet instead of extending its restore window", () => {
    const current = asset({
      id: "syrupusdc-maple",
      symbol: "syrupUSDC",
      supplySource: "coingecko-fallback",
      circulating: { peggedUSD: 105_000_000 },
      chainCirculating: {},
    });
    const previous = asset({
      id: "syrupusdc-maple",
      symbol: "syrupUSDC",
      supplySource: "onchain-total-supply",
      circulating: { peggedUSD: 100_000_000 },
      chainCirculating: syrupChainCirculating(),
      supplyObservedAt: NOW_SEC + SUPPLEMENTAL_RESTORE_MAX_FUTURE_SKEW_SEC + 1,
    });

    const result = mergeSupplementalLastKnownGood(
      [current],
      new Map([["syrupusdc-maple", previous]]),
      new Set(),
      NOW_SEC,
    );

    expect(result.restoredCount).toBe(0);
    expect(result.expiredRestoreIds).toEqual(["syrupusdc-maple"]);
    expect(result.assets[0]).toBe(current);
  });

  it("restores last-known-good supply observed inside the ceiling", () => {
    const current = asset({ id: "xaut-tether", symbol: "XAUT", circulating: {} });
    const previous = asset({
      id: "xaut-tether",
      symbol: "XAUT",
      circulating: { peggedUSD: 500_000_000 },
      supplyObservedAt: NOW_SEC - 86_400,
    });

    const result = mergeSupplementalLastKnownGood(
      [current],
      new Map([["xaut-tether", previous]]),
      new Set(),
      NOW_SEC,
    );

    expect(result.restoredCount).toBe(1);
    expect(result.expiredRestoreIds).toEqual([]);
    expect(result.assets[0]).toMatchObject({
      circulating: { peggedUSD: 500_000_000 },
      supplyRestored: true,
      supplyObservedAt: NOW_SEC - 86_400,
    });
  });

  it("refuses to restore supply older than the 7-day ceiling", () => {
    const current = asset({ id: "xaut-tether", symbol: "XAUT", circulating: {} });
    const previous = asset({
      id: "xaut-tether",
      symbol: "XAUT",
      circulating: { peggedUSD: 500_000_000 },
      supplyObservedAt: NOW_SEC - SUPPLEMENTAL_RESTORE_MAX_AGE_SEC - 1,
    });

    const result = mergeSupplementalLastKnownGood(
      [current],
      new Map([["xaut-tether", previous]]),
      new Set(),
      NOW_SEC,
    );

    expect(result.restoredCount).toBe(0);
    expect(result.expiredRestoreIds).toEqual(["xaut-tether"]);
    expect(result.assets[0]).toMatchObject({ id: "xaut-tether", circulating: {} });
    expect(result.assets[0].supplyRestored).toBeUndefined();
  });

  it.each([-1, NOW_SEC - 0.5])("refuses invalid supply observation timestamp %s", (supplyObservedAt) => {
    const current = asset({ id: "xaut-tether", symbol: "XAUT", circulating: {} });
    const previous = asset({
      id: "xaut-tether",
      symbol: "XAUT",
      circulating: { peggedUSD: 500_000_000 },
      supplyObservedAt,
    });

    const result = mergeSupplementalLastKnownGood(
      [current],
      new Map([["xaut-tether", previous]]),
      new Set(),
      NOW_SEC,
    );

    expect(result.restoredCount).toBe(0);
    expect(result.expiredRestoreIds).toEqual(["xaut-tether"]);
    expect(result.assets[0]).toBe(current);
  });

  it("restores rows without provenance exactly as before", () => {
    const current = asset({ id: "paxg-paxos", symbol: "PAXG", circulating: {} });
    const previous = asset({
      id: "paxg-paxos",
      symbol: "PAXG",
      circulating: { peggedUSD: 900_000_000 },
    });

    const result = mergeSupplementalLastKnownGood(
      [current],
      new Map([["paxg-paxos", previous]]),
      new Set(),
      NOW_SEC,
    );

    expect(result.restoredCount).toBe(1);
    expect(result.expiredRestoreIds).toEqual([]);
    expect(result.assets[0]).toMatchObject({ supplyRestored: true });
  });
});

describe("replaceZeroSupplyPrimaryAssets", () => {
  it("prefers positive supplemental coverage over a zero primary duplicate", () => {
    const primary = asset({
      id: "eurq-quantoz",
      symbol: "EURQ",
      circulating: { peggedEUR: 0 },
      supplySource: "defillama",
    });
    const supplemental = asset({
      id: "eurq-quantoz",
      symbol: "EURQ",
      circulating: { peggedEUR: 5_200_000 },
      supplySource: "coingecko-fallback",
    });

    const result = replaceZeroSupplyPrimaryAssets([primary], [supplemental]);

    expect(result.replacedIds).toEqual(["eurq-quantoz"]);
    expect(result.assets[0]).toBe(supplemental);
  });

  it("does not replace positive primary supply or substitute zero supplemental supply", () => {
    const positivePrimary = asset({
      id: "eurq-quantoz",
      symbol: "EURQ",
      circulating: { peggedEUR: 5_000_000 },
    });
    const zeroPrimary = asset({
      id: "gramg-token-teknoloji",
      symbol: "GRAMG",
      circulating: { peggedGOLD: 0 },
    });
    const supplements = [
      asset({ id: "eurq-quantoz", symbol: "EURQ", circulating: { peggedEUR: 5_200_000 } }),
      asset({ id: "gramg-token-teknoloji", symbol: "GRAMG", circulating: { peggedGOLD: 0 } }),
    ];

    const result = replaceZeroSupplyPrimaryAssets([positivePrimary, zeroPrimary], supplements);

    expect(result.replacedIds).toEqual([]);
    expect(result.assets).toEqual([positivePrimary, zeroPrimary]);
  });
});

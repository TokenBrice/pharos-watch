import { describe, expect, it, vi } from "vitest";
import type { PegAssetBase, StablecoinMeta } from "@shared/types/core";
import { decideDepegAsset } from "../decision-engine";

const usdMeta: StablecoinMeta = {
  id: "usdt-tether",
  name: "Tether",
  symbol: "USDT",
  flags: {
    backing: "rwa-backed",
    pegCurrency: "USD",
    governance: "centralized",
    yieldBearing: false,
    rwa: true,
    navToken: false,
  },
  geckoId: "tether",
};

function makeAsset(overrides: Partial<PegAssetBase> = {}): PegAssetBase {
  return {
    id: "usdt-tether",
    symbol: "USDT",
    price: 0.98,
    priceSource: "pyth",
    priceConfidence: "single-source",
    priceUpdatedAt: 1_750_000_000 - 60,
    pegType: "peggedUSD",
    circulating: { ethereum: 50_000_000 },
    ...overrides,
  };
}

describe("decideDepegAsset", () => {
  it("returns a live insert command for an authoritative small-cap depeg", () => {
    const decision = decideDepegAsset({
      now: 1_750_000_000,
      asset: makeAsset(),
      meta: usdMeta,
      pegRates: { peggedUSD: 1 },
      pegRateSources: { peggedUSD: "median" },
      pegRateCounts: { peggedUSD: 4 },
    });

    expect(decision.trackedCoinId).toBe("usdt-tether");
    expect(decision.commands).toHaveLength(1);
    expect(decision.commands[0]).toMatchObject({
      type: "insert-live",
      event: {
        stablecoinId: "usdt-tether",
        direction: "below",
        peakDeviationBps: -200,
        startPrice: 0.98,
        pegReference: 1,
      },
    });
    expect(decision.diagnostics).toHaveLength(0);
  });

  it("returns pending command diagnostics without logging as a side effect", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const decision = decideDepegAsset({
        now: 1_750_000_000,
        asset: makeAsset({ circulating: { ethereum: 2_000_000_000 } }),
        meta: usdMeta,
        pegRates: { peggedUSD: 1 },
        pegRateSources: { peggedUSD: "median" },
        pegRateCounts: { peggedUSD: 4 },
      });

      expect(decision.commands).toHaveLength(1);
      expect(decision.commands[0]).toMatchObject({
        type: "upsert-pending",
        payload: {
          stablecoinId: "usdt-tether",
          direction: "below",
          bps: -200,
          reason: "large-cap",
        },
      });
      expect(decision.diagnostics).toEqual([
        {
          level: "log",
          message: "[depeg] Pending confirmation for USDT: -200bps (supply $2.0B)",
        },
      ]);
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("routes near-threshold market-cap weak-source severe moves to pending", () => {
    const decision = decideDepegAsset({
      now: 1_750_000_000,
      asset: makeAsset({
        price: 0.975,
        circulating: { ethereum: 999_000_000 },
        priceSource: "pyth",
        agreeSources: ["pyth"],
      }),
      meta: usdMeta,
      pegRates: { peggedUSD: 1 },
      pegRateSources: { peggedUSD: "median" },
      pegRateCounts: { peggedUSD: 4 },
    });

    expect(decision.commands).toHaveLength(1);
    expect(decision.commands[0]).toMatchObject({
      type: "upsert-pending",
      payload: {
        stablecoinId: "usdt-tether",
        direction: "below",
        bps: -250,
        reason: "large-cap",
      },
    });
  });

  it("keeps strong near-threshold evidence on the immediate live path", () => {
    const decision = decideDepegAsset({
      now: 1_750_000_000,
      asset: makeAsset({
        price: 0.985,
        priceSource: "binance+pyth",
        priceConfidence: "high",
        agreeSources: ["binance", "pyth"],
        circulating: { ethereum: 999_000_000 },
      }),
      meta: usdMeta,
      pegRates: { peggedUSD: 1 },
      pegRateSources: { peggedUSD: "median" },
      pegRateCounts: { peggedUSD: 4 },
    });

    expect(decision.commands).toHaveLength(1);
    expect(decision.commands[0]).toMatchObject({
      type: "insert-live",
      event: {
        stablecoinId: "usdt-tether",
        direction: "below",
        peakDeviationBps: -150,
      },
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import type { PegAssetBase, StablecoinMeta } from "@shared/types/core";
import type { DepegRow } from "../../../lib/depeg-helpers";
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

const brlMeta: StablecoinMeta = {
  id: "brz-transfero",
  name: "Brazilian Digital Token",
  symbol: "BRZ",
  flags: {
    backing: "rwa-backed",
    pegCurrency: "BRL",
    governance: "centralized",
    yieldBearing: false,
    rwa: true,
    navToken: false,
  },
  geckoId: "brz",
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

function makeExistingEvent(overrides: Partial<DepegRow> = {}): DepegRow {
  return {
    id: 7,
    stablecoin_id: "brz-transfero",
    symbol: "BRZ",
    peg_type: "peggedREAL",
    direction: "above",
    peak_deviation_bps: 180,
    started_at: 1_750_000_000 - 3600,
    ended_at: null,
    start_price: 0.1909,
    peak_price: 0.191,
    recovery_price: null,
    peg_reference: 0.18765951,
    source: "live",
    confirmation_sources: null,
    pending_reason: null,
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

  it("suppresses a live mutation when the native quote shows recovery", () => {
    const decision = decideDepegAsset({
      now: 1_750_000_000,
      asset: makeAsset({
        id: "brz-transfero",
        symbol: "BRZ",
        price: 0.190587,
        pegType: "peggedREAL",
      }),
      meta: brlMeta,
      pegRates: { peggedREAL: 0.18765951 },
      pegRateSources: { peggedREAL: "fallback" },
      pegRateCounts: { peggedREAL: 2 },
      nativePegQuote: {
        stablecoinId: "brz-transfero",
        geckoId: "brz",
        pegCurrency: "BRL",
        price: 0.995,
        updatedAt: 1_750_000_000 - 60,
      },
    });

    expect(decision.trackedCoinId).toBe("brz-transfero");
    expect(decision.commands).toHaveLength(0);
    expect(decision.diagnostics).toEqual([
      {
        level: "warn",
        message: "[depeg] Suppressed live depeg mutation for BRZ: primary=156bps but direct BRL quote=-50bps",
      },
    ]);
  });

  it("keeps an existing event open when the native quote still supports it", () => {
    const decision = decideDepegAsset({
      now: 1_750_000_000,
      asset: makeAsset({
        id: "brz-transfero",
        symbol: "BRZ",
        price: 0.18765951,
        pegType: "peggedREAL",
      }),
      meta: brlMeta,
      existing: makeExistingEvent(),
      pegRates: { peggedREAL: 0.18765951 },
      pegRateSources: { peggedREAL: "fallback" },
      pegRateCounts: { peggedREAL: 2 },
      nativePegQuote: {
        stablecoinId: "brz-transfero",
        geckoId: "brz",
        pegCurrency: "BRL",
        price: 1.02,
        updatedAt: 1_750_000_000 - 60,
      },
    });

    expect(decision.trackedCoinId).toBe("brz-transfero");
    expect(decision.seenEventIds).toEqual([7]);
    expect(decision.commands).toHaveLength(0);
    expect(decision.diagnostics).toEqual([
      {
        level: "warn",
        message: "[depeg] Kept BRZ open despite primary recovery: primary=0bps but direct BRL quote=200bps",
      },
    ]);
  });
});

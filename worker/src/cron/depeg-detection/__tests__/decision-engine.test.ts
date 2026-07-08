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

  it("opens a fresh independent multi-source extreme move for non-large-cap assets", () => {
    const decision = decideDepegAsset({
      now: 1_750_000_000,
      asset: makeAsset({
        id: "msusd-main-street",
        symbol: "msUSD",
        price: 0.2,
        priceSource: "coingecko+defillama-list",
        priceConfidence: "high",
        agreeSources: ["coingecko", "defillama-list"],
        priceUpdatedAt: 1_750_000_000 - 60,
        circulating: { ethereum: 20_000_000 },
      }),
      meta: {
        ...usdMeta,
        id: "msusd-main-street",
        name: "Main Street USD",
        symbol: "msUSD",
        geckoId: "main-street-usd",
      },
      pegRates: { peggedUSD: 1 },
      pegRateSources: { peggedUSD: "median" },
      pegRateCounts: { peggedUSD: 4 },
    });

    expect(decision.trackedCoinId).toBe("msusd-main-street");
    expect(decision.commands).toHaveLength(1);
    expect(decision.commands[0]).toMatchObject({
      type: "insert-live",
      event: {
        stablecoinId: "msusd-main-street",
        direction: "below",
        peakDeviationBps: -8000,
        startPrice: 0.2,
      },
    });
    expect(decision.diagnostics).toHaveLength(0);
  });

  it("keeps same-family extreme moves pending even when two source labels agree", () => {
    const decision = decideDepegAsset({
      now: 1_750_000_000,
      asset: makeAsset({
        price: 0.2,
        priceSource: "coingecko+coingecko-low-volume",
        priceConfidence: "high",
        agreeSources: ["coingecko", "coingecko-low-volume"],
        priceUpdatedAt: 1_750_000_000 - 60,
        circulating: { ethereum: 20_000_000 },
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
        bps: -8000,
        reason: "extreme-move+low-confidence",
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

  it("opens a supported native-peg depeg when primary peer reference is inside threshold", () => {
    const decision = decideDepegAsset({
      now: 1_750_000_000,
      asset: makeAsset({
        id: "brz-transfero",
        symbol: "BRZ",
        price: 0.191187,
        priceSource: "coingecko",
        priceUpdatedAt: 1_750_000_000 - 60,
        pegType: "peggedREAL",
        circulating: { gnosis: 22_000_000 },
      }),
      meta: brlMeta,
      pegRates: { peggedREAL: 0.191895 },
      pegRateSources: { peggedREAL: "median" },
      pegRateCounts: { peggedREAL: 3 },
      nativePegQuote: {
        stablecoinId: "brz-transfero",
        geckoId: "brz",
        pegCurrency: "BRL",
        price: 0.9758,
        updatedAt: 1_750_000_000 - 60,
      },
    });

    expect(decision.trackedCoinId).toBe("brz-transfero");
    expect(decision.commands).toHaveLength(1);
    expect(decision.commands[0]).toMatchObject({
      type: "insert-live",
      event: {
        stablecoinId: "brz-transfero",
        direction: "below",
        peakDeviationBps: -242,
        startPrice: 0.9758,
        pegReference: 1,
      },
    });
    expect(decision.diagnostics).toEqual([
      {
        level: "log",
        message: "[depeg] Opened native-peg depeg for BRZ: primary=-37bps, direct BRL quote=-242bps",
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

  it("keeps an existing event open when a high-TVL pool challenger contradicts primary recovery", () => {
    const decision = decideDepegAsset({
      now: 1_780_630_000,
      asset: makeAsset({
        id: "apxusd-apyx",
        symbol: "apxUSD",
        price: 1.0006461557,
        priceSource: "coingecko+defillama-list",
        priceConfidence: "high",
        agreeSources: ["coingecko", "defillama-list"],
        priceUpdatedAt: 1_780_629_940,
        circulating: { ethereum: 353_000_000 },
      }),
      meta: {
        ...usdMeta,
        id: "apxusd-apyx",
        name: "apxUSD",
        symbol: "apxUSD",
        geckoId: "apxusd",
      },
      existing: makeExistingEvent({
        id: 90089,
        stablecoin_id: "apxusd-apyx",
        symbol: "apxUSD",
        peg_type: "peggedUSD",
        direction: "below",
        peak_deviation_bps: -1059,
        started_at: 1_780_437_028,
        start_price: 0.9892624763,
        peak_price: 0.8938719491,
        peg_reference: 1,
      }),
      pegRates: { peggedUSD: 1 },
      pegRateSources: { peggedUSD: "median" },
      pegRateCounts: { peggedUSD: 4 },
      challengerPools: [
        {
          price: 0.952866583,
          tvlUsd: 52_000_000,
          protocol: "curve",
          chain: "ethereum",
          sourceFamily: "geckoterminal",
        },
      ],
    });

    expect(decision.trackedCoinId).toBe("apxusd-apyx");
    expect(decision.seenEventIds).toEqual([90089]);
    expect(decision.commands).toHaveLength(0);
    expect(decision.diagnostics).toEqual([
      {
        level: "warn",
        message: "[depeg] Kept apxUSD open despite primary recovery: pool challengers still show the below depeg (groups=1, highTvl=true)",
      },
    ]);
  });

  it("allows authoritative primary recovery when only one small pool challenger disagrees", () => {
    const decision = decideDepegAsset({
      now: 1_780_630_000,
      asset: makeAsset({
        price: 1.0006,
        priceSource: "coingecko+defillama-list",
        priceConfidence: "high",
        agreeSources: ["coingecko", "defillama-list"],
        priceUpdatedAt: 1_780_629_940,
        circulating: { ethereum: 353_000_000 },
      }),
      meta: usdMeta,
      existing: makeExistingEvent({
        id: 42,
        stablecoin_id: "usdt-tether",
        symbol: "USDT",
        peg_type: "peggedUSD",
        direction: "below",
        peak_deviation_bps: -250,
        started_at: 1_780_600_000,
        start_price: 0.98,
        peg_reference: 1,
      }),
      pegRates: { peggedUSD: 1 },
      pegRateSources: { peggedUSD: "median" },
      pegRateCounts: { peggedUSD: 4 },
      challengerPools: [
        {
          price: 0.985,
          tvlUsd: 250_000,
          protocol: "curve",
          chain: "ethereum",
          sourceFamily: "geckoterminal",
        },
      ],
    });

    expect(decision.seenEventIds).toEqual([]);
    expect(decision.commands).toEqual([
      {
        type: "close-event",
        id: 42,
        endedAt: 1_780_630_000,
        recoveryPrice: 1.0006,
        closeReason: "recovered-primary",
      },
    ]);
  });
});

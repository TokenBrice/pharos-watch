import { describe, expect, it, vi } from "vitest";
import type { PegAssetBase, StablecoinMeta } from "@shared/types/core";
import { DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC } from "@shared/lib/depeg-closure";
import { makeDepegRow } from "../../../test-helpers/__shared/fixtures";
import { decideDepegAsset } from "../decision-engine";
import type { DepegDetectionRow } from "../types";

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

const chfMeta: StablecoinMeta = {
  id: "vchf-vnx",
  name: "VNX Swiss Franc",
  symbol: "VCHF",
  flags: {
    backing: "rwa-backed",
    pegCurrency: "CHF",
    governance: "centralized",
    yieldBearing: false,
    rwa: true,
    navToken: false,
  },
  geckoId: "vnx-swiss-franc",
};

const goldMeta: StablecoinMeta = {
  id: "vnxau-vnx",
  name: "VNX Gold",
  symbol: "VNXAU",
  flags: {
    backing: "rwa-backed",
    pegCurrency: "GOLD",
    governance: "centralized",
    yieldBearing: false,
    rwa: true,
    navToken: false,
  },
  geckoId: "vnx-gold",
  commodityOunces: 0.0321507466,
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

function makeExistingEvent(overrides: Partial<DepegDetectionRow> = {}): DepegDetectionRow {
  return {
    ...makeDepegRow({
      id: 7,
      stablecoin_id: "brz-transfero",
      symbol: "BRZ",
      peg_type: "peggedREAL",
      direction: "above",
      peak_deviation_bps: 180,
      started_at: 1_750_000_000 - 3600,
      start_price: 0.1909,
      peak_price: 0.191,
      peg_reference: 0.18765951,
    }),
    confirmation_sources: null,
    pending_reason: null,
    ...overrides,
  };
}

function assertNativeOpening({
  circulating,
  nativePrice,
  expectedBps,
  expectedReason,
  expectSeenEventIds = false,
}: {
  circulating: Record<string, number>;
  nativePrice: number;
  expectedBps: number;
  expectedReason: string;
  expectSeenEventIds?: boolean;
}) {
  const decision = decideDepegAsset({
    now: 1_750_000_000,
    asset: makeAsset({
      id: "brz-transfero",
      symbol: "BRZ",
      price: 0.191187,
      priceSource: "coingecko",
      priceUpdatedAt: 1_750_000_000 - 60,
      pegType: "peggedREAL",
      circulating,
    }),
    meta: brlMeta,
    pegRates: { peggedREAL: 0.191895 },
    pegRateSources: { peggedREAL: "median" },
    pegRateCounts: { peggedREAL: 3 },
    nativePegQuote: {
      stablecoinId: "brz-transfero",
      geckoId: "brz",
      pegCurrency: "BRL",
      price: nativePrice,
      updatedAt: 1_750_000_000 - 60,
    },
  });

  expect(decision.trackedCoinId).toBe("brz-transfero");
  if (expectSeenEventIds) expect(decision.seenEventIds).toEqual([]);
  expect(decision.commands).toHaveLength(1);
  expect(decision.commands[0]).toMatchObject({
    type: "upsert-pending",
    payload: {
      stablecoinId: "brz-transfero",
      direction: "below",
      bps: expectedBps,
      price: nativePrice,
      pegReference: 1,
      reason: expectedReason,
    },
  });
  expect(decision.diagnostics).toEqual([
    {
      level: "log",
      message: `[depeg] Pending native-peg confirmation for BRZ: ${expectedBps}bps against BRL quote`,
    },
  ]);
}

describe("decideDepegAsset", () => {
  it("routes an authoritative small-cap depeg through pending confirmation", () => {
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
      type: "upsert-pending",
      payload: {
        stablecoinId: "usdt-tether",
        direction: "below",
        bps: -200,
        price: 0.98,
        pegReference: 1,
        reason: "confirmation-window",
      },
    });
    expect(decision.diagnostics).toEqual([{
      level: "log",
      message: "[depeg] Pending confirmation for USDT: -200bps (confirmation-window)",
    }]);

    const directionFlip = decideDepegAsset({
      now: 1_750_000_000,
      asset: makeAsset({ price: 1.02 }),
      meta: usdMeta,
      existing: makeExistingEvent({
        stablecoin_id: "usdt-tether",
        symbol: "USDT",
        peg_type: "peggedUSD",
        direction: "below",
        peg_reference: 1,
      }),
      pegRates: { peggedUSD: 1 },
      pegRateSources: { peggedUSD: "median" },
      pegRateCounts: { peggedUSD: 4 },
    });
    expect(directionFlip.commands[0]).toMatchObject({
      type: "close-event",
      recoveryPrice: null,
      closeReason: "superseded-direction",
    });
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
          reason: "confirmation-window+large-cap",
        },
      });
      expect(decision.diagnostics).toEqual([
        {
          level: "log",
          message: "[depeg] Pending confirmation for USDT: -200bps (confirmation-window+large-cap)",
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
        reason: "confirmation-window+large-cap",
      },
    });
  });

  it("requires the confirmation window even with strong primary evidence", () => {
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
      type: "upsert-pending",
      payload: {
        stablecoinId: "usdt-tether",
        direction: "below",
        bps: -150,
        reason: "confirmation-window",
      },
    });
  });

  it("does not start confirmation when only the rounded value reaches the threshold", () => {
    const decision = decideDepegAsset({
      now: 1_750_000_000,
      asset: makeAsset({ price: 0.99005 }),
      meta: usdMeta,
      pegRates: { peggedUSD: 1 },
      pegRateSources: { peggedUSD: "median" },
      pegRateCounts: { peggedUSD: 4 },
    });

    expect(decision.commands).toEqual([]);
  });

  it("requires the confirmation window for independent multi-source extreme moves", () => {
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
      type: "upsert-pending",
      payload: {
        stablecoinId: "msusd-main-street",
        direction: "below",
        bps: -8000,
        price: 0.2,
        reason: "confirmation-window+extreme-move+low-confidence",
      },
    });
    expect(decision.diagnostics).toHaveLength(1);
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
        reason: "confirmation-window+extreme-move+low-confidence",
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
        message: "[depeg] Suppressed live depeg mutation for BRZ: primary=156bps but BRL quote=-50bps",
      },
    ]);
  });

  it("routes a supported native-peg depeg through pending confirmation", () => {
    assertNativeOpening({
      circulating: { gnosis: 22_000_000 },
      nativePrice: 0.9758,
      expectedBps: -242,
      expectedReason: "confirmation-window+native-origin",
    });
  });

  it("routes large-cap native-peg openings to pending confirmation", () => {
    assertNativeOpening({
      circulating: { gnosis: 2_000_000_000 },
      nativePrice: 0.9758,
      expectedBps: -242,
      expectedReason: "confirmation-window+large-cap+native-origin",
      expectSeenEventIds: true,
    });
  });

  it("routes extreme native-peg openings to pending confirmation", () => {
    assertNativeOpening({
      circulating: { gnosis: 22_000_000 },
      nativePrice: 0.2,
      expectedBps: -8000,
      expectedReason: "confirmation-window+extreme-move+native-origin",
      expectSeenEventIds: true,
    });
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
        message: "[depeg] Kept BRZ open despite primary recovery: primary=0bps but BRL quote=200bps",
      },
    ]);
  });

  it("closes a native-peg event after sustained recovery in native units", () => {
    const decision = decideDepegAsset({
      now: 1_750_000_900,
      asset: makeAsset({
        id: "brz-transfero",
        symbol: "BRZ",
        price: 0.1919,
        pegType: "peggedREAL",
      }),
      meta: brlMeta,
      existing: makeExistingEvent({
        direction: "below",
        peak_deviation_bps: -242,
        start_price: 0.9758,
        peak_price: 0.9758,
        peg_reference: 1,
        recovery_first_seen_at: 1_750_000_000,
        recovery_last_seen_at: 1_750_000_000,
      }),
      pegRates: { peggedREAL: 0.191895 },
      pegRateSources: { peggedREAL: "median" },
      pegRateCounts: { peggedREAL: 3 },
      nativePegQuote: {
        stablecoinId: "brz-transfero",
        geckoId: "brz",
        pegCurrency: "BRL",
        price: 0.997,
        updatedAt: 1_750_000_840,
      },
    });

    expect(decision.commands).toEqual([
      {
        type: "close-event",
        id: 7,
        endedAt: 1_750_000_900,
        recoveryPrice: 0.997,
        closeReason: "recovered-native",
      },
    ]);
  });

  it("holds a native-peg event open when the native quote is missing", () => {
    const decision = decideDepegAsset({
      now: 1_750_000_900,
      asset: makeAsset({
        id: "brz-transfero",
        symbol: "BRZ",
        price: 0.1919,
        pegType: "peggedREAL",
      }),
      meta: brlMeta,
      existing: makeExistingEvent({
        direction: "below",
        peak_deviation_bps: -242,
        start_price: 0.9758,
        peak_price: 0.9758,
        peg_reference: 1,
      }),
      pegRates: { peggedREAL: 0.191895 },
      pegRateSources: { peggedREAL: "median" },
      pegRateCounts: { peggedREAL: 3 },
    });

    expect(decision.seenEventIds).toEqual([7]);
    expect(decision.commands).toEqual([]);
  });

  it("does not supersede a native event from an opposite USD-domain signal", () => {
    const decision = decideDepegAsset({
      now: 1_750_000_900,
      asset: makeAsset({
        id: "brz-transfero",
        symbol: "BRZ",
        price: 0.195,
        pegType: "peggedREAL",
      }),
      meta: brlMeta,
      existing: makeExistingEvent({
        direction: "below",
        peak_deviation_bps: -242,
        start_price: 0.9758,
        peak_price: 0.9758,
        peg_reference: 1,
      }),
      pegRates: { peggedREAL: 0.191895 },
      pegRateSources: { peggedREAL: "median" },
      pegRateCounts: { peggedREAL: 3 },
      nativePegQuote: {
        stablecoinId: "brz-transfero",
        geckoId: "brz",
        pegCurrency: "BRL",
        price: 0.9758,
        updatedAt: 1_750_000_840,
      },
    });

    expect(decision.seenEventIds).toEqual([7]);
    expect(decision.commands).not.toContainEqual(expect.objectContaining({
      type: "close-event",
      closeReason: "superseded-direction",
    }));
  });

  it("supersedes a native-peg event when the native quote reverses direction", () => {
    const decision = decideDepegAsset({
      now: 1_750_000_900,
      asset: makeAsset({
        id: "brz-transfero",
        symbol: "BRZ",
        price: 0.1919,
        pegType: "peggedREAL",
      }),
      meta: brlMeta,
      existing: makeExistingEvent({
        direction: "below",
        peak_deviation_bps: -242,
        start_price: 0.9758,
        peak_price: 0.9758,
        peg_reference: 1,
      }),
      pegRates: { peggedREAL: 0.191895 },
      pegRateSources: { peggedREAL: "median" },
      pegRateCounts: { peggedREAL: 3 },
      nativePegQuote: {
        stablecoinId: "brz-transfero",
        geckoId: "brz",
        pegCurrency: "BRL",
        price: 1.03,
        updatedAt: 1_750_000_840,
      },
    });

    expect(decision.seenEventIds).toEqual([]);
    expect(decision.commands).toEqual([
      {
        type: "close-event",
        id: 7,
        endedAt: 1_750_000_900,
        recoveryPrice: null,
        closeReason: "superseded-direction",
      },
      expect.objectContaining({
        type: "upsert-pending",
        payload: expect.objectContaining({
          stablecoinId: "brz-transfero",
          direction: "above",
          bps: 300,
          price: 1.03,
          pegReference: 1,
          reason: expect.stringContaining("native-origin"),
        }),
      }),
    ]);
  });

  it("keeps a live event when an untrusted primary reading reverses direction", () => {
    const decision = decideDepegAsset({
      now: 1_750_000_900,
      asset: makeAsset({
        price: 1.02,
        priceSource: "cached",
        priceConfidence: "low",
      }),
      meta: usdMeta,
      existing: makeExistingEvent({
        stablecoin_id: "usdt-tether",
        symbol: "USDT",
        peg_type: "peggedUSD",
        direction: "below",
        peak_deviation_bps: -200,
        start_price: 0.98,
        peak_price: 0.98,
        peg_reference: 1,
      }),
      pegRates: { peggedUSD: 1 },
      pegRateSources: { peggedUSD: "median" },
      pegRateCounts: { peggedUSD: 4 },
    });

    expect(decision.seenEventIds).toEqual([7]);
    expect(decision.commands).toEqual([]);
    expect(decision.diagnostics).toEqual([
      {
        level: "warn",
        message: "[depeg] Kept live event for USDT (id=7) through confirm-required opposite reading: existing=below, primary=above (200bps)",
      },
    ]);
  });

  it("closes a live event when circulating coverage falls below the event floor", () => {
    const decision = decideDepegAsset({
      now: 1_750_000_900,
      asset: makeAsset({ circulating: { ethereum: 1 } }),
      meta: usdMeta,
      existing: makeExistingEvent({
        stablecoin_id: "usdt-tether",
        symbol: "USDT",
        peg_type: "peggedUSD",
        direction: "below",
        peg_reference: 1,
      }),
      pegRates: { peggedUSD: 1 },
      pegRateSources: { peggedUSD: "median" },
      pegRateCounts: { peggedUSD: 4 },
    });

    expect(decision.seenEventIds).toEqual([]);
    expect(decision.commands).toEqual([
      {
        type: "close-event",
        id: 7,
        endedAt: 1_750_000_900,
        recoveryPrice: null,
        closeReason: "coverage-lost-supply",
      },
    ]);
    expect(decision.diagnostics).toEqual([
      {
        level: "log",
        message: "[depeg] Closing live event for USDT: supply $1 is below the live-event floor",
      },
    ]);
  });

  it("preserves a live event when a thin fiat peg reference is not authoritative", () => {
    const decision = decideDepegAsset({
      now: 1_750_000_900,
      asset: makeAsset({
        id: "brz-transfero",
        symbol: "BRZ",
        price: 0.1919,
        pegType: "peggedREAL",
      }),
      meta: brlMeta,
      existing: makeExistingEvent(),
      pegRates: { peggedREAL: 0.191895 },
      pegRateSources: { peggedREAL: "median" },
      pegRateCounts: { peggedREAL: 2 },
    });

    expect(decision.seenEventIds).toEqual([7]);
    expect(decision.commands).toEqual([]);
    expect(decision.diagnostics).toEqual([
      {
        level: "warn",
        message: "[depeg] Skipped live-state mutation for BRZ: thin BRL peg reference lacks FX fallback",
      },
    ]);
  });

  it("keeps an ongoing event open when only the aggregate DEX price disagrees", () => {
    const decision = decideDepegAsset({
      now: 1_750_000_900,
      asset: makeAsset({ price: 0.98 }),
      meta: usdMeta,
      existing: makeExistingEvent({
        stablecoin_id: "usdt-tether",
        symbol: "USDT",
        peg_type: "peggedUSD",
        direction: "below",
        peak_deviation_bps: -200,
        started_at: 1_749_997_300,
        start_price: 0.98,
        peak_price: 0.98,
        peg_reference: 1,
      }),
      pegRates: { peggedUSD: 1 },
      pegRateSources: { peggedUSD: "median" },
      pegRateCounts: { peggedUSD: 4 },
      dexRow: {
        stablecoin_id: "usdt-tether",
        dex_price_usd: 1.001,
        deviation_from_primary_bps: null,
        source_pool_count: 5,
        source_total_tvl: 5_000_000,
        updated_at: 1_750_000_840,
      },
    });

    expect(decision.seenEventIds).toEqual([7]);
    expect(decision.commands).toEqual([]);
    expect(decision.diagnostics).toEqual([
      {
        level: "warn",
        message: "[depeg] DEX disagrees with ongoing event for USDT: primary=-200bps vs DEX=10bps (event age 60min); keeping event open until the recovery path confirms resolution",
      },
    ]);
  });

  it("suppresses a new event when independent DEX protocols show recovery", () => {
    const decision = decideDepegAsset({
      now: 1_750_000_900,
      asset: makeAsset({ price: 0.98 }),
      meta: usdMeta,
      pegRates: { peggedUSD: 1 },
      pegRateSources: { peggedUSD: "median" },
      pegRateCounts: { peggedUSD: 4 },
      dexRow: {
        stablecoin_id: "usdt-tether",
        dex_price_usd: 0.999,
        deviation_from_primary_bps: null,
        source_pool_count: 2,
        source_total_tvl: 5_000_000,
        updated_at: 1_750_000_840,
      },
      protocolSources: [
        {
          protocol: "curve",
          chain: "ethereum",
          sourceFamily: "curve",
          price: 0.999,
          tvl: 2_500_000,
          updatedAt: 1_750_000_840,
        },
        {
          protocol: "uniswap-v3",
          chain: "ethereum",
          sourceFamily: "uniswap-v3",
          price: 1.001,
          tvl: 2_500_000,
          updatedAt: 1_750_000_840,
        },
      ],
    });

    expect(decision.seenEventIds).toEqual([]);
    expect(decision.commands).toEqual([]);
    expect(decision.diagnostics).toEqual([
      {
        level: "log",
        message: "[depeg] Suppressed new event for USDT: primary=-200bps but DEX=10bps (2 pools, $5.0M TVL)",
      },
    ]);
  });

  it("clears recovery progress when independent DEX protocols still show the depeg", () => {
    const decision = decideDepegAsset({
      now: 1_750_000_900,
      asset: makeAsset({ price: 1.001 }),
      meta: usdMeta,
      existing: makeExistingEvent({
        stablecoin_id: "usdt-tether",
        symbol: "USDT",
        peg_type: "peggedUSD",
        direction: "below",
        peak_deviation_bps: -200,
        start_price: 0.98,
        peak_price: 0.98,
        peg_reference: 1,
        recovery_first_seen_at: 1_750_000_300,
        recovery_last_seen_at: 1_750_000_840,
      }),
      pegRates: { peggedUSD: 1 },
      pegRateSources: { peggedUSD: "median" },
      pegRateCounts: { peggedUSD: 4 },
      dexRow: {
        stablecoin_id: "usdt-tether",
        dex_price_usd: 0.98,
        deviation_from_primary_bps: null,
        source_pool_count: 2,
        source_total_tvl: 5_000_000,
        updated_at: 1_750_000_840,
      },
      protocolSources: [
        {
          protocol: "curve",
          chain: "ethereum",
          sourceFamily: "curve",
          price: 0.98,
          tvl: 2_500_000,
          updatedAt: 1_750_000_840,
        },
        {
          protocol: "uniswap-v3",
          chain: "ethereum",
          sourceFamily: "uniswap-v3",
          price: 0.981,
          tvl: 2_500_000,
          updatedAt: 1_750_000_840,
        },
      ],
    });

    expect(decision.seenEventIds).toEqual([7]);
    expect(decision.commands).toEqual([{ type: "clear-recovery", id: 7 }]);
    expect(decision.diagnostics).toEqual([
      {
        level: "warn",
        message: "[depeg] Kept USDT open despite primary recovery: primary recovery is contradicted by 2 DEX protocol group(s) still showing the below depeg",
      },
    ]);
  });

  it("keeps a recovered reading open when DEX recovery lacks independent support", () => {
    const decision = decideDepegAsset({
      now: 1_750_000_900,
      asset: makeAsset({
        price: 1.001,
        priceSource: "cached",
        priceConfidence: "low",
      }),
      meta: usdMeta,
      existing: makeExistingEvent({
        stablecoin_id: "usdt-tether",
        symbol: "USDT",
        peg_type: "peggedUSD",
        direction: "below",
        peak_deviation_bps: -200,
        start_price: 0.98,
        peak_price: 0.98,
        peg_reference: 1,
      }),
      pegRates: { peggedUSD: 1 },
      pegRateSources: { peggedUSD: "median" },
      pegRateCounts: { peggedUSD: 4 },
      dexRow: {
        stablecoin_id: "usdt-tether",
        dex_price_usd: 0.999,
        deviation_from_primary_bps: null,
        source_pool_count: 1,
        source_total_tvl: 5_000_000,
        updated_at: 1_750_000_840,
      },
      protocolSources: [
        {
          protocol: "curve",
          chain: "ethereum",
          sourceFamily: "curve",
          price: 0.999,
          tvl: 5_000_000,
          updatedAt: 1_750_000_840,
        },
      ],
    });

    expect(decision.seenEventIds).toEqual([7]);
    expect(decision.commands).toEqual([]);
    expect(decision.diagnostics).toEqual([
      {
        level: "warn",
        message: "[depeg] Ignored aggregate DEX recovery for USDT: 1 corroborating protocol group(s), challenged=false; keeping event open until corroborated recovery appears",
      },
    ]);
  });

  it("continues recovery after a recent confirming observation", () => {
    const decision = decideDepegAsset({
      now: 1_750_000_900,
      asset: makeAsset({ price: 1.001 }),
      meta: usdMeta,
      existing: makeExistingEvent({
        stablecoin_id: "usdt-tether",
        symbol: "USDT",
        peg_type: "peggedUSD",
        direction: "below",
        peak_deviation_bps: -200,
        start_price: 0.98,
        peak_price: 0.98,
        peg_reference: 1,
        recovery_first_seen_at: 1_750_000_600,
        recovery_last_seen_at: 1_750_000_840,
      }),
      pegRates: { peggedUSD: 1 },
      pegRateSources: { peggedUSD: "median" },
      pegRateCounts: { peggedUSD: 4 },
    });

    expect(decision.seenEventIds).toEqual([7]);
    expect(decision.commands).toEqual([
      {
        type: "continue-recovery",
        id: 7,
        lastSeenAt: 1_750_000_900,
      },
    ]);
  });

  it("clears recovery progress when the primary price returns to the depeg", () => {
    const decision = decideDepegAsset({
      now: 1_750_000_900,
      asset: makeAsset({ price: 0.98 }),
      meta: usdMeta,
      existing: makeExistingEvent({
        stablecoin_id: "usdt-tether",
        symbol: "USDT",
        peg_type: "peggedUSD",
        direction: "below",
        peak_deviation_bps: -300,
        start_price: 0.98,
        peak_price: 0.97,
        peg_reference: 1,
        recovery_first_seen_at: 1_750_000_600,
        recovery_last_seen_at: 1_750_000_840,
      }),
      pegRates: { peggedUSD: 1 },
      pegRateSources: { peggedUSD: "median" },
      pegRateCounts: { peggedUSD: 4 },
    });

    expect(decision.seenEventIds).toEqual([7]);
    expect(decision.commands).toEqual([{ type: "clear-recovery", id: 7 }]);
  });

  it("keeps an event open until the full recovery window elapses", () => {
    const now = 1_750_000_900;
    const tolerance = DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC;
    // Anchored to the tolerance rather than a literal: a gap at or under it is still
    // continuous coverage, one second past it is a blind interval that must reset.
    const decisions = [tolerance - 1, tolerance, tolerance + 1].map((gap) => decideDepegAsset({
      now,
      asset: makeAsset({ price: 1.001 }),
      meta: usdMeta,
      existing: makeExistingEvent({
        stablecoin_id: "usdt-tether",
        symbol: "USDT",
        peg_type: "peggedUSD",
        direction: "below",
        peak_deviation_bps: -200,
        start_price: 0.98,
        peak_price: 0.98,
        peg_reference: 1,
        recovery_first_seen_at: now - gap - 900,
        recovery_last_seen_at: now - gap,
      }),
      pegRates: { peggedUSD: 1 },
      pegRateSources: { peggedUSD: "median" },
      pegRateCounts: { peggedUSD: 4 },
    }));

    expect(decisions[0]?.commands[0]?.type).toBe("close-event");
    expect(decisions[1]?.commands[0]?.type).toBe("close-event");
    expect(decisions[2]?.commands).toEqual([{
      type: "begin-recovery",
      id: 7,
      firstSeenAt: now,
      lastSeenAt: now,
    }]);
  });

  it("clears a partial recovery when price returns to the deadband", () => {
    const decision = decideDepegAsset({
      now: 1_750_000_900,
      asset: makeAsset({ price: 0.993 }),
      meta: usdMeta,
      existing: makeExistingEvent({
        stablecoin_id: "usdt-tether",
        symbol: "USDT",
        peg_type: "peggedUSD",
        direction: "below",
        peak_deviation_bps: -200,
        start_price: 0.98,
        peak_price: 0.98,
        peg_reference: 1,
        recovery_first_seen_at: 1_750_000_300,
      }),
      pegRates: { peggedUSD: 1 },
      pegRateSources: { peggedUSD: "median" },
      pegRateCounts: { peggedUSD: 4 },
    });

    expect(decision.seenEventIds).toEqual([7]);
    expect(decision.commands).toEqual([{ type: "clear-recovery", id: 7 }]);
  });

  it("updates a native-peg event peak from the native quote domain", () => {
    const decision = decideDepegAsset({
      now: 1_750_000_900,
      asset: makeAsset({
        id: "brz-transfero",
        symbol: "BRZ",
        price: 0.1879,
        pegType: "peggedREAL",
      }),
      meta: brlMeta,
      existing: makeExistingEvent({
        direction: "below",
        peak_deviation_bps: -242,
        start_price: 0.9758,
        peak_price: 0.9758,
        peg_reference: 1,
      }),
      pegRates: { peggedREAL: 0.191895 },
      pegRateSources: { peggedREAL: "median" },
      pegRateCounts: { peggedREAL: 3 },
      nativePegQuote: {
        stablecoinId: "brz-transfero",
        geckoId: "brz",
        pegCurrency: "BRL",
        price: 0.97,
        updatedAt: 1_750_000_840,
      },
    });

    expect(decision.commands).toEqual([
      {
        type: "update-peak",
        id: 7,
        peakDeviationBps: -300,
        peakPrice: 0.97,
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
        message: "[depeg] Kept apxUSD open despite primary recovery: pool challengers still show the below depeg (groups=1, corroborating=0, highTvl=true)",
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

    expect(decision.seenEventIds).toEqual([42]);
    expect(decision.commands).toEqual([
      {
        type: "begin-recovery",
        id: 42,
        firstSeenAt: 1_780_630_000,
        lastSeenAt: 1_780_630_000,
      },
    ]);
  });

  it("allows primary recovery when two dormant diverging pools are outvoted by four at-peg pools", () => {
    const now = 1_790_226_624;
    const decision = decideDepegAsset({
      now,
      asset: makeAsset({
        id: "vchf-vnx",
        symbol: "VCHF",
        price: 1.2130161427,
        priceSource: "coingecko+defillama-list",
        priceConfidence: "high",
        agreeSources: ["coingecko", "defillama-list"],
        priceUpdatedAt: now - 60,
        pegType: "peggedCHF",
        circulating: { ethereum: 5_000_000 },
      }),
      meta: chfMeta,
      existing: makeExistingEvent({
        id: 90792,
        stablecoin_id: "vchf-vnx",
        symbol: "VCHF",
        peg_type: "peggedCHF",
        direction: "above",
        peak_deviation_bps: 640,
        started_at: now - 6 * 86_400,
        start_price: 1.2887194119,
        peak_price: 1.2887194119,
        peg_reference: 1.2128709869131222,
      }),
      pegRates: { peggedCHF: 1.2128709869131222 },
      pegRateSources: { peggedCHF: "median" },
      pegRateCounts: { peggedCHF: 4 },
      // Reproduced 2026-09-24 from dex_price_challengers for vchf-vnx: the two
      // diverging venues are the dormant Celo Uniswap v3 pool (24h volume 0,
      // provider-reported $4.7M reserve, last trade 2026-03-15) and the
      // zero-volume ICP kongswap pool; four live protocols sat at the reference.
      challengerPools: [
        { price: 1.2887194119, tvlUsd: 4_712_969.3671, protocol: "uniswap-v3", chain: "celo", sourceFamily: "cg_onchain" },
        { price: 1.2745982598, tvlUsd: 380_730.3996, protocol: "kongswap", chain: "icp", sourceFamily: "cg_onchain" },
        { price: 1.2130161427, tvlUsd: 524_244.1538, protocol: "icpswap", chain: "icp", sourceFamily: "cg_onchain" },
        { price: 1.2211210441, tvlUsd: 414_750.15, protocol: "raydium", chain: "solana", sourceFamily: "direct_api" },
        { price: 1.2180939432, tvlUsd: 184_761.4457, protocol: "aerodrome", chain: "base", sourceFamily: "direct_api" },
        { price: 1.2000335351, tvlUsd: 130_340.6422, protocol: "meteora", chain: "solana", sourceFamily: "cg_onchain" },
      ],
    });

    expect(decision.trackedCoinId).toBe("vchf-vnx");
    expect(decision.seenEventIds).toEqual([90792]);
    expect(decision.commands).toEqual([
      {
        type: "begin-recovery",
        id: 90792,
        firstSeenAt: now,
        lastSeenAt: now,
      },
    ]);
    expect(decision.diagnostics).toEqual([]);
  });

  it("keeps an event open when the diverging pools are the majority against the recovered price", () => {
    const now = 1_780_630_000;
    const decision = decideDepegAsset({
      now,
      asset: makeAsset({
        price: 1.0004,
        priceSource: "coingecko+defillama-list",
        priceConfidence: "high",
        agreeSources: ["coingecko", "defillama-list"],
        priceUpdatedAt: now - 60,
        circulating: { ethereum: 353_000_000 },
      }),
      meta: usdMeta,
      existing: makeExistingEvent({
        id: 42,
        stablecoin_id: "usdt-tether",
        symbol: "USDT",
        peg_type: "peggedUSD",
        direction: "above",
        peak_deviation_bps: 250,
        started_at: now - 3_600,
        start_price: 1.025,
        peak_price: 1.025,
        peg_reference: 1,
      }),
      pegRates: { peggedUSD: 1 },
      pegRateSources: { peggedUSD: "median" },
      pegRateCounts: { peggedUSD: 4 },
      challengerPools: [
        { price: 1.02, tvlUsd: 1_000_000, protocol: "curve", chain: "ethereum", sourceFamily: "geckoterminal" },
        { price: 1.021, tvlUsd: 1_000_000, protocol: "uniswap-v3", chain: "ethereum", sourceFamily: "cg_onchain" },
        { price: 1.0005, tvlUsd: 1_000_000, protocol: "raydium", chain: "solana", sourceFamily: "direct_api" },
      ],
    });

    expect(decision.seenEventIds).toEqual([42]);
    expect(decision.commands).toEqual([]);
    expect(decision.diagnostics).toEqual([
      {
        level: "warn",
        message: "[depeg] Kept USDT open despite primary recovery: pool challengers still show the above depeg (groups=2, corroborating=1, highTvl=false)",
      },
    ]);
  });

  it("keeps the diverging set decisive on a tie against corroborating pools", () => {
    const now = 1_780_630_000;
    const decision = decideDepegAsset({
      now,
      asset: makeAsset({
        price: 1.0004,
        priceSource: "coingecko+defillama-list",
        priceConfidence: "high",
        agreeSources: ["coingecko", "defillama-list"],
        priceUpdatedAt: now - 60,
        circulating: { ethereum: 353_000_000 },
      }),
      meta: usdMeta,
      existing: makeExistingEvent({
        id: 42,
        stablecoin_id: "usdt-tether",
        symbol: "USDT",
        peg_type: "peggedUSD",
        direction: "above",
        peak_deviation_bps: 250,
        started_at: now - 3_600,
        start_price: 1.025,
        peak_price: 1.025,
        peg_reference: 1,
      }),
      pegRates: { peggedUSD: 1 },
      pegRateSources: { peggedUSD: "median" },
      pegRateCounts: { peggedUSD: 4 },
      challengerPools: [
        { price: 1.02, tvlUsd: 1_000_000, protocol: "curve", chain: "ethereum", sourceFamily: "geckoterminal" },
        { price: 1.021, tvlUsd: 1_000_000, protocol: "uniswap-v3", chain: "ethereum", sourceFamily: "cg_onchain" },
        { price: 1.0005, tvlUsd: 1_000_000, protocol: "raydium", chain: "solana", sourceFamily: "direct_api" },
        { price: 0.9995, tvlUsd: 1_000_000, protocol: "orca", chain: "solana", sourceFamily: "cg_onchain" },
      ],
    });

    expect(decision.seenEventIds).toEqual([42]);
    expect(decision.commands).toEqual([]);
    expect(decision.diagnostics).toEqual([
      {
        level: "warn",
        message: "[depeg] Kept USDT open despite primary recovery: pool challengers still show the above depeg (groups=2, corroborating=2, highTvl=false)",
      },
    ]);
  });

  it("closes a soft-source recovery on a corroborating challenger-pool majority when the aggregate DEX row is withheld", () => {
    // Reproduced 2026-09-24 from live D1 (event 90781, usdb-blast). The coin's
    // only primary lane is a fresh CoinGecko single-source print, and
    // computeDexPrices withholds its aggregate dex_prices row because
    // loadTrackedStablecoinMaps preloads only prices that already clear the
    // primary trust gates — so the aggregate-DEX recovery lane was structurally
    // unreachable. All five published challenger pools (thruster-v3,
    // monoswap-v3-blast, blasterswap) sat inside the 50 bps recovery band.
    const now = 1_790_231_427;
    const decision = decideDepegAsset({
      now,
      asset: makeAsset({
        id: "usdb-blast",
        symbol: "USDB",
        price: 0.9998628369821569,
        priceSource: "coingecko",
        priceConfidence: "single-source",
        agreeSources: ["coingecko"],
        priceUpdatedAt: now - 107,
        priceObservedAt: now - 107,
        priceObservedAtMode: "upstream",
        pegType: "peggedUSD",
        circulating: { blast: 11_348_078.487122247 },
      }),
      meta: { ...usdMeta, id: "usdb-blast", name: "USDB Blast", symbol: "USDB", geckoId: "usdb" },
      existing: makeExistingEvent({
        id: 90781,
        stablecoin_id: "usdb-blast",
        symbol: "USDB",
        peg_type: "peggedUSD",
        direction: "above",
        peak_deviation_bps: 129,
        started_at: 1_787_295_709,
        start_price: 1.0102326760456513,
        peak_price: 1.0129092357526068,
        peg_reference: 0.999963,
        recovery_first_seen_at: now - 1_000,
        recovery_last_seen_at: now - 450,
      }),
      pegRates: { peggedUSD: 1 },
      pegRateSources: { peggedUSD: "median" },
      pegRateCounts: { peggedUSD: 4 },
      challengerPools: [
        { price: 0.995936075327477, tvlUsd: 1_047_212.8546, protocol: "thruster-v3", chain: "blast", sourceFamily: "cg_onchain" },
        { price: 0.997280614842842, tvlUsd: 290_687.4629, protocol: "thruster-v3", chain: "blast", sourceFamily: "cg_onchain" },
        { price: 0.999821125971321, tvlUsd: 157_208.1985, protocol: "thruster-v3", chain: "blast", sourceFamily: "cg_onchain" },
        { price: 1.0007739191, tvlUsd: 108_478.947, protocol: "monoswap-v3-blast", chain: "blast", sourceFamily: "cg_onchain" },
        { price: 0.996110886724201, tvlUsd: 103_778.0611, protocol: "blasterswap", chain: "blast", sourceFamily: "cg_onchain" },
      ],
    });

    expect(decision.seenEventIds).toEqual([]);
    expect(decision.commands).toEqual([
      {
        type: "close-event",
        id: 90781,
        endedAt: now,
        recoveryPrice: 0.995936075327477,
        closeReason: "recovered-dex",
      },
    ]);
    expect(decision.diagnostics).toEqual([
      {
        level: "log",
        message: "[depeg] Pool-challenger majority recovery for USDB: 3 independent group(s) inside the 50bps recovery band outvote 0 diverging group(s)",
      },
    ]);
  });

  it("closes a gold-peg recovery on a corroborating challenger-pool majority", () => {
    // Reproduced 2026-09-24 from live D1 (event 90760, vnxau-vnx): the
    // CoinGecko single-source gram price sat inside the 75 bps commodity
    // recovery band while the published raydium and aerodrome pools confirmed.
    const now = 1_790_231_427;
    const decision = decideDepegAsset({
      now,
      asset: makeAsset({
        id: "vnxau-vnx",
        symbol: "VNXAU",
        price: 137.80559627497053,
        priceSource: "coingecko",
        priceConfidence: "single-source",
        agreeSources: ["coingecko"],
        priceUpdatedAt: now - 77,
        priceObservedAt: now - 77,
        priceObservedAtMode: "upstream",
        pegType: "peggedGOLD",
        circulating: { ethereum: 6_063_570.880773928 },
      }),
      meta: goldMeta,
      existing: makeExistingEvent({
        id: 90760,
        stablecoin_id: "vnxau-vnx",
        symbol: "VNXAU",
        peg_type: "peggedGOLD",
        direction: "below",
        peak_deviation_bps: -178,
        started_at: 1_785_939_393,
        start_price: 133.18916240810498,
        peak_price: 133.36101778049144,
        peg_reference: 135.77096114706222,
        recovery_first_seen_at: now - 1_000,
        recovery_last_seen_at: now - 450,
      }),
      pegRates: { peggedGOLD: 4285 },
      pegRateSources: { peggedGOLD: "median" },
      pegRateCounts: { peggedGOLD: 4 },
      challengerPools: [
        { price: 137.508294070839, tvlUsd: 263_932, protocol: "raydium", chain: "solana", sourceFamily: "direct_api" },
        { price: 138.145893, tvlUsd: 103_282, protocol: "aerodrome", chain: "base", sourceFamily: "direct_api" },
      ],
    });

    expect(decision.commands).toEqual([
      {
        type: "close-event",
        id: 90760,
        endedAt: now,
        recoveryPrice: 137.508294070839,
        closeReason: "recovered-dex",
      },
    ]);
    expect(decision.diagnostics).toEqual([
      {
        level: "log",
        message: "[depeg] Pool-challenger majority recovery for VNXAU: 2 independent group(s) inside the 75bps recovery band outvote 0 diverging group(s)",
      },
    ]);
  });

  it("keeps an in-band soft-source event open when a high-TVL challenger pool still shows the depeg", () => {
    // Reproduced 2026-09-24 from live D1 (event 90786, hollar-hydrated): the
    // low-confidence CoinGecko print sat at -18 bps while every published
    // hydration-dex pool still printed ~-526 bps, one of them above the $5M
    // single-pool challenge carve-out.
    const now = 1_790_231_427;
    const decision = decideDepegAsset({
      now,
      asset: makeAsset({
        id: "hollar-hydrated",
        symbol: "HOLLAR",
        price: 0.9981523059225438,
        priceSource: "coingecko",
        priceConfidence: "low",
        agreeSources: ["coingecko"],
        priceUpdatedAt: now - 77,
        priceObservedAt: now - 77,
        priceObservedAtMode: "upstream",
        pegType: "peggedUSD",
        circulating: { hydration: 12_833_596.24937689 },
      }),
      meta: { ...usdMeta, id: "hollar-hydrated", name: "Hydrated Dollar", symbol: "HOLLAR", geckoId: "hydrated-dollar" },
      existing: makeExistingEvent({
        id: 90786,
        stablecoin_id: "hollar-hydrated",
        symbol: "HOLLAR",
        peg_type: "peggedUSD",
        direction: "below",
        peak_deviation_bps: -525,
        started_at: 1_787_695_308,
        start_price: 0.947458,
        peak_price: 0.947458,
        peg_reference: 1,
        recovery_first_seen_at: now - 1_000,
        recovery_last_seen_at: now - 450,
      }),
      pegRates: { peggedUSD: 1 },
      pegRateSources: { peggedUSD: "median" },
      pegRateCounts: { peggedUSD: 4 },
      challengerPools: [
        { price: 0.9474579112, tvlUsd: 11_916_235.7742, protocol: "hydration-dex", chain: "hydration", sourceFamily: "cg_onchain" },
        { price: 0.9474396418, tvlUsd: 2_460_799.2408, protocol: "hydration-dex", chain: "hydration", sourceFamily: "cg_onchain" },
        { price: 0.9474579112, tvlUsd: 2_255_904.79, protocol: "hydration-dex", chain: "hydration", sourceFamily: "cg_onchain" },
        { price: 0.947411, tvlUsd: 746_895.7, protocol: "hydration-dex", chain: "hydration", sourceFamily: "cg_onchain" },
      ],
    });

    expect(decision.seenEventIds).toEqual([90786]);
    expect(decision.commands).toEqual([{ type: "clear-recovery", id: 90786 }]);
    expect(decision.diagnostics).toEqual([
      {
        level: "warn",
        message: "[depeg] Kept HOLLAR open despite primary recovery: pool challengers still show the below depeg (groups=1, corroborating=0, highTvl=true)",
      },
    ]);
  });

  it("keeps an in-band soft-source event open when only one challenger group corroborates the band", () => {
    // Reproduced 2026-09-24 from live D1 (event 90777, audf-forte): the single
    // published curve pool (-24 bps) is corroboration, but one group is below
    // the POOL_CHALLENGE_CONFIRM_MIN bar for carrying a recovery.
    const now = 1_790_231_427;
    const decision = decideDepegAsset({
      now,
      asset: makeAsset({
        id: "audf-forte",
        symbol: "AUDF",
        price: 0.7030877342041957,
        priceSource: "coingecko",
        priceConfidence: "single-source",
        agreeSources: ["coingecko"],
        priceUpdatedAt: now - 77,
        priceObservedAt: now - 77,
        priceObservedAtMode: "upstream",
        pegType: "peggedAUD",
        circulating: { ethereum: 3_566_436.4980290816 },
      }),
      meta: {
        ...usdMeta,
        id: "audf-forte",
        name: "Forte AUD",
        symbol: "AUDF",
        geckoId: "forte-aud",
        flags: { ...usdMeta.flags, pegCurrency: "AUD" },
      },
      existing: makeExistingEvent({
        id: 90777,
        stablecoin_id: "audf-forte",
        symbol: "AUDF",
        peg_type: "peggedAUD",
        direction: "below",
        peak_deviation_bps: -287,
        started_at: 1_786_944_681,
        start_price: 0.9849393364193147,
        peak_price: 0.699732524541874,
        peg_reference: 0.71128258,
      }),
      pegRates: { peggedAUD: 0.7067137809187279 },
      pegRateSources: { peggedAUD: "fx" },
      pegRateCounts: { peggedAUD: 4 },
      challengerPools: [
        { price: 0.704981734354013, tvlUsd: 111_651.66302719248, protocol: "curve", chain: "ethereum", sourceFamily: "dl" },
      ],
    });

    expect(decision.seenEventIds).toEqual([90777]);
    expect(decision.commands).toEqual([]);
    expect(decision.diagnostics).toEqual([]);
  });

  it("requires the challenger corroborating groups to outvote the diverging set", () => {
    // The same majority rule decides both directions: two diverging groups
    // still block a two-group corroborating set, and a third corroborating
    // group flips the recovery.
    const now = 1_780_630_000;
    const makeDecision = (corroboratingPools: Array<{ price: number; tvlUsd: number; protocol: string; chain: string; sourceFamily: string }>) =>
      decideDepegAsset({
        now,
        asset: makeAsset({
          id: "dusd-test",
          symbol: "DUSD",
          price: 0.9995,
          priceSource: "coingecko",
          priceConfidence: "single-source",
          agreeSources: ["coingecko"],
          priceUpdatedAt: now - 60,
          priceObservedAt: now - 60,
          priceObservedAtMode: "upstream",
          circulating: { ethereum: 5_000_000 },
        }),
        meta: { ...usdMeta, id: "dusd-test", name: "DUSD", symbol: "DUSD", geckoId: "dusd" },
        existing: makeExistingEvent({
          id: 55,
          stablecoin_id: "dusd-test",
          symbol: "DUSD",
          peg_type: "peggedUSD",
          direction: "below",
          peak_deviation_bps: -300,
          started_at: now - 86_400,
          start_price: 0.97,
          peak_price: 0.97,
          peg_reference: 1,
          recovery_first_seen_at: now - 1_000,
          recovery_last_seen_at: now - 450,
        }),
        pegRates: { peggedUSD: 1 },
        pegRateSources: { peggedUSD: "median" },
        pegRateCounts: { peggedUSD: 4 },
        challengerPools: [
          { price: 0.985, tvlUsd: 1_000_000, protocol: "curve", chain: "ethereum", sourceFamily: "cg_onchain" },
          { price: 0.986, tvlUsd: 1_000_000, protocol: "uniswap-v3", chain: "ethereum", sourceFamily: "cg_onchain" },
          ...corroboratingPools,
        ],
      });

    const tie = makeDecision([
      { price: 0.9985, tvlUsd: 1_000_000, protocol: "raydium", chain: "solana", sourceFamily: "direct_api" },
      { price: 0.999, tvlUsd: 1_000_000, protocol: "orca", chain: "solana", sourceFamily: "cg_onchain" },
    ]);
    expect(tie.commands).toEqual([{ type: "clear-recovery", id: 55 }]);
    expect(tie.diagnostics).toEqual([
      {
        level: "warn",
        message: "[depeg] Kept DUSD open despite primary recovery: pool challengers still show the below depeg (groups=2, corroborating=2, highTvl=false)",
      },
    ]);

    const outvoted = makeDecision([
      { price: 0.9985, tvlUsd: 1_000_000, protocol: "raydium", chain: "solana", sourceFamily: "direct_api" },
      { price: 0.999, tvlUsd: 1_000_000, protocol: "orca", chain: "solana", sourceFamily: "cg_onchain" },
      { price: 0.9975, tvlUsd: 1_000_000, protocol: "meteora", chain: "solana", sourceFamily: "cg_onchain" },
    ]);
    expect(outvoted.commands).toEqual([
      {
        type: "close-event",
        id: 55,
        endedAt: now,
        recoveryPrice: 0.9985,
        closeReason: "recovered-dex",
      },
    ]);
    expect(outvoted.diagnostics).toEqual([
      {
        level: "log",
        message: "[depeg] Pool-challenger majority recovery for DUSD: 3 independent group(s) inside the 50bps recovery band outvote 2 diverging group(s)",
      },
    ]);
  });

  it("does not bypass a challenged aggregate DEX lane with the pool-challenger majority", () => {
    // While a fresh trusted aggregate row exists it stays the only DEX recovery
    // lane: a single diverging challenger pool (below the majority veto) blocks
    // the aggregate recovery, and the challenger snapshot may not overrule it.
    const now = 1_780_630_000;
    const decision = decideDepegAsset({
      now,
      asset: makeAsset({
        id: "dusd-test",
        symbol: "DUSD",
        price: 1.0005,
        priceSource: "coingecko",
        priceConfidence: "single-source",
        agreeSources: ["coingecko"],
        priceUpdatedAt: now - 60,
        priceObservedAt: now - 60,
        priceObservedAtMode: "upstream",
        circulating: { ethereum: 5_000_000 },
      }),
      meta: { ...usdMeta, id: "dusd-test", name: "DUSD", symbol: "DUSD", geckoId: "dusd" },
      existing: makeExistingEvent({
        id: 55,
        stablecoin_id: "dusd-test",
        symbol: "DUSD",
        peg_type: "peggedUSD",
        direction: "above",
        peak_deviation_bps: 250,
        started_at: now - 86_400,
        start_price: 1.025,
        peak_price: 1.025,
        peg_reference: 1,
      }),
      pegRates: { peggedUSD: 1 },
      pegRateSources: { peggedUSD: "median" },
      pegRateCounts: { peggedUSD: 4 },
      dexRow: {
        stablecoin_id: "dusd-test",
        dex_price_usd: 1.0005,
        deviation_from_primary_bps: 5,
        source_pool_count: 3,
        source_total_tvl: 6_000_000,
        updated_at: now - 60,
      },
      protocolSources: [
        { protocol: "curve", chain: "ethereum", sourceFamily: "dl", price: 1.0005, tvl: 3_000_000, updatedAt: now - 60 },
        { protocol: "uniswap-v3", chain: "ethereum", sourceFamily: "cg_onchain", price: 1.0006, tvl: 3_000_000, updatedAt: now - 60 },
      ],
      challengerPools: [
        { price: 1.02, tvlUsd: 200_000, protocol: "curve", chain: "ethereum", sourceFamily: "dl" },
        { price: 1.0004, tvlUsd: 150_000, protocol: "uniswap-v3", chain: "ethereum", sourceFamily: "cg_onchain" },
      ],
    });

    expect(decision.seenEventIds).toEqual([55]);
    expect(decision.commands).toEqual([]);
    expect(decision.diagnostics).toEqual([
      {
        level: "warn",
        message: "[depeg] Ignored aggregate DEX recovery for DUSD: 2 corroborating protocol group(s), challenged=true; keeping event open until corroborated recovery appears",
      },
    ]);
  });
});

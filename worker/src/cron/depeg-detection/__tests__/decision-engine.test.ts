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

  it("starts recovery without mixing a USD price into a native-peg event", () => {
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

    expect(decision.commands).toEqual([
      {
        type: "begin-recovery",
        id: 7,
        firstSeenAt: 1_750_000_900,
        lastSeenAt: 1_750_000_900,
      },
    ]);
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
});

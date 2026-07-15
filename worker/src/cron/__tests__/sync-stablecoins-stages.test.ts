import { beforeEach, describe, it, expect, vi } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

const pricingStageMocks = vi.hoisted(() => ({
  fetchAuthoritativeLivePriceOverrides: vi.fn(),
  fetchPrimaryPrices: vi.fn(),
  enrichMissingPrices: vi.fn(),
  runGtProbePass: vi.fn(),
}));

vi.mock("@shared/lib/stablecoins/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/lib/stablecoins/registry")>();
  const TRACKED_META_BY_ID = new Map(actual.TRACKED_META_BY_ID);
  TRACKED_META_BY_ID.set("usdt-tether", {
    ...TRACKED_META_BY_ID.get("usdt-tether"),
    geckoId: "canonical-usdt",
    cmcSlug: "tether",
    flags: { navToken: false },
  } as never);
  TRACKED_META_BY_ID.set("nav-token-test", {
    geckoId: "nav-token",
    cmcSlug: "nav-token",
    flags: { navToken: true },
  } as never);
  TRACKED_META_BY_ID.set("usg-tangent-test", {
    flags: { navToken: false },
    contracts: [
      { chain: "ethereum", address: "0xB1c2Db5d6cA03FCe73dBd304d320bF76C55Ae1B1", decimals: 18 },
    ],
  } as never);
  // Frozen-style entry: present in TRACKED but not ACTIVE.
  const ACTIVE_META_BY_ID = new Map(TRACKED_META_BY_ID);
  TRACKED_META_BY_ID.set("frozen-with-contracts-test", {
    flags: { navToken: false },
    contracts: [{ chain: "ethereum", address: "0xfeed", decimals: 6 }],
  } as never);

  return {
    ...actual,
    TRACKED_META_BY_ID,
    ACTIVE_META_BY_ID,
  };
});

vi.mock("../sync-stablecoins/enrich-prices", () => ({
  fetchPrimaryPrices: pricingStageMocks.fetchPrimaryPrices,
  enrichMissingPrices: pricingStageMocks.enrichMissingPrices,
  runGtProbePass: pricingStageMocks.runGtProbePass,
  hasMissingPrice: (asset: { price?: number | null }) =>
    asset.price == null || typeof asset.price !== "number" || asset.price === 0,
}));

vi.mock("../sync-stablecoins/fallback", () => ({
  syncViaCoingeckoFallback: vi.fn(),
}));

vi.mock("../sync-stablecoins/intake", () => ({
  loadStablecoinsIntake: vi.fn(),
}));

vi.mock("../../lib/authoritative-price-sources", () => ({
  createAuthoritativeLivePriceOverrideStats: vi.fn((budgetMs = 10_000) => ({
    budgetMs,
    candidateCount: 0,
    attemptedCount: 0,
    successCount: 0,
    failedCount: 0,
    emptyCount: 0,
    skippedCircuitOpen: 0,
    skippedBudget: 0,
    timedOut: false,
  })),
  fetchAuthoritativeLivePriceOverrides: pricingStageMocks.fetchAuthoritativeLivePriceOverrides,
}));

import {
  applyTrackedAssetOverrides,
  computePriceStalenessSummary,
  dedupeCanonicalAssets,
  filterStructurallyValidAssets,
  normalizeChainCirculating,
} from "../sync-stablecoins/phase-helpers";
import { runStablecoinsPricingStage } from "../sync-stablecoins/stages";
import type { PeggedAsset, PrimaryPriceResult } from "../sync-stablecoins/enrich-prices";

function emptyGtProbeStats() {
  return {
    probed: 0,
    pricesObtained: 0,
    divergences500bps: 0,
    skippedLowTvl: 0,
    lookupMisses: 0,
    upstreamErrors: 0,
    publicFallbacks: 0,
    budgetExhausted: false,
    budgetSkipped: false,
    transports: {
      coingeckoOnchain: { attempted: 0, priced: 0, lookupMisses: 0, upstreamErrors: 0 },
      geckoTerminalPublic: { attempted: 0, priced: 0, lookupMisses: 0, upstreamErrors: 0 },
    },
  };
}

function makePricedAsset(): PeggedAsset {
  return {
    id: "usdt-tether",
    name: "Tether",
    symbol: "USDT",
    pegType: "peggedUSD",
    circulating: { peggedUSD: 1_000_000 },
    chainCirculating: {},
    chains: ["Ethereum"],
  };
}

function makePrimaryPriceResult(syncStartSec: number): PrimaryPriceResult {
  return {
    price: 1,
    source: "coingecko",
    selectedSource: "coingecko",
    confidence: "single-source",
    dlPrice: null,
    cgPrice: 1,
    candidateSources: ["coingecko"],
    agreeSources: ["coingecko"],
    allPrices: { coingecko: 1 },
    observedAt: syncStartSec - 30,
    observedAtMode: "upstream",
    observedAtBySource: { coingecko: syncStartSec - 30 },
    observedAtModeBySource: { coingecko: "upstream" },
  };
}

describe("sync-stablecoins stage helpers", () => {
  beforeEach(() => {
    pricingStageMocks.fetchPrimaryPrices.mockReset();
    pricingStageMocks.enrichMissingPrices.mockReset();
    pricingStageMocks.runGtProbePass.mockReset();
    pricingStageMocks.fetchAuthoritativeLivePriceOverrides.mockReset();

    pricingStageMocks.fetchPrimaryPrices.mockResolvedValue({
      results: new Map(),
      stats: {},
      providerDiagnostics: [],
    });
    pricingStageMocks.enrichMissingPrices.mockResolvedValue({
      totalMissing: 0,
      pass1: 0,
      pass1b: 0,
      passCmc: 0,
      passJupiter: 0,
      passDex: 0,
      passCgLowVolume: 0,
      finalMissing: 0,
      failedPasses: [],
      providerDiagnostics: [],
    });
    pricingStageMocks.runGtProbePass.mockResolvedValue({
      updatedCount: 0,
      stats: emptyGtProbeStats(),
    });
    pricingStageMocks.fetchAuthoritativeLivePriceOverrides.mockResolvedValue(new Map());
  });

  it("reuses primary-path authoritative overrides during shared price completion", async () => {
    const syncStartSec = 1_800_000_000;
    const assets = [makePricedAsset()];
    const authoritativeOverrides = new Map([
      [
        "usdt-tether",
        {
          price: 0.998,
          source: "protocol-redeem",
          confidence: "high",
          observedAt: syncStartSec - 15,
          observedAtMode: "upstream",
        },
      ],
    ]);
    pricingStageMocks.fetchPrimaryPrices.mockResolvedValue({
      results: new Map([["usdt-tether", makePrimaryPriceResult(syncStartSec)]]),
      stats: {},
      providerDiagnostics: [],
    });
    pricingStageMocks.fetchAuthoritativeLivePriceOverrides.mockResolvedValue(authoritativeOverrides);

    const result = await runStablecoinsPricingStage({
      db: mockD1([{ match: "price_cache", rows: [] }]),
      assets,
      previousAssetsById: new Map(),
      syncStartSec,
      fxFallbackRates: undefined,
      validationReferences: undefined,
    });

    expect("authoritativeOverrideCount" in result ? result.authoritativeOverrideCount : null).toBe(1);
    expect(pricingStageMocks.fetchAuthoritativeLivePriceOverrides).toHaveBeenCalledTimes(2);
    expect(assets[0]).toMatchObject({
      price: 0.998,
      priceSource: "protocol-redeem",
      priceSelectedSource: "protocol-redeem",
      priceConfidence: "high",
      priceObservedAt: syncStartSec - 15,
      priceObservedAtMode: "upstream",
    });
  });

  it("filters malformed assets while preserving structurally valid rows", () => {
    const assets = [
      { id: "usdt-tether", name: "USDT", symbol: "USDT", circulating: { peggedUSD: 1 } },
      { id: "usdc-circle", name: "Broken", circulating: { peggedUSD: 1 } },
      { id: null, name: "Broken", symbol: "BRK", circulating: { peggedUSD: 1 } },
    ] as unknown as Array<{
      id: string | null;
      name: string;
      symbol?: string;
      circulating: Record<string, number>;
    }>;

    const { validAssets, droppedMalformedAssets } = filterStructurallyValidAssets(assets as never[]);

    expect(validAssets).toHaveLength(1);
    expect(validAssets[0].id).toBe("usdt-tether");
    expect(droppedMalformedAssets).toBe(2);
  });

  it("normalizes chainCirculating peg buckets into numeric totals", () => {
    const assets = [
      {
        id: "usdt-tether",
        chainCirculating: {
          ethereum: {
            current: { peggedUSD: 10, peggedEUR: 15 },
            circulatingPrevDay: { peggedUSD: 8, peggedEUR: 7 },
            circulatingPrevWeek: 9,
          },
        },
      },
    ] as unknown as never[];

    normalizeChainCirculating(assets);

    const entry = (assets[0] as unknown as { chainCirculating: Record<string, Record<string, unknown>> }).chainCirculating.ethereum;
    expect(entry.current).toBe(25);
    expect(entry.circulatingPrevDay).toBe(15);
    expect(entry.circulatingPrevWeek).toBe(9);
  });

  it("applies curated metadata overrides and address patches", () => {
    const assets = [
      { id: "usdt-tether", geckoId: "wrong-id", cmcSlug: undefined, navToken: false },
      { id: "nav-token-test", geckoId: undefined, cmcSlug: undefined, navToken: false },
      { id: "m-m0", geckoId: undefined, cmcSlug: undefined, navToken: false, address: "" },
    ] as unknown as never[];

    applyTrackedAssetOverrides(assets);

    const [usdt, nav, patchedAddress] = assets as unknown as Array<{
      geckoId?: string;
      cmcSlug?: string;
      navToken?: boolean;
      address?: string;
    }>;

    expect(usdt.geckoId).toBe("canonical-usdt");
    expect(usdt.cmcSlug).toBe("tether");
    expect(nav.navToken).toBe(true);
    expect(patchedAddress.address).toBe("0x866A2BF4E572CbcF37D5071A7a58503Bfb36be1b");
  });

  it("attaches curated contracts from active and frozen tracked metadata", () => {
    const assets = [
      { id: "usg-tangent-test" },
      { id: "frozen-with-contracts-test" },
      { id: "no-meta-test" },
    ] as unknown as never[];

    applyTrackedAssetOverrides(assets);

    const [active, frozen, untracked] = assets as unknown as Array<{
      contracts?: { chain: string; address: string; decimals: number }[];
    }>;

    expect(active.contracts).toEqual([
      { chain: "ethereum", address: "0xB1c2Db5d6cA03FCe73dBd304d320bF76C55Ae1B1", decimals: 18 },
    ]);
    expect(frozen.contracts).toEqual([
      { chain: "ethereum", address: "0xfeed", decimals: 6 },
    ]);
    expect(untracked.contracts).toBeUndefined();
  });

  it("dedupes canonical ID collisions by keeping the richer asset row", () => {
    const assets = [
      {
        id: "usdt-tether",
        symbol: "USDT",
        circulating: { peggedUSD: 100 },
        chainCirculating: { Ethereum: { current: 100, circulatingPrevDay: 100, circulatingPrevWeek: 100, circulatingPrevMonth: 100 } },
        chains: ["Ethereum"],
        price: 1,
      },
      {
        id: "usdt-tether",
        symbol: "USDT",
        circulating: { peggedUSD: 125 },
        chainCirculating: {
          Ethereum: { current: 80, circulatingPrevDay: 80, circulatingPrevWeek: 80, circulatingPrevMonth: 80 },
          Tron: { current: 45, circulatingPrevDay: 45, circulatingPrevWeek: 45, circulatingPrevMonth: 45 },
        },
        chains: ["Ethereum", "Tron"],
        price: 1.0002,
        priceUpdatedAt: 2_000,
      },
      {
        id: "usdc-circle",
        symbol: "USDC",
        circulating: { peggedUSD: 90 },
        chainCirculating: {},
        chains: ["Ethereum"],
        price: 1,
      },
    ] as unknown as never[];

    const result = dedupeCanonicalAssets(assets);

    expect(result.duplicateRows).toBe(1);
    expect(result.affectedIds).toEqual(["usdt-tether"]);
    expect(result.dedupedAssets).toHaveLength(2);
    expect(result.dedupedAssets.find((asset) => asset.id === "usdt-tether")).toMatchObject({
      circulating: { peggedUSD: 125 },
      chains: ["Ethereum", "Tron"],
      price: 1.0002,
    });
  });

  it("flags stale price snapshots when >95% of compared rows are identical", () => {
    const previous = Array.from({ length: 60 }, (_, i) => ({ id: `coin-${i}`, price: 1 + i * 0.001 }));
    const current = previous.map((row, i) => ({ ...row, price: i < 58 ? row.price : row.price + 0.1 }));

    const summary = computePriceStalenessSummary(previous as never[], current as never[]);

    expect(summary.compared).toBe(60);
    expect(summary.identical).toBe(58);
    expect(summary.stale).toBe(true);
  });

  it("does not count same-price rows as stale when observation metadata advances", () => {
    const previous = Array.from({ length: 60 }, (_, i) => ({
      id: `coin-${i}`,
      price: 1,
      priceObservedAt: 1_700_000_000,
      priceSyncedAt: 1_700_000_010,
      priceSource: "coingecko",
      priceConfidence: "single-source",
    }));
    const current = previous.map((row) => ({
      ...row,
      priceObservedAt: 1_700_000_300,
      priceSyncedAt: 1_700_000_310,
    }));

    const summary = computePriceStalenessSummary(previous as never[], current as never[]);

    expect(summary.compared).toBe(60);
    expect(summary.identical).toBe(0);
    expect(summary.stale).toBe(false);
  });

  it("does not flag stale when compared population is too small", () => {
    const previous = Array.from({ length: 20 }, (_, i) => ({ id: `coin-${i}`, price: 1 }));
    const current = previous.map((row) => ({ ...row, price: row.price }));

    const summary = computePriceStalenessSummary(previous as never[], current as never[]);

    expect(summary.compared).toBe(20);
    expect(summary.stale).toBe(false);
  });
});

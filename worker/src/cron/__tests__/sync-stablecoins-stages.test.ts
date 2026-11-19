import { beforeEach, describe, it, expect, vi } from "vitest";
import * as replayCache from "../../lib/price-cache";
import { loadReplayPriceCacheForTrustedContinuity as loadReplay } from "../sync-stablecoins/shared";
import { mockD1 } from "@shared/test-utils/mock-d1";
import type { CronProgressUpdate } from "../../lib/cron-logger";

const pricingStageMocks = vi.hoisted(() => ({
  fetchAuthoritativeLivePriceOverrides: vi.fn(),
  fetchPrimaryPrices: vi.fn(),
  enrichMissingPrices: vi.fn(),
  fetchNativePegImpliedUsdQuotes: vi.fn(),
  fetchNativePegQuotes: vi.fn(),
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
  hasMissingPrice: (asset: { price?: number | null }) =>
    asset.price == null || typeof asset.price !== "number" || asset.price === 0,
}));


vi.mock("../../lib/authoritative-price-sources", async () => ({
  projectPriceDerivation: (await vi.importActual<typeof import("../../lib/authoritative-price-sources/helpers")>(
    "../../lib/authoritative-price-sources/helpers",
  )).projectPriceDerivation,
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

vi.mock("../../lib/native-peg-implied-prices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/native-peg-implied-prices")>()),
  fetchCurrentNativePegImpliedUsdQuotes: pricingStageMocks.fetchNativePegImpliedUsdQuotes,
}));

vi.mock("../../lib/native-peg-quotes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/native-peg-quotes")>()),
  fetchCurrentNativePegQuotes: pricingStageMocks.fetchNativePegQuotes,
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
import { projectFxReferenceEvidence, type PriceValidationReferences } from "../../lib/price-validation";
import { makePrimaryPriceResultFixture } from "../sync-stablecoins/__tests__/_fixtures";

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
  return makePrimaryPriceResultFixture({
    observedAt: syncStartSec - 30,
    observedAtBySource: { coingecko: syncStartSec - 30 },
    observedAtModeBySource: { coingecko: "upstream" },
  });
}

function makeEurAsset(id: string, price?: number): PeggedAsset {
  return {
    ...makePricedAsset(),
    id,
    name: id,
    symbol: id.toUpperCase(),
    pegType: "peggedEUR",
    circulating: { peggedEUR: 1_000_000 },
    ...(price == null ? {} : {
      price,
      priceSource: "coingecko",
      priceConfidence: "single-source",
      priceObservedAt: 1_800_000_000 - 30,
      priceObservedAtMode: "upstream",
    }),
  };
}

describe("sync-stablecoins stage helpers", () => {
  const syncStartSec = 1_800_000_000;
  const priceDb = () => mockD1([{ match: "price_cache", rows: [] }]);
  const noFx = { fxFallbackRates: undefined, validationReferences: undefined };
  const prices = () => ({ results: new Map([["usdt-tether", makePrimaryPriceResult(syncStartSec)]]),
    stats: {}, providerDiagnostics: [] });
  beforeEach(() => {
    pricingStageMocks.fetchPrimaryPrices.mockReset();
    pricingStageMocks.enrichMissingPrices.mockReset();
    pricingStageMocks.fetchAuthoritativeLivePriceOverrides.mockReset();
    pricingStageMocks.fetchNativePegImpliedUsdQuotes.mockReset();

    pricingStageMocks.fetchNativePegImpliedUsdQuotes.mockResolvedValue(new Map());

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
    pricingStageMocks.fetchAuthoritativeLivePriceOverrides.mockResolvedValue(new Map());
  });

  it.each([false, true])("reuses primary-path authoritative overrides during shared price completion (replay failed=%s)", async (failed) => {
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
    pricingStageMocks.fetchPrimaryPrices.mockResolvedValue(prices());
    pricingStageMocks.fetchAuthoritativeLivePriceOverrides.mockResolvedValue(authoritativeOverrides);

    const chainRpcs = new Map(), replay = new Map(), db = priceDb();
    const read = vi.spyOn(replayCache, "getPriceCache").mockResolvedValue(replay);
    if (failed) read.mockRejectedValueOnce(new Error());
    const replayPriceCache = await loadReplay(db, true).catch(() => null);
    const result = await runStablecoinsPricingStage({
      chainRpcs, replayPriceCache, db,
      assets,
      previousAssetsById: new Map(),
      syncStartSec,
      ...noFx,
    });

    expect("priceCacheEntries" in result ? result.metadata.authoritativeOverrideCount : null).toBe(1);
    expect(pricingStageMocks.fetchAuthoritativeLivePriceOverrides).toHaveBeenCalledTimes(2);
    for (const call of pricingStageMocks.fetchAuthoritativeLivePriceOverrides.mock.calls) {
      expect(call[3].chainRpcs).toBe(chainRpcs);
    }
    const first = pricingStageMocks.fetchAuthoritativeLivePriceOverrides.mock.calls[0][3];
    expect(first.localRepairOnly).toBeUndefined();
    expect(first.priceCache).toBe(replay);
    expect(read).toHaveBeenCalledTimes(failed ? 2 : 1);
    read.mockRestore();
    expect(pricingStageMocks.fetchAuthoritativeLivePriceOverrides.mock.calls[1][3].localRepairOnly).toBe(true);
    expect(assets[0]).toMatchObject({
      price: 0.998,
      priceSource: "protocol-redeem",
      priceSelectedSource: "protocol-redeem",
      priceConfidence: "high",
      priceObservedAt: syncStartSec - 15,
      priceObservedAtMode: "upstream",
    });
  });

  it("keeps inline GeckoTerminal disabled without reporting a synthetic work stage", async () => {
    const assets = [makePricedAsset()];
    pricingStageMocks.fetchPrimaryPrices.mockResolvedValue(prices());
    const reportProgress = vi.fn(async (_update: CronProgressUpdate) => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected pricing transport"));
    try {
      const result = await runStablecoinsPricingStage({
        db: priceDb(),
        assets,
        previousAssetsById: new Map(),
        syncStartSec,
        ...noFx,
        reportProgress,
      });

      expect(assets[0].price).toBe(1);
      expect("priceCacheEntries" in result ? result.metadata.gtProbe.stats : null).toMatchObject({
        inlineDisabled: true,
        isolationReason: "worker-memory-boundary",
      });
      const updates = reportProgress.mock.calls.map(([update]) => update);
      const outerStages = ["price-enrichment", "price-enrichment-primary-complete", "price-enrichment-overrides", "price-validation"];
      expect(updates.map((update) => update.stage).filter((stage) => outerStages.includes(stage ?? ""))).toEqual(outerStages);
      expect(updates.some((update) => update.stage === "price-enrichment-gt-probe-disabled" || update.metadata?.subphase === "gt-probe-disabled")).toBe(false);
      expect(updates.find((update) => update.stage === "price-enrichment-overrides")?.metadata).toMatchObject({
        gtProbe: { inlineDisabled: true, isolationReason: "worker-memory-boundary" },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });


  it.each([
    ["2026-11-20T21:55:00Z", "2026-11-20T21:50:00Z", "openExchangeRates", "intraday", "fill"],
    ["2026-11-20T21:55:00Z", "2026-11-20T21:50:00Z", "openExchangeRates", "intraday", "correct"],
    ["2026-11-20T21:55:00Z", "2026-11-20T21:50:00Z", "openExchangeRates", "intraday", "conversion"],
    ["2026-11-21T10:00:00Z", "2026-11-20T14:00:00Z", "frankfurter", "business-daily", "hold"],
  ] as const)("uses projected FX evidence at %s (%s, %s, %s, %s)", async (run, fx, source, cadence, action) => {
    const now = Date.parse(run) / 1000;
    const fxAt = Date.parse(fx) / 1000;
    const rates = { peggedEUR: 1.1 };
    const clocks = { peggedEUR: fxAt };
    const references: PriceValidationReferences = {
      rates, type: "fresh", updatedAt: fxAt, updatedAtByPeg: clocks,
      fxReferenceEvidenceByPeg: projectFxReferenceEvidence({
        rates, usableSyncAt: now - 10, usableAgeSec: 10, mode: "live", metadataIdentity: "verified",
        sourceUpdatedAtByPeg: clocks, sourceCadenceByPeg: { peggedEUR: cadence },
        sourceModeByPeg: { peggedEUR: "live" }, sourceDateByPeg: {}, sourceLastSuccessAtBySource: {},
        consecutiveFallbackRuns: 0,
        observations: { peggedEUR: { pegKey: "peggedEUR", usdPerUnit: 1.1, source, cadence, observedAtSec: fxAt } },
        referenceSessionEvidenceByPeg: { peggedEUR: {
          sessionOpenedAtSec: Date.parse("2026-11-15T22:00:00Z") / 1000,
          preCloseUsdPerUnit: 1.09,
          firstInSessionObservedAtSec: fxAt,
        } },
      }),
    };
    const asset = makeEurAsset("eurc-circle", action === "fill" ? undefined : 1.122);
    if (action === "correct") {
      asset.priceSource = "defillama";
      asset.priceObservedAt = null;
      asset.priceObservedAtMode = "unknown";
    } else if (action !== "fill") {
      asset.priceObservedAt = now - 30;
    }
    pricingStageMocks.fetchNativePegQuotes.mockResolvedValue(new Map([[asset.id, {
      stablecoinId: asset.id, pegCurrency: "EUR", vsCurrency: "eur", price: 1, updatedAt: now - 30,
      derivation: action === "conversion"
        ? { kind: "conversion", lineage: {} }
        : { kind: "traded-pair", lineage: { venue: "verified-venue", pair: "EURC/EUR" } },
    }]]));
    const actual = await vi.importActual<typeof import("../../lib/native-peg-implied-prices")>("../../lib/native-peg-implied-prices");
    pricingStageMocks.fetchNativePegImpliedUsdQuotes.mockImplementation(actual.fetchCurrentNativePegImpliedUsdQuotes);
    const wall = vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    try {
      const result = await runStablecoinsPricingStage({
        db: priceDb(), assets: [asset], previousAssetsById: new Map(), syncStartSec: now, validationReferences: references,
      });
      expect("priceCacheEntries" in result ? result.metadata : null).toMatchObject({
        nativePegFillCount: Number(action === "fill"), nativePegCorrectionCount: Number(action === "correct"),
      });
      if (action === "fill" || action === "correct") expect(asset).toMatchObject({ price: 1.1, priceSource: "coingecko-native-implied", priceObservedAt: fxAt });
      else expect(asset.price).toBe(1.122);
    } finally { wall.mockRestore(); }
  });

  it("quarantines malformed and supply-invalid rows per asset while keeping observed zero supply", () => {
    const assets: unknown[] = [
      { id: "usdt-tether", name: "USDT", symbol: "USDT", circulating: { peggedUSD: 1 } },
      { id: "usdc-circle", name: "Broken", circulating: { peggedUSD: 1 } },
      { id: null, name: "Broken", symbol: "BRK", circulating: { peggedUSD: 1 } },
      null,
      "primitive-row",
      { id: "empty", name: "Empty", symbol: "E", circulating: {} },
      { id: "negative", name: "Negative", symbol: "N", circulating: { peggedUSD: -10 } },
      { id: "overflow", name: "Overflow", symbol: "O", circulating: { peggedUSD: 1e308, peggedEUR: 1e308 } },
      { id: "zero", name: "Zero", symbol: "Z", circulating: { peggedUSD: 0 }, circulatingPrevDay: { peggedUSD: -1 } },
    ];

    const { validAssets, droppedMalformedAssets, quarantined, invalidHistoryIds } = filterStructurallyValidAssets(assets);

    expect(validAssets.map((asset) => asset.id)).toEqual(["usdt-tether", "zero"]);
    // An invalid historical bucket drops to absence without quarantining the observed current supply.
    expect(validAssets[1]).toMatchObject({ circulating: { peggedUSD: 0 }, circulatingPrevDay: null });
    expect(invalidHistoryIds).toEqual(["zero"]);
    expect(droppedMalformedAssets).toBe(7);
    expect(quarantined).toEqual([
      { index: 1, id: "usdc-circle", reason: "name-or-symbol-invalid" },
      { index: 2, id: null, reason: "id-missing" },
      { index: 3, id: null, reason: "row-not-object" },
      { index: 4, id: null, reason: "row-not-object" },
      { index: 5, id: "empty", reason: "circulating-absent" },
      { index: 6, id: "negative", reason: "circulating-negative-bucket" },
      { index: 7, id: "overflow", reason: "circulating-overflow" },
    ]);
  });

  it("normalizes chain peg buckets without turning empty observations into zero", () => {
    const assets = [
      {
        id: "usdt-tether",
        chainCirculating: {
          ethereum: {
            current: { peggedUSD: 10, peggedEUR: 15 },
            circulatingPrevDay: { peggedUSD: 8, peggedEUR: 7 },
            circulatingPrevWeek: 9,
          },
          tron: { current: {}, circulatingPrevDay: { peggedUSD: 100 } },
          stellar: { current: { peggedUSD: 50 }, circulatingPrevDay: {}, circulatingPrevWeek: { peggedUSD: 0 }, circulatingPrevMonth: { peggedUSD: -3 } },
          sei: { circulatingPrevDay: { peggedUSD: 5 } },
        },
      },
    ] as unknown as never[];

    normalizeChainCirculating(assets);

    const rows = (assets[0] as unknown as { chainCirculating: Record<string, Record<string, unknown>> }).chainCirculating;
    expect(rows.ethereum).toEqual({ current: 25, circulatingPrevDay: 15, circulatingPrevWeek: 9 });
    expect(rows.tron).toEqual({ current: null, circulatingPrevDay: 100 });
    expect(rows.stellar).toEqual({ current: 50, circulatingPrevDay: null, circulatingPrevWeek: 0, circulatingPrevMonth: null });
    expect(rows.sei).toEqual({ current: null, circulatingPrevDay: 5 });
  });

  it("applies curated metadata overrides and address patches", () => {
    const assets = [
      { id: "usdt-tether", geckoId: "wrong-id", cmcSlug: undefined, navToken: true },
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

    expect(usdt.navToken).toBe(false);
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

  it("counts a frozen republication as identical when only this run's priceSyncedAt advances", () => {
    const observedAt = 1_700_000_000;
    const previous = Array.from({ length: 60 }, (_, i) => ({
      id: `coin-${i}`,
      price: 1,
      priceObservedAt: observedAt,
      priceUpdatedAt: observedAt,
      priceSyncedAt: observedAt,
      priceSource: "defillama",
      priceConfidence: "single-source",
    }));
    const current = previous.map((row) => ({ ...row, priceSyncedAt: observedAt + 900 }));

    const summary = computePriceStalenessSummary(previous as never[], current as never[]);

    expect(summary).toEqual({ compared: 60, identical: 60, stale: true });
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

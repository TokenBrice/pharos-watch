import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAIN_META } from "@shared/types/chain-identity";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { aggregateChains } from "@shared/lib/chains/aggregator";
import { chainCirculatingForDisplay } from "@shared/lib/chains/circulating";
import { buildSupplyObservationProvenance, classifySupplyCoverage } from "@shared/lib/supply-provenance";
import { StablecoinListResponseSchema, SupplyChainGuardProvenanceSchema, SupplyGapFillProvenanceSchema } from "@shared/types/supply";
import {
  getCirculatingRawOrNull,
  getPrevDayRawOrNull,
  getPrevMonthRawOrNull,
  getPrevWeekRawOrNull,
  SUPPLEMENTAL_RESTORE_MAX_AGE_SEC,
} from "@shared/lib/supply";
import { buildChainRpcs, hasRegistryRpc } from "../../../lib/chain-registry";
import { normalizeStablecoinsPayload } from "../shared";
import { overlayCanonicalDetail } from "../../../api/stablecoin-detail/price";
import type { PeggedAsset } from "../enrich-prices-shared";
import type * as FetchRetry from "../../../lib/fetch-retry";
import type * as Onchain from "../../reserve-adapters/onchain";
import type * as TokenSupply from "../../../lib/chain-observation";
import type * as DbCache from "../../../lib/db-cache";
import type * as NativeAggregate from "../supplemental-assets/onchain-supply";

const mocks = vi.hoisted(() => ({ chart: vi.fn(), onchain: vi.fn(), solana: vi.fn(), nativeAggregate: vi.fn(), getCache: vi.fn(), setCache: vi.fn() }));
vi.mock("../../../lib/fetch-retry", async (importOriginal) => ({ ...(await importOriginal<typeof FetchRetry>()), fetchTextWithRetry: mocks.chart }));
vi.mock("../../reserve-adapters/onchain", async (importOriginal) => ({ ...(await importOriginal<typeof Onchain>()), fetchErc20TotalSupply: mocks.onchain }));
vi.mock("../../../lib/chain-observation", async (importOriginal) => ({ ...(await importOriginal<typeof TokenSupply>()), fetchSolanaTokenSupply: mocks.solana }));
vi.mock("../../../lib/db-cache", async (importOriginal) => ({ ...(await importOriginal<typeof DbCache>()), getCache: mocks.getCache, setCacheIfNewer: mocks.setCache }));
vi.mock("../supplemental-assets/onchain-supply", async (importOriginal) => ({
  ...(await importOriginal<typeof NativeAggregate>()), fetchCuratedAggregateOnChainMcap: mocks.nativeAggregate,
}));

import {
  CHAIN_DROPOUT_ONCHAIN_ROSTER,
  CHAIN_DROPOUT_POLICY,
  ChainDropoutStateSchema,
  guardChainDropouts,
  loadChainDropoutState,
  persistChainDropoutState,
  type ChainDropoutState,
} from "../chain-dropout-guard";
import { CHAIN_DROPOUT_SEED, CHAIN_DROPOUT_SEED_VALID_UNTIL } from "../chain-dropout-seed";

const NOW = Date.parse("2026-10-09T06:00:00Z") / 1000;
const DAY = 86400;
const AFTER_SEED = CHAIN_DROPOUT_SEED_VALID_UNTIL + DAY;
const xlayerContract = ACTIVE_META_BY_ID.get("usdg-paxos")!.contracts!.find((entry) => entry.chain === "xlayer")!;

const RWA_AMOUNTS = { ethereum: 150_000_000, base: 145_000_000, monad: 100_000_000, arbitrum: 75_000_000, pharos: 3_000_000, xlayer: 4_000_000, robinhood: 5_000_000 };

const XLAYER_SCALE = 10n ** BigInt(xlayerContract.decimals!);

function leg(current: number, circulatingPrevDay = current) {
  return { current, circulatingPrevDay };
}

function usdg(): PeggedAsset {
  return {
    id: "usdg-paxos", name: "Global Dollar", symbol: "USDG", pegType: "peggedUSD", pegMechanism: "fiat-backed",
    supplySource: "defillama", price: 1, priceSource: "defillama",
    circulating: { peggedUSD: 321_300_000 + 696_500_000 + 627_500_000 },
    circulatingPrevDay: { peggedUSD: 3_134_000_000 }, circulatingPrevWeek: { peggedUSD: 3_000_000_000 }, circulatingPrevMonth: { peggedUSD: 2_900_000_000 },
    chains: ["X Layer", "Ink", "Hyperliquid L1", "Ethereum", "Robinhood", "Solana"],
    chainCirculating: {
      "X Layer": leg(0, 1_427_900_000),
      Ink: leg(0, 63_600_000),
      "Hyperliquid L1": leg(0, 1_200_000),
      Ethereum: leg(321_300_000),
      Robinhood: leg(696_500_000),
      Solana: leg(627_500_000),
    },
  };
}

function usdgXlayer(): PeggedAsset {
  const asset = usdg();
  asset.chainCirculating = { "X Layer": asset.chainCirculating!["X Layer"] };
  return asset;
}

function runGuard(asset: PeggedAsset, options: Partial<Omit<Parameters<typeof guardChainDropouts>[0], "assets">> = {}) {
  return guardChainDropouts({ assets: [asset], now: NOW, state: { version: 1, pairs: {} }, ...options });
}

function savedState(assetId: string, ...pairs: Omit<ChainDropoutState["pairs"][string], "assetId" | "baselineSource">[]): ChainDropoutState {
  return { version: 1, pairs: Object.fromEntries(pairs.map((pair) => [JSON.stringify([assetId, pair.chainId]), {
    ...pair, assetId, baselineSource: "state" as const,
  }])) };
}

function baseline(chainId: string, baselineUsd: number, baselineObservedAt: number, quarantinedSince: number | null = null) {
  return { chainId, chainLabel: CHAIN_META[chainId].name, baselineUsd, baselineObservedAt, quarantinedSince };
}

function gapFill(missingChainId: string, canonicalCurrentUsd: number, supplementalCurrentUsd: number, observedAt = NOW, maxRatio = 1.5): NonNullable<PeggedAsset["supplyGapFill"]> {
  return { method: "coingecko-single-missing-chain", admission: "entered", missingChainId, canonicalSource: "defillama",
    canonicalCurrentUsd, supplementalSource: "coingecko", supplementalCurrentUsd,
    ratio: supplementalCurrentUsd / canonicalCurrentUsd, maxRatio, observedAt };
}

function chartPoint(value: number, date: number) {
  return { response: { ok: true }, body: JSON.stringify([{ date, totalCirculatingUSD: { peggedUSD: value } }]) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
  mocks.onchain.mockResolvedValue(null);
  mocks.solana.mockResolvedValue(null);
  mocks.chart.mockResolvedValue(null);
  mocks.nativeAggregate.mockResolvedValue(null);
  mocks.getCache.mockResolvedValue(null);
  mocks.setCache.mockResolvedValue({ written: true, skippedBecauseNewer: false });
});
afterEach(() => vi.restoreAllMocks());

describe("chain dropout guard", () => {
  it("preserves MOVEUSD's exact native amount without a market price", async () => {
    const asset: PeggedAsset = { ...usdg(), id: "moveusd-cfx", price: null,
      priceListFillDefault: { value: 0.000055, upstreamSource: null }, circulating: { peggedUSD: 6345.816067559877 },
      chainCirculating: { Solana: leg(6345.816067559877, 6251.530916353546) } };
    mocks.solana.mockResolvedValue(114853902359254n);
    await runGuard(asset, { chainRpcs: buildChainRpcs("test-placeholder"), state: savedState(asset.id,
      baseline("solana", 113931826.59636584, NOW - DAY, NOW - DAY)) });
    expect(asset).toMatchObject({ circulating: { peggedUSD: 114853902.359254 },
      chainCirculating: { Solana: { current: 114853902.359254 } }, supplyChainGuard: { status: "repaired" } });
  });

  it.each(["small", "low-chart", "large", "list-share", "ambiguous", "chart"])("keeps only permitted native remainder after a fill-default read failure (%s)", async (mode) => {
    const amounts = { ...RWA_AMOUNTS, robinhood: mode === "large" ? 50_000_000 : RWA_AMOUNTS.robinhood };
    const asset: PeggedAsset = { ...usdg(), id: "rwausdi-multipli", priceListFillDefault: { value: 0.000055, upstreamSource: null },
      circulating: { peggedUSD: Object.values(amounts).reduce((a, b) => a + b) / 1e6 + (mode === "list-share" ? 45 : 0) },
      chainCirculating: Object.fromEntries(Object.entries(amounts).map(([chain, amount]) => [CHAIN_META[chain].name, { current: mode === "list-share" && chain === "robinhood" ? 50 : amount / 1e6 }])) };
    const state = savedState(asset.id, ...Object.entries(amounts).map(([chainId, baselineUsd]) => ({ ...baseline(chainId, baselineUsd, NOW - 8 * DAY, NOW - 8 * DAY),
      ...(mode === "ambiguous" ? { ambiguousSince: NOW - DAY, heldTotalUsd: null } : {}) })));
    mocks.onchain.mockImplementation(async ({ chain }: { chain: keyof typeof amounts }) => chain === "robinhood" ? null : BigInt(amounts[chain]) * 10n ** 6n);
    if (mode === "chart") mocks.chart.mockResolvedValue(chartPoint(5_000_000, NOW));
    if (mode === "low-chart") mocks.chart.mockResolvedValue(chartPoint(100, NOW));
    const result = await runGuard(asset, { state });
    const partial = mode === "small" || mode === "low-chart";
    expect(getCirculatingRawOrNull(asset)).toBe(partial ? 477_000_000 : null);
    expect(result.unavailableAssetIds).toEqual(partial ? [] : [asset.id]);
    if (partial) expect(asset).toMatchObject({ supplyObservedAt: NOW,
      supplyChainGuard: { status: "chains-unavailable", partialCoverage: true, quarantinedSince: NOW - 8 * DAY },
      chainCirculating: { "Robinhood Chain": { current: null }, Ethereum: { current: 150_000_000 } } });
  });

  it.each([
    ["fusd-finchain", ["Ethereum"], 950_000, false, false, false],
    ["fusd-finchain", ["Ethereum", "Avalanche"], 950_000, false, false, false],
    ["fusd-finchain", ["Ethereum"], 50, false, false, false],
    ["moveusd-cfx", ["Solana"], 114_000_000, true, true, false],
    ["moveusd-cfx", ["Solana", "Ethereum"], 114_000_000, true, false, false],
    ["doc-money-on-chain", ["Rootstock"], 2_300_000, false, false, true],
    ["nusd-nexus", ["Ethereum"], 1_360_000, false, false, true],
    ["usdnr-nerona", ["Fluent"], 1_280_000, false, false, true],
  ] as const)("rejects fill-rescaled %s (%s) while preserving bounded guard carry", async (id, labels, baseline, native, admitted, carried) => {
    const asset: PeggedAsset = {
      ...usdg(), id, priceListFillDefault: { value: 0.000055, upstreamSource: null },
      circulating: { peggedUSD: 50 * labels.length },
      chainCirculating: Object.fromEntries(labels.map((label) => [label, leg(50, baseline)])),
    };
    const incoming = structuredClone(asset);
    if (native) mocks.solana.mockResolvedValue(114_000_000n * 10n ** 6n);
    if (!carried) mocks.chart.mockResolvedValue(chartPoint(baseline, NOW));
    const result = await runGuard(asset, { chainRpcs: buildChainRpcs("test-placeholder") });
    expect(getCirculatingRawOrNull(asset)).toBe(carried ? baseline : admitted ? 114_000_000 : null);
    expect(result.unavailableAssetIds).toEqual(admitted || carried ? [] : [id]);
    expect(asset.supplyRestored).toBe(carried ? true : undefined);
    expect([getPrevDayRawOrNull(asset), getPrevWeekRawOrNull(asset), getPrevMonthRawOrNull(asset)]).toEqual([null, null, null]);
    expect(Object.values(asset.chainCirculating!).map((row) => row.current)).toEqual(labels.map(() => admitted ? 114_000_000 : null));
    const published = StablecoinListResponseSchema.parse(normalizeStablecoinsPayload({ peggedAssets: [asset] })).peggedAssets[0];
    expect(published).toMatchObject({ circulating: asset.circulating });
    expect(published.supplyUnavailableReason).toBe(admitted || carried ? undefined : "supply-chain-dropout");
    if (carried) {
      await runGuard(incoming, { now: NOW + SUPPLEMENTAL_RESTORE_MAX_AGE_SEC + 1, state: result.state });
      expect(incoming).toMatchObject({ circulating: {}, supplyUnavailableReason: "supply-chain-dropout", supplyChainGuard: { status: "unavailable", quarantinedSince: NOW } });
    }
  });

  it.each(["fresh", "unavailable", "missing-leg", "stale", "future", "nonconserving"])("admits only a complete fresh USDon census (%s), retaining its actual read clock", async (mode) => {
    vi.spyOn(Date, "now").mockReturnValue((NOW + 120) * 1000);
    const nativeObservedAt = NOW + 60;
    const asset: PeggedAsset = {
      ...usdg(), id: "usdon-ondo", symbol: "USDon", name: "USDon", circulating: { peggedUSD: 65_000_000 },
      ...(mode === "fresh" ? { priceListFillDefault: { value: 0.000055, upstreamSource: null } } : {}),
      chains: ["Ethereum", "BSC"],
      chainCirculating: { Ethereum: { current: 35_000_000 }, BSC: { current: 30_000_000 } },
    };
    const state: ChainDropoutState = savedState("usdon-ondo", { ...baseline("solana", 8_925_000, NOW - 8 * DAY, NOW - 8 * DAY), ambiguousSince: NOW - 8 * DAY, heldTotalUsd: null });
    const chainCirculating: Record<string, { current: number; chainId: string }> = {
      Ethereum: { current: 35_000_000, chainId: "ethereum" }, BSC: { current: 30_000_000, chainId: "bsc" },
      Solana: { current: 13_000_000, chainId: "solana" },
    };
    if (mode === "missing-leg") delete chainCirculating.Ethereum;
    mocks.nativeAggregate.mockResolvedValue(mode === "unavailable" ? null : {
      mcap: mode === "nonconserving" ? 100_000_000 : 78_000_000, supplySource: "onchain-total-supply",
      observedAt: mode === "stale" ? NOW + 120 - 1801 : mode === "future" ? NOW + 120 + 61 : nativeObservedAt,
      chainCirculating,
    });
    const result = await runGuard(asset, { state });
    expect(mocks.nativeAggregate).toHaveBeenCalledTimes(1);
    expect(mocks.nativeAggregate.mock.calls[0][0].id).toBe("usdon-ondo");
    expect(mocks.nativeAggregate.mock.calls[0][1]).toBe(1);
    if (mode !== "fresh") {
      expect(result).toMatchObject({ repaired: 0, unavailableAssetIds: ["usdon-ondo"] });
      expect(asset).toMatchObject({ supplyRestored: true, supplyChainGuard: { status: "unavailable" } });
      expect(getCirculatingRawOrNull(asset)).toBeNull();
      return;
    }
    expect(result).toMatchObject({ flagged: 1, repaired: 1, historyFetches: 0, quarantinedAssetIds: [], unavailableAssetIds: [] });
    expect(asset).toMatchObject({
      circulating: { peggedUSD: 78_000_000 }, supplySource: "onchain-total-supply", supplyObservedAt: nativeObservedAt,
      chainCirculating: { Solana: { current: 13_000_000 } },
      supplyChainGuard: { status: "repaired", chains: [{ resolution: "onchain-total-supply", observedAt: nativeObservedAt, observedAtKind: "local-read" }] },
    });
    expect(asset.supplyRestored).toBeUndefined();
    expect(asset.circulatingPrevDay).toBeNull();
    expect(asset.circulatingPrevWeek).toBeNull();
    expect(asset.circulatingPrevMonth).toBeNull();
    const saved = Object.values(result.state.pairs).find((pair) => pair.chainId === "solana")!;
    expect(saved).toMatchObject({ baselineUsd: 13_000_000, baselineObservedAt: nativeObservedAt, quarantinedSince: null });
    expect(saved.ambiguousSince).toBeUndefined();
    expect(saved.heldTotalUsd).toBeUndefined();
  });

  it("keeps pre-resolved corroboration URLs incumbent-only even with promoted Dwellir", async () => {
    const chainRpcs = buildChainRpcs("test-alchemy", undefined, { dwellirApiKey: "test-dwellir" });
    const xlayer = chainRpcs.get("xlayer")!;
    const incumbentUrls = ["https://primary.example", "https://fallback.example"];
    const dwellir = chainRpcs.get("sonic")!.endpoints.find((endpoint) => endpoint.operator === "dwellir")!;
    xlayer.endpoints = [
      { ...dwellir, position: "registry" },
      ...incumbentUrls.map((url) => ({ url, operator: "public" as const, keyed: false, position: "registry" as const,
        stateHistory: "archive" as const, logsHistory: "full" as const })),
    ];
    const asset = usdgXlayer();
    await runGuard(asset, { chainRpcs });
    expect(mocks.onchain.mock.calls[0]?.filter((argument) => typeof argument === "string" && argument.startsWith("https://")))
      .toEqual(incumbentUrls);
  });

  it.each([false, true])("requires rwaUSDi's healthy small legs in its full native repair (missing: %s)", async (missing) => {
    const amounts = RWA_AMOUNTS;
    const asset: PeggedAsset = { ...usdg(), id: "rwausdi-multipli", circulating: { peggedUSD: 700 },
      chainCirculating: Object.fromEntries(Object.keys(amounts).map((chain) => [CHAIN_META[chain].name, leg(100, 200_000)])) };
    const state = savedState(asset.id, { ...baseline("ethereum", 150_000_000, NOW - DAY, NOW - DAY), ambiguousSince: NOW - DAY, heldTotalUsd: 479_000_000 });
    const chainCirculating = Object.fromEntries(Object.entries(amounts).filter(([chain]) => !missing || chain !== "robinhood")
      .map(([chainId, current]) => [CHAIN_META[chainId].name, { chainId, current }]));
    mocks.nativeAggregate.mockResolvedValue({ mcap: Object.values(chainCirculating).reduce((sum, row) => sum + row.current, 0),
      supplySource: "onchain-total-supply", observedAt: NOW, chainCirculating });
    const result = await runGuard(asset, { state });
    expect(asset.supplyRestored).toBe(missing ? true : undefined);
    expect(getCirculatingRawOrNull(asset)).toBe(missing ? 479_000_000 : 482_000_000);
    expect(result.state.pairs[JSON.stringify([asset.id, "ethereum"])].ambiguousSince).toBe(missing ? NOW - DAY : undefined);
    if (!missing) expect(asset.chainCirculating![CHAIN_META.xlayer.name].current).toBe(4_000_000);
  });

  it("repairs today's USDG current chains from fresh daily charts, preserving historical buckets and wire provenance", async () => {
    const asset = usdg();
    const values: Record<string, number> = { "X Layer": 1_428_126_998.38, Ink: 63_474_779.8, "Hyperliquid L1": 1_209_462.75 };
    mocks.chart.mockImplementation(async (url: string) => {
      const label = decodeURIComponent(new URL(url).pathname.split("/").pop()!);
      return chartPoint(values[label], NOW - 6 * 3600);
    });
    const result = await runGuard(asset);
    expect(result).toMatchObject({ flagged: 3, repaired: 3, historyFetches: 3, quarantinedAssetIds: [] });
    expect(getCirculatingRawOrNull(asset)).toBeCloseTo(3_138_111_240.93, 2);
    expect(asset).toMatchObject({ supplySource: "defillama-chain-repair", supplyObservedAt: NOW - 6 * 3600, supplyChainGuard: { status: "repaired", reason: "supply-chain-dropout" } });
    for (const chain of asset.supplyChainGuard!.chains) {
      expect(chain).toMatchObject({ resolution: "defillama-chain-history", observedAt: NOW - 6 * 3600, observedAtKind: "upstream" });
    }
    expect(asset.supplyRestored).toBeUndefined();
    expect(asset.circulatingPrevDay).toEqual({ peggedUSD: 3_134_000_000 });
    expect(asset.chainCirculating!["X Layer"].circulatingPrevDay).toBe(1_427_900_000);
    expect(mocks.chart.mock.calls[0][0]).toContain("stablecoincharts/X%20Layer?stablecoin=286");
    const normalized = normalizeStablecoinsPayload({ peggedAssets: [asset] });
    const published = StablecoinListResponseSchema.parse(normalized).peggedAssets[0];
    expect(published.supplyChainGuard).toEqual(asset.supplyChainGuard);
  });

  it("parses legacy guard provenance without observedAtKind", () => {
    const legacy = {
      reason: "supply-chain-dropout", status: "repaired",
      chains: [{
        chainId: "xlayer", chainLabel: "X Layer", listCurrentUsd: 0,
        baselineUsd: 1_427_900_000, baselineObservedAt: NOW - DAY, baselineSource: "state",
        resolution: "onchain-total-supply", repairedCurrentUsd: 1_409_030_000, observedAt: NOW,
      }],
    };
    expect(SupplyChainGuardProvenanceSchema.parse(legacy)).toEqual(legacy);
    expect(SupplyChainGuardProvenanceSchema.safeParse({
      ...legacy, chains: [{ ...legacy.chains[0], observedAtKind: "fetch-time" }],
    }).success).toBe(false);
  });

  it("keeps gap-fill provenance additive and validates nonempty withheld historical buckets", () => {
    const legacy = gapFill("xlayer", 100_000_000, 110_000_000, NOW, 1.2);
    expect(SupplyGapFillProvenanceSchema.parse(legacy)).toEqual(legacy);
    const withheld = { ...legacy, withheldHistoricalBuckets: ["day", "week", "month"] };
    expect(SupplyGapFillProvenanceSchema.parse(withheld)).toEqual(withheld);
    expect(SupplyGapFillProvenanceSchema.safeParse({ ...legacy, withheldHistoricalBuckets: [] }).success).toBe(false);
    expect(SupplyGapFillProvenanceSchema.safeParse({ ...legacy, withheldHistoricalBuckets: ["year"] }).success).toBe(false);
  });

  it("freezes vetted baseline across multi-day zeros, expires carry without releasing, then releases only on recovery", async () => {
    const day1 = usdg();
    const first = await runGuard(day1);
    expect(day1).toMatchObject({ supplyRestored: true, supplyChainGuard: { status: "quarantined", quarantinedSince: NOW } });
    expect(day1.chainCirculating!["X Layer"].current).toBeNull();
    expect(getCirculatingRawOrNull(day1)).toBe(1_645_300_000 + 1_427_912_807 + 63_630_836 + 1_193_158);
    await persistChainDropoutState({} as D1Database, first, NOW);
    const saved = ChainDropoutStateSchema.parse(JSON.parse(mocks.setCache.mock.calls[0][2]));
    mocks.getCache.mockResolvedValue({ value: JSON.stringify(saved), updatedAt: NOW });
    const loaded = await loadChainDropoutState({} as D1Database);
    const day2 = usdg();
    for (const label of ["X Layer", "Ink", "Hyperliquid L1"]) day2.chainCirculating![label].circulatingPrevDay = 0;
    const second = await runGuard(day2, { now: NOW + DAY, ...loaded });
    expect(second.flagged).toBe(3);
    expect(day2.supplyChainGuard?.chains[0]).toMatchObject({ baselineSource: "state", baselineUsd: 1_427_912_807, baselineObservedAt: Date.parse("2026-10-08T00:00:00Z") / 1000 });
    expect(day2.supplyChainGuard?.quarantinedSince).toBe(NOW);
    const day8 = usdg();
    for (const label of ["X Layer", "Ink", "Hyperliquid L1"]) day8.chainCirculating![label].circulatingPrevDay = 0;
    const eighth = await runGuard(day8, { now: NOW + SUPPLEMENTAL_RESTORE_MAX_AGE_SEC + 1, state: second.state });
    expect(eighth).toMatchObject({ flagged: 3, quarantinedAssetIds: ["usdg-paxos"], unavailableAssetIds: ["usdg-paxos"] });
    expect(day8).toMatchObject({ circulating: {}, supplyRestored: true, supplyChainGuard: { status: "unavailable", quarantinedSince: NOW } });
    expect(getCirculatingRawOrNull(day8)).toBeNull();
    const recovered = usdg();
    recovered.chainCirculating!["X Layer"].current = 1_400_000_000;
    recovered.chainCirculating!.Ink.current = 64_000_000;
    recovered.chainCirculating!["Hyperliquid L1"].current = 1_300_000;
    recovered.circulating = { peggedUSD: 3_110_600_000 };
    const recovery = await runGuard(recovered, { now: NOW + 9 * DAY, state: eighth.state });
    expect(recovery.flagged).toBe(0);
    expect(recovered.supplyRestored).toBeUndefined();
    expect(recovered.supplyChainGuard).toBeUndefined();
    expect(Object.values(recovery.state.pairs).find((pair) => pair.chainId === "xlayer")).toMatchObject({ baselineUsd: 1_400_000_000, baselineObservedAt: NOW + 9 * DAY, quarantinedSince: null });
  });

  it("withholds the list's partial history when a carried total replaces the provider aggregate", async () => {
    const asset: PeggedAsset = {
      ...usdg(), id: "buidl-blackrock", name: "BlackRock USD Institutional Digital Liquidity Fund", symbol: "BUIDL",
      circulating: { peggedUSD: 2_007_537_545.52 },
      circulatingPrevDay: { peggedUSD: 2_007_537_545.52 },
      circulatingPrevWeek: { peggedUSD: 1_998_000_000 },
      circulatingPrevMonth: { peggedUSD: 1_989_000_000 },
      chains: ["Ethereum"],
      chainCirculating: { Ethereum: leg(2_007_537_545.52) },
    };
    const state: ChainDropoutState = savedState("buidl-blackrock", baseline("solana", 107_427_733.81, NOW - DAY));

    const result = await runGuard(asset, { state });

    expect(result.quarantinedAssetIds).toEqual(["buidl-blackrock"]);
    expect(asset).toMatchObject({ supplyRestored: true, supplyChainGuard: { status: "quarantined" } });
    expect(getCirculatingRawOrNull(asset)).toBeCloseTo(2_114_965_279.33, 2);
    expect(getPrevDayRawOrNull(asset)).toBeNull();
    expect(getPrevWeekRawOrNull(asset)).toBeNull();
    expect(getPrevMonthRawOrNull(asset)).toBeNull();
  });

  it.each([
    ["buidl-blackrock", 107_427_733.81, false], ["buidl-blackrock", 107_427_733.81, true],
    ["fxusd-f-x-protocol", 5_245_864.66, true],
  ] as const)("preserves %s carry/display before review, then excludes its omitted Tempo leg (%s, %s)", async (id, tempoBaselineUsd, ambiguous) => {
    const rows: Record<string, number> = id === "buidl-blackrock"
      ? { Ethereum: 401_541_068.11, Solana: 812_650_279.58, Avalanche: 793_346_197.83 } : { Ethereum: 70_096_078.49 };
    const observedTotal = Object.values(rows).reduce((sum, value) => sum + value, 0);
    const asset: PeggedAsset = {
      ...usdg(), id,
      circulating: { peggedUSD: observedTotal }, chains: Object.keys(rows),
      chainCirculating: Object.fromEntries(Object.entries(rows).map(([label, current]) => [label, leg(current)])),
    };
    const incoming = structuredClone(asset);
    const key = JSON.stringify([id, "tempo"]);
    const state: ChainDropoutState = savedState(id, { ...baseline("tempo", tempoBaselineUsd, NOW - DAY, NOW - DAY), ...(ambiguous ? { ambiguousSince: NOW - DAY, heldTotalUsd: observedTotal + tempoBaselineUsd } : {}) });

    await runGuard(asset, { state });

    const published = StablecoinListResponseSchema.parse(normalizeStablecoinsPayload({ peggedAssets: [asset] })).peggedAssets[0];
    const headline = getCirculatingRawOrNull(published)!;
    expect(headline).toBeCloseTo(observedTotal + tempoBaselineUsd, 2);
    expect(published.supplyChainGuard).toMatchObject({ status: "quarantined", chains: [{ chainId: "tempo", resolution: "carried-baseline" }] });
    expect(published.chainCirculating.Tempo.current).toBeNull();
    const view = aggregateChains({ peggedAssets: [published], safetyScores: {}, pegRates: {}, updatedAt: NOW });
    expect(view.supplyCoverage?.chainIdsWithUnavailableObservations).toEqual(["tempo"]);
    const display = chainCirculatingForDisplay(published)!;
    expect(display.Tempo.current).toBe(tempoBaselineUsd);
    expect(Object.values(display).reduce((sum, row) => sum + row.current!, 0)).toBeCloseTo(headline, 2);
    const reviewedAt = Date.parse(id === "buidl-blackrock" ? "2026-11-12T19:35:00Z" : "2026-11-13T00:12:36Z") / 1000;
    const expiresAt = reviewedAt + 14 * DAY;
    const otherBaseline = observedTotal / 19 + 1;
    for (const [now, incident, restored, expected, other] of [
      [reviewedAt, reviewedAt - 3 * DAY, null, observedTotal],
      [reviewedAt + 8 * DAY, reviewedAt - 3 * DAY, null, observedTotal],
      [expiresAt, reviewedAt - 3 * DAY, null, null],
      [reviewedAt - 1, reviewedAt - 3 * DAY, null, headline],
      [reviewedAt + 2, reviewedAt + 1, null, headline],
      [reviewedAt, reviewedAt - 3 * DAY, tempoBaselineUsd, headline],
      [reviewedAt, reviewedAt - 3 * DAY, tempoBaselineUsd / 10, id === "buidl-blackrock" ? observedTotal + tempoBaselineUsd / 10 : headline],
      [reviewedAt + 2, reviewedAt - 3 * DAY, null, observedTotal + otherBaseline, "plain"],
      [reviewedAt + 2, reviewedAt - 3 * DAY, null, null, "ambiguous"],
    ] as const) {
      const next = structuredClone(incoming);
      const saved = structuredClone(state);
      Object.assign(saved.pairs[key], { quarantinedSince: incident, baselineObservedAt: incident - 900 });
      if (other) saved.pairs[JSON.stringify([id, "polygon"])] = {
        assetId: id, ...baseline("polygon", otherBaseline, now - 900, now - 1), baselineSource: "state",
        ...(other === "ambiguous" ? { ambiguousSince: now - 1, heldTotalUsd: headline + otherBaseline } : {}),
      };
      if (restored != null) {
        next.chainCirculating!.Tempo = { current: restored };
        next.circulating = { peggedUSD: observedTotal + restored };
      }
      const result = await runGuard(next, { now, state: saved });
      if (expected == null) expect(getCirculatingRawOrNull(next)).toBeNull();
      else expect(getCirculatingRawOrNull(next)).toBeCloseTo(expected, 2);
      if (other) {
        const recovered = structuredClone(incoming);
        const retry = await runGuard(recovered, { now: now + 900, previousAssetsById: new Map([[id, next]]) });
        expect(retry.state.pairs[key].quarantinedSince).toBe(incident);
        expect(recovered.supplyChainGuard?.chains.find((chain) => chain.chainId === "tempo")?.reviewedExclusion).toBeDefined();
      }
      if (expected !== observedTotal) continue;
      expect(result).toMatchObject({ quarantinedAssetIds: [], unavailableAssetIds: [], historyFetches: 0 });
      const released = StablecoinListResponseSchema.parse(normalizeStablecoinsPayload({ peggedAssets: [next] })).peggedAssets[0];
      expect(released.supplyRestored).toBeUndefined();
      expect(classifySupplyCoverage(buildSupplyObservationProvenance(released))).toBe("partial");
      expect(released.supplyChainGuard).toMatchObject({ status: "chains-unavailable", partialCoverage: true, quarantinedSince: incident,
        chains: [{ resolution: "unavailable", reviewedExclusion: { reason: "reviewed-excluded", reviewedAt, expiresAt, quarantinedSince: incident } }] });
      vi.mocked(Date.now).mockReturnValue(now * 1000);
      const detail = await overlayCanonicalDetail({} as D1Database, id, new Response("{}"), {
        kind: "ok", updatedAt: now, payload: { peggedAssets: [released] },
      });
      expect(await detail.json()).toMatchObject({ currentCirculatingUSD: released.circulating, currentSupplyExcludedChains: ["Tempo"] });
      const recovered = structuredClone(incoming);
      const retry = await runGuard(recovered, { now: now + 900, previousAssetsById: new Map([[id, next]]) });
      expect(getCirculatingRawOrNull(recovered)).toBe(observedTotal);
      expect(retry.state.pairs[key]).toMatchObject({ baselineUsd: tempoBaselineUsd, quarantinedSince: incident });
    }
  });

  it.each([false, true])("keeps carried history only while its chain bucket equals the baseline (aged day: %s)", async (aged) => {
    const now = AFTER_SEED;
    const state: ChainDropoutState = { version: 1, pairs: {} };
    if (aged) state.pairs[JSON.stringify(["usdg-paxos", "xlayer"])] = {
      assetId: "usdg-paxos", ...baseline("xlayer", 100_000_000, now - DAY, now - DAY), baselineSource: "state",
    };
    const asset: PeggedAsset = {
      ...usdg(),
      circulating: { peggedUSD: 900_000_000 },
      circulatingPrevDay: { peggedUSD: aged ? 900_000_000 : 1_000_000_000 },
      circulatingPrevWeek: { peggedUSD: 1_000_000_000 },
      circulatingPrevMonth: { peggedUSD: 1_000_000_000 },
      chains: ["Ethereum", "X Layer"],
      chainCirculating: {
        Ethereum: leg(900_000_000),
        "X Layer": {
          current: 0,
          circulatingPrevDay: aged ? 0 : 100_000_000,
          circulatingPrevWeek: 100_000_000,
          circulatingPrevMonth: 100_000_000,
        },
      },
    };

    const result = await runGuard(asset, { now, state });

    expect(result.quarantinedAssetIds).toEqual(["usdg-paxos"]);
    expect(asset).toMatchObject({ supplyRestored: true, supplyChainGuard: { status: "quarantined" } });
    expect(getCirculatingRawOrNull(asset)).toBe(1_000_000_000);
    expect(getPrevDayRawOrNull(asset)).toBe(aged ? null : 1_000_000_000);
    expect(getPrevWeekRawOrNull(asset)).toBe(1_000_000_000);
    expect(getPrevMonthRawOrNull(asset)).toBe(1_000_000_000);
  });

  it.each([false, true])("keeps omitted quarantined chains sticky across generations (empty map: %s)", async (emptyMap) => {
    const initial: PeggedAsset = {
      ...usdg(), id: "usdc-circle", circulating: { peggedUSD: 20_000_000 },
      chainCirculating: {
        Ethereum: leg(20_000_000),
        Sonic: leg(0, 80_000_000),
      },
    };
    // Pin the vetted fixture baseline; the incident seed has a different
    // real-world USDC/Sonic amount and intentionally outranks list prev-day.
    const state: ChainDropoutState = savedState("usdc-circle", baseline("sonic", 80_000_000, NOW - DAY));
    const first = await runGuard(initial, { state });
    expect(getCirculatingRawOrNull(initial)).toBe(100_000_000);
    const omitted = (): PeggedAsset => ({
      ...usdg(), id: "usdc-circle", circulating: { peggedUSD: emptyMap ? 0 : 20_000_000 },
      chainCirculating: emptyMap ? {} : { Ethereum: leg(20_000_000) },
    });
    const next = omitted();
    const second = await runGuard(next, { now: NOW + 900, state: first.state });
    expect(second.flagged).toBe(emptyMap ? 2 : 1);
    expect(getCirculatingRawOrNull(next)).toBe(100_000_000);
    expect(next.chainCirculating!.Sonic.current).toBeNull();
    expect(next).toMatchObject({ supplyRestored: true, supplyChainGuard: { status: "quarantined", quarantinedSince: NOW } });
    expect(next.supplyChainGuard?.chains.find((chain) => chain.chainId === "sonic")).toMatchObject({
      listCurrentUsd: null, baselineUsd: 80_000_000, baselineObservedAt: NOW - DAY,
    });

    // Recovery from an unreadable state must include the identity even though
    // the provider omitted the row and the accepted chain current is null.
    const recovered = omitted();
    await runGuard(recovered, { now: NOW + 1800, stateReadFailed: true, previousAssetsById: new Map([["usdc-circle", next]]) });
    expect(getCirculatingRawOrNull(recovered)).toBe(100_000_000);
    expect(recovered.supplyChainGuard?.quarantinedSince).toBe(NOW);
    expect(recovered.chainCirculating!.Sonic.current).toBeNull();

    const expired = omitted();
    const expiry = await runGuard(expired, { now: NOW + SUPPLEMENTAL_RESTORE_MAX_AGE_SEC + 1, state: second.state });
    expect(getCirculatingRawOrNull(expired)).toBeNull();
    expect(expiry.unavailableAssetIds).toEqual(["usdc-circle"]);
    expect(expired).toMatchObject({ supplyRestored: true, supplyChainGuard: { status: "unavailable", quarantinedSince: NOW } });
  });

  describe("minority-share quarantine past the carry ceiling", () => {
    const hyperevmKey = JSON.stringify(["usdg-paxos", "hyperevm"]);
    // frxUSD-shaped: a persisted ambiguous hold on an omitted chain with no recovered observation.
    function setup(baselineUsd: number, quarantinedAgoSec: number) {
      const now = AFTER_SEED;
      const quarantinedSince = now - quarantinedAgoSec;
      const state: ChainDropoutState = savedState("usdg-paxos", { chainLabel: "HyperEVM", chainId: "hyperevm", baselineUsd, baselineObservedAt: quarantinedSince - 5 * DAY, quarantinedSince, ambiguousSince: quarantinedSince, heldTotalUsd: 95_000_000 + baselineUsd });
      const asset: PeggedAsset = {
        ...usdg(), supplyObservedAt: now - 600, circulating: { peggedUSD: 95_000_000 },
        chains: ["Ethereum"], chainCirculating: { Ethereum: leg(95_000_000) },
      };
      return { now, quarantinedSince, state, asset };
    }

    it.each([-1, 1])("publishes partial coverage on either side of carry expiry (offset: %s)", async (offset) => {
      // 5% of the vetted whole-asset total: the inclusive share bound.
      const { now, quarantinedSince, state, asset } = setup(5_000_000, SUPPLEMENTAL_RESTORE_MAX_AGE_SEC + offset);
      const result = await runGuard(asset, { now, state });
      expect(getCirculatingRawOrNull(asset)).toBe(95_000_000);
      expect(asset.supplyRestored).toBeUndefined();
      expect(asset.supplyObservedAt).toBe(now - 600);
      expect(asset.chainCirculating!.HyperEVM.current).toBeNull();
      expect(SupplyChainGuardProvenanceSchema.parse(asset.supplyChainGuard)).toMatchObject({
        status: "chains-unavailable", partialCoverage: true, quarantinedSince,
        chains: [{ chainId: "hyperevm", listCurrentUsd: null, baselineUsd: 5_000_000, resolution: "unavailable" }],
      });
      // Admin alerting continues: still quarantined, never accepted by elapsed time.
      expect(result).toMatchObject({ quarantinedAssetIds: ["usdg-paxos"], unavailableAssetIds: [] });
      expect(result.state.pairs[hyperevmKey]).toMatchObject({ quarantinedSince, baselineUsd: 5_000_000 });

      // An unreadable state rebuilds the quarantine from the partial publication with its original clock.
      const next = setup(5_000_000, 0).asset;
      const recovered = await runGuard(next, { now: now + 900, stateReadFailed: true, previousAssetsById: new Map([["usdg-paxos", asset]]) });
      expect(next.supplyChainGuard).toMatchObject({ status: "chains-unavailable", partialCoverage: true, quarantinedSince });
      expect(recovered.state.pairs[hyperevmKey]).toMatchObject({ quarantinedSince, baselineUsd: 5_000_000 });
    });

    it.each([-1, 1])("carries larger deficits only within the carry ceiling (offset: %s)", async (offset) => {
      const { now, quarantinedSince, state, asset } = setup(5_100_000, SUPPLEMENTAL_RESTORE_MAX_AGE_SEC + offset);
      const result = await runGuard(asset, { now, state });
      expect(getCirculatingRawOrNull(asset)).toBe(offset < 0 ? 100_100_000 : null);
      expect(asset).toMatchObject({
        supplyRestored: true, supplyObservedAt: quarantinedSince - 5 * DAY,
        supplyChainGuard: { status: offset < 0 ? "quarantined" : "unavailable" },
      });
      expect(asset.supplyChainGuard).not.toHaveProperty("partialCoverage");
      expect(result.unavailableAssetIds).toEqual(offset < 0 ? [] : ["usdg-paxos"]);
    });

    it("never synthesizes a clock when the provider row carries none", async () => {
      const { now, state, asset } = setup(5_000_000, SUPPLEMENTAL_RESTORE_MAX_AGE_SEC + 1);
      delete asset.supplyObservedAt;
      await runGuard(asset, { now, state });
      expect(asset.supplyObservedAt).toBeUndefined();
      expect(asset.supplyChainGuard).toMatchObject({ status: "chains-unavailable", partialCoverage: true });
    });

    it("leaves full coverage unchanged", async () => {
      const asset: PeggedAsset = {
        ...usdg(), circulating: { peggedUSD: 95_000_000 }, supplyObservedAt: NOW - 600,
        chains: ["Ethereum"], chainCirculating: { Ethereum: leg(95_000_000) },
      };
      await runGuard(asset);
      expect(asset.supplyChainGuard).toBeUndefined();
      expect(asset.supplyObservedAt).toBe(NOW - 600);
      expect(asset.supplyRestored).toBeUndefined();
      expect(getCirculatingRawOrNull(asset)).toBe(95_000_000);
    });

    it.each([false, true])("withholds unclocked carry without borrowing another baseline clock (clocked sibling: %s)", async (sibling) => {
      const { now, quarantinedSince, state, asset } = setup(5_100_000, 900);
      const clocked = Object.values(state.pairs)[0]!;
      if (sibling) state.pairs[JSON.stringify(["usdg-paxos", "sonic"])] = {
        assetId: "usdg-paxos", ...baseline("sonic", 5_000_000, 0, quarantinedSince), baselineSource: "state",
      };
      else clocked.baselineObservedAt = 0;
      const result = await runGuard(asset, { now, state });
      expect(getCirculatingRawOrNull(asset)).toBeNull();
      expect(asset.supplyObservedAt).toBeUndefined();
      expect(asset.supplyChainGuard).toMatchObject({ status: "unavailable" });
      expect(result.unavailableAssetIds).toEqual(["usdg-paxos"]);
      expect(clocked.baselineObservedAt).toBe(sibling ? quarantinedSince - 5 * DAY : 0);
    });
  });

  it.each([false, true])("imports provider baselines, not gap-fills (synthetic: %s)", async (synthetic) => {
    const current = 70_800_808, prior = 74_722_177, gap = 3_926_614;
    const previous: PeggedAsset = { ...usdg(), id: "iusd-infinifi", supplyObservedAt: AFTER_SEED,
      circulating: { peggedUSD: prior + gap }, chainCirculating: { Ethereum: leg(prior), BSC: leg(gap) } };
    if (synthetic) Object.assign(previous, { supplySource: "coingecko-gap-fill",
      supplyGapFill: gapFill("bsc", prior, prior + gap, AFTER_SEED) });
    const first = await runGuard(previous, { now: AFTER_SEED });
    const next: PeggedAsset = { ...usdg(), id: previous.id, circulating: { peggedUSD: current },
      chainCirculating: { Ethereum: leg(current, prior) } };
    const result = await runGuard(next, { now: AFTER_SEED + 900, state: first.state,
      previousAssetsById: new Map([[previous.id, previous]]) });
    expect(result.flagged).toBe(synthetic ? 0 : 1);
    expect(result.quarantinedAssetIds).toEqual(synthetic ? [] : [previous.id]);
    expect(getCirculatingRawOrNull(next)).toBe(synthetic ? current : current + gap);
    expect(result.state.pairs[JSON.stringify([previous.id, "bsc"])]?.baselineUsd).toBe(synthetic ? undefined : gap);
    expect(next.supplyChainGuard?.status).toBe(synthetic ? undefined : "quarantined");
  });

  it("recovers omitted material identities from the previous accepted publication even without a saved pair", async () => {
    const previous: PeggedAsset = {
      ...usdg(), id: "usdc-circle", supplyObservedAt: NOW - 900,
      circulating: { peggedUSD: 100_000_000 },
      chainCirculating: { Ethereum: { current: 20_000_000 }, Sonic: { current: 80_000_000 } },
    };
    const next: PeggedAsset = {
      ...previous, circulating: { peggedUSD: 20_000_000 }, chainCirculating: { Ethereum: { current: 20_000_000 } },
    };
    const result = await runGuard(next, { previousAssetsById: new Map([["usdc-circle", previous]]) });
    expect(result.flagged).toBe(1);
    expect(getCirculatingRawOrNull(next)).toBe(100_000_000);
    expect(next.chainCirculating!.Sonic.current).toBeNull();
    expect(next.supplyRestored).toBe(true);
  });

  it("publishes the native amount, not the disproven list zero, when native supply corroborates a low-but-positive collapse", async () => {
    mocks.onchain.mockResolvedValue(40_000_000n * XLAYER_SCALE);
    const asset = usdgXlayer();
    asset.supplyObservedAt = NOW - 900;
    const before = getCirculatingRawOrNull(asset)!;
    const result = await runGuard(asset);
    expect(asset.chainCirculating!["X Layer"].current).toBe(40_000_000);
    expect(asset.supplyChainGuard?.chains.find((chain) => chain.chainId === "xlayer"))
      .toMatchObject({ resolution: "onchain-total-supply", listCurrentUsd: 0, repairedCurrentUsd: 40_000_000, observedAt: NOW, observedAtKind: "local-read" });
    const xlayer = Object.values(result.state.pairs).find((pair) => pair.chainId === "xlayer")!;
    expect(xlayer).toMatchObject({ baselineUsd: 40_000_000, quarantinedSince: null, releasedAt: NOW });
    expect(asset.supplyChainGuard?.status).toBe("repaired");
    expect(asset.supplyRestored).toBeUndefined();
    expect(asset.supplySource).toBe("defillama-chain-repair");
    expect(asset.supplyObservedAt).toBe(NOW - 900);
    expect(getCirculatingRawOrNull(asset)).toBe(before + 40_000_000);
  });

  it.each([
    [null, "fresh"], [10_000, "fresh"], [50_505, "fresh"], [null, "null"], [null, "error"], [null, "deadline"],
  ] as const)("publishes native XUSD once only after a successful read (list: %s, read: %s)", async (listCurrent, mode) => {
    const now = Date.parse("2026-10-29T10:50:19Z") / 1000;
    const firstFlaggedAt = Date.parse("2026-10-23T11:46:56Z") / 1000;
    const key = JSON.stringify(["xusd-straitsx", "solana"]);
    const state: ChainDropoutState = savedState("xusd-straitsx", baseline("solana", 12_052_667, firstFlaggedAt - 900, firstFlaggedAt));
    const asset: PeggedAsset = {
      id: "xusd-straitsx", name: "StraitsX XUSD", symbol: "XUSD", pegType: "peggedUSD", pegMechanism: "fiat-backed", supplySource: "defillama",
      circulating: { peggedUSD: 46_000_000 + (listCurrent ?? 0) }, supplyObservedAt: now - 900,
      chains: ["Ethereum", ...(listCurrent == null ? [] : ["Solana"])],
      chainCirculating: {
        Ethereum: leg(46_000_000),
        ...(listCurrent == null ? {} : { Solana: { current: listCurrent } }),
      },
    };
    mocks.solana.mockResolvedValue(mode === "null" ? null : 50_505n * 10n ** 6n);
    if (mode === "error") mocks.solana.mockRejectedValue(new Error("rpc down"));
    if (mode === "deadline") vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort(new DOMException("guard deadline", "TimeoutError")));
    const signal = new AbortController().signal;
    const result = await runGuard(asset, { now, state, signal, chainRpcs: buildChainRpcs("test-alchemy") });
    expect(mocks.solana).toHaveBeenCalledTimes(1);
    expect(mocks.solana).toHaveBeenCalledWith("4UbvZiomFvXDnZSz6vdHiDNiHozH2ykTEqjhhbVHiv9z", expect.any(AbortSignal), undefined, expect.any(String), undefined);
    expect(mocks.onchain).not.toHaveBeenCalled();
    if (mode !== "fresh") {
      if (mode === "deadline") expect(AbortSignal.timeout).toHaveBeenCalledWith(CHAIN_DROPOUT_POLICY.solanaReadTimeoutMs);
      expect(result).toMatchObject({ repaired: 0, quarantinedAssetIds: ["xusd-straitsx"] });
      expect(asset).toMatchObject({ supplyRestored: true, chainCirculating: { Solana: { current: null } },
        supplyChainGuard: { status: "quarantined", quarantinedSince: firstFlaggedAt, chains: [{ listCurrentUsd: null, resolution: "carried-baseline" }] } });
      expect(asset.supplyChainGuard!.chains[0].observedAtKind).toBeUndefined();
      expect(result.state.pairs[key]).toMatchObject({ baselineUsd: 12_052_667, quarantinedSince: firstFlaggedAt });
      expect(result.state.pairs[key].releasedAt).toBeUndefined();
      return;
    }
    expect(result).toMatchObject({ flagged: 1, repaired: 1, historyFetches: 0, quarantinedAssetIds: [], unavailableAssetIds: [] });
    expect(asset).toMatchObject({
      circulating: { peggedUSD: 46_050_505 }, supplySource: "defillama-chain-repair", supplyObservedAt: now - 900,
      chainCirculating: { Solana: { current: 50_505 } },
      supplyChainGuard: { status: "repaired", chains: [{ chainId: "solana", listCurrentUsd: listCurrent,
        repairedCurrentUsd: 50_505, resolution: "onchain-total-supply", observedAt: now, observedAtKind: "local-read" }] },
    });
    expect(asset.chains).toContain("Solana");
    expect(asset.supplyRestored).toBeUndefined();
    expect(asset.chainCirculating!.Ethereum.current).toBe(46_000_000);
    expect(result.state.pairs[key]).toMatchObject({ baselineUsd: 50_505, baselineObservedAt: now, quarantinedSince: null, releasedAt: now });
    expect(StablecoinListResponseSchema.parse(normalizeStablecoinsPayload({ peggedAssets: [asset] })).peggedAssets[0].supplyChainGuard)
      .toEqual(asset.supplyChainGuard);
  });

  it.each([
    { source: "state", gain: 0, read: "confirmed" },
    { source: "publication", gain: 0, read: "confirmed" },
    { source: "clean", gain: 1_000, read: "confirmed" },
    { source: "state", gain: 1_000, read: "confirmed" },
    { source: "state", gain: 0, read: "null" },
    { source: "state", gain: 0, read: "error" },
    { source: "state", gain: 0, read: "above-collapse" },
  ])("handles production XUSD ambiguity from $source with gain $gain and native read $read", async ({ source, gain, read }) => {
    const now = Date.parse("2026-10-29T12:00:00Z") / 1000;
    const firstFlaggedAt = 1792756016;
    const key = JSON.stringify(["xusd-straitsx", "solana"]);
    const heldTotalUsd = 58_187_635.87;
    const baselineUsd = 12_052_667.17;
    const asset: PeggedAsset = {
      id: "xusd-straitsx", name: "StraitsX XUSD", symbol: "XUSD", pegType: "peggedUSD", pegMechanism: "fiat-backed", supplySource: "defillama",
      circulating: { peggedUSD: 34_130_563 }, supplyObservedAt: now - 900, chains: ["BSC", "Ethereum"],
      chainCirculating: { BSC: { current: 21_983_043.6 }, Ethereum: { current: 12_147_519.4 } },
    };
    const state: ChainDropoutState = savedState("xusd-straitsx", { ...baseline("solana", baselineUsd, 1792754140, firstFlaggedAt), ...(source === "clean" ? {} : { ambiguousSince: firstFlaggedAt, heldTotalUsd }) }, baseline("bsc", 21_983_043.6 - gain, now - 900), baseline("ethereum", 12_147_519.4, now - 900));
    const previous: PeggedAsset = { ...structuredClone(asset), circulating: { peggedUSD: heldTotalUsd }, supplyRestored: true,
      supplyChainGuard: { reason: "supply-chain-dropout", status: "quarantined", quarantinedSince: firstFlaggedAt, concurrentGainUsd: 0,
        chains: [{ chainId: "solana", chainLabel: "Solana", listCurrentUsd: null, baselineUsd,
          baselineObservedAt: 1792754140, baselineSource: "state", resolution: "carried-baseline" }] } };
    mocks.solana.mockResolvedValue(read === "null" ? null : BigInt(read === "above-collapse" ? 8_000_000 : 50_505) * 10n ** 6n);
    if (read === "error") mocks.solana.mockRejectedValue(new Error("rpc down"));
    const result = await runGuard(asset, { now, state: source === "publication" ? { version: 1, pairs: {} } : state, ...(source === "publication" ? { stateReadFailed: true, previousAssetsById: new Map([["xusd-straitsx", previous]]) } : {}), chainRpcs: buildChainRpcs("test-alchemy") });
    if (read === "confirmed") {
      expect(result).toMatchObject({ repaired: 1, historyFetches: 0, quarantinedAssetIds: [], unavailableAssetIds: [] });
      expect(getCirculatingRawOrNull(asset)).toBeCloseTo(34_181_068, 2);
      expect(asset).toMatchObject({ chainCirculating: { Solana: { current: 50_505 } }, supplyObservedAt: now - 900,
        supplyChainGuard: { status: "repaired", chains: [{ listCurrentUsd: null, repairedCurrentUsd: 50_505,
          resolution: "onchain-total-supply", observedAt: now, observedAtKind: "local-read" }] } });
      expect(asset.supplyRestored).toBeUndefined();
      expect(asset.supplyChainGuard!.concurrentGainUsd).toBeUndefined();
      expect(result.state.pairs[key]).toMatchObject({ baselineUsd: 50_505, baselineObservedAt: now, quarantinedSince: null, releasedAt: now });
      expect(result.state.pairs[key].ambiguousSince).toBeUndefined();
      expect(result.state.pairs[key].heldTotalUsd).toBeUndefined();
    } else {
      expect(result).toMatchObject({ repaired: 0, quarantinedAssetIds: ["xusd-straitsx"] });
      expect(getCirculatingRawOrNull(asset)).toBe(heldTotalUsd);
      expect(asset).toMatchObject({ supplyRestored: true, chainCirculating: { Solana: { current: null } }, supplyChainGuard: { status: "quarantined" } });
      expect(result.state.pairs[key]).toMatchObject({ baselineUsd, quarantinedSince: firstFlaggedAt, ambiguousSince: firstFlaggedAt, heldTotalUsd });
      expect(result.state.pairs[key].releasedAt).toBeUndefined();
    }
  });

  it("keeps a natively confirmed zero at zero across persist/reload when later native and chart reads fail", async () => {
    mocks.onchain.mockResolvedValueOnce(0n);
    const first = usdgXlayer();
    const confirmed = await runGuard(first);
    expect(first.chainCirculating!["X Layer"].current).toBe(0);
    expect(first.supplyRestored).toBeUndefined();
    await persistChainDropoutState({} as D1Database, confirmed, NOW);
    const saved = ChainDropoutStateSchema.parse(JSON.parse(mocks.setCache.mock.calls[0][2]));
    expect(Object.values(saved.pairs)).toEqual([expect.objectContaining({ chainId: "xlayer", baselineUsd: 0, releasedAt: NOW })]);

    mocks.getCache.mockResolvedValue({ value: JSON.stringify(saved), updatedAt: NOW });
    const loaded = await loadChainDropoutState({} as D1Database);
    mocks.onchain.mockRejectedValue(new Error("rpc down"));
    mocks.chart.mockResolvedValue({ response: { ok: false, status: 503 }, body: "" });
    const next = usdgXlayer();
    const later = await runGuard(next, { now: NOW + 3600, ...loaded });
    expect(later.flagged).toBe(0);
    expect(next.chainCirculating!["X Layer"].current).toBe(0);
    expect(next.supplyRestored).toBeUndefined();
    expect(next.supplyChainGuard).toBeUndefined();
    expect(getCirculatingRawOrNull(next)).toBe(getCirculatingRawOrNull(usdg()));

    // The persisted state is unreadable too: the confirmed zero is recovered from the latest
    // publication (`next`), whose guard sidecar is already gone because the chain is no longer flagged.
    mocks.getCache.mockRejectedValue(new Error("D1 unavailable"));
    const unreadable = await loadChainDropoutState({} as D1Database);
    expect(unreadable.stateReadFailed).toBe(true);
    const afterFailure = usdgXlayer();
    expect(next.supplyChainGuard).toBeUndefined();
    const recovered = await runGuard(afterFailure, { now: NOW + 7200, ...unreadable, previousAssetsById: new Map([["usdg-paxos", next]]) });
    expect(recovered.flagged).toBe(0);
    expect(afterFailure.chainCirculating!["X Layer"].current).toBe(0);
    expect(afterFailure.supplyRestored).toBeUndefined();
    expect(afterFailure.supplyChainGuard).toBeUndefined();
  });

  it.each([
    ["native zero", 0, 0, 25_000_000],
    ["native below list", 30_000_000, 10_000_000, 35_000_000],
  ])("keeps a %s confirmation despite a concurrent healthy-chain gain", async (_case, listUsd, nativeUsd, expectedTotal) => {
    const now = AFTER_SEED;
    mocks.onchain.mockResolvedValue(BigInt(nativeUsd) * XLAYER_SCALE);
    const state: ChainDropoutState = savedState("usdg-paxos", baseline("xlayer", 100_000_000, now - 900), baseline("ethereum", 20_000_000, now - 900));
    const asset: PeggedAsset = {
      ...usdg(),
      circulating: { peggedUSD: 25_000_000 + listUsd },
      chainCirculating: {
        Ethereum: leg(25_000_000, 20_000_000),
        "X Layer": leg(listUsd, 100_000_000),
      },
    };
    const result = await runGuard(asset, { now, state });
    expect(getCirculatingRawOrNull(asset)).toBe(expectedTotal);
    expect(asset.chainCirculating!["X Layer"].current).toBe(nativeUsd);
    expect(asset.supplyRestored).toBeUndefined();
    expect(asset.supplyChainGuard).toMatchObject({ status: "repaired", chains: [{ resolution: "onchain-total-supply", repairedCurrentUsd: nativeUsd }] });
    expect(result.state.pairs[JSON.stringify(["usdg-paxos", "xlayer"])]).toMatchObject({ baselineUsd: nativeUsd, quarantinedSince: null, releasedAt: now });
  });

  it("publishes unavailable, not a partial held total, when an ambiguous asset has a chain with no reference or current", async () => {
    const now = AFTER_SEED;
    const state: ChainDropoutState = savedState("usdg-paxos", baseline("xlayer", 100_000_000, now - 900), baseline("ethereum", 20_000_000, now - 900));
    const asset: PeggedAsset = {
      ...usdg(),
      circulating: { peggedUSD: 25_000_000 },
      chainCirculating: {
        Ethereum: leg(25_000_000, 20_000_000),
        "X Layer": leg(0, 100_000_000),
        Ink: { current: null },
      },
    };
    const result = await runGuard(asset, { now, state });
    expect(asset.circulating).toEqual({});
    expect(asset).toMatchObject({ supplyRestored: true, supplyChainGuard: { status: "unavailable" } });
    expect(result.unavailableAssetIds).toEqual(["usdg-paxos"]);
    expect(result.state.pairs[JSON.stringify(["usdg-paxos", "xlayer"])]).toMatchObject({ heldTotalUsd: null, quarantinedSince: now });
  });

  it("makes a persisted ambiguous hold unknown, never a clamped zero, when another chain is later natively confirmed", async () => {
    const now = AFTER_SEED;
    mocks.onchain.mockResolvedValue(0n * XLAYER_SCALE);
    // Frozen $100M packet held for Solana (B=$80M) when X Layer (A) was $20M; A then grew to $100M
    // as an independent baseline before burning to a natively confirmed zero.
    const state: ChainDropoutState = savedState("usdg-paxos", { ...baseline("solana", 80_000_000, now - 2 * DAY, now - DAY), ambiguousSince: now - DAY, heldTotalUsd: 100_000_000 }, baseline("xlayer", 100_000_000, now - 900));
    const asset: PeggedAsset = {
      ...usdg(),
      circulating: { peggedUSD: 0 },
      chainCirculating: {
        Solana: leg(0),
        "X Layer": leg(0, 100_000_000),
      },
    };
    const result = await runGuard(asset, { now, state });
    expect(asset.chainCirculating!["X Layer"].current).toBe(0);
    expect(asset.chainCirculating!.Solana.current).toBeNull();
    expect(asset.circulating).toEqual({});
    expect(asset).toMatchObject({ supplyRestored: true, supplyChainGuard: { status: "unavailable" } });
    expect(result.unavailableAssetIds).toEqual(["usdg-paxos"]);
    expect(result.state.pairs[JSON.stringify(["usdg-paxos", "solana"])]).toMatchObject({ heldTotalUsd: null, quarantinedSince: now - DAY });
  });

  it.each([[undefined, 0], [NOW - 900, 0], [NOW - 900, 0.5]] as const)("uses only epoch repair clocks (incoming %s, run offset %s)", async (listObservedAt, offset) => {
    mocks.onchain.mockResolvedValue(1_409_030_000n * XLAYER_SCALE);
    const asset = usdgXlayer();
    if (listObservedAt != null) asset.supplyObservedAt = listObservedAt;
    await runGuard(asset, { now: NOW + offset });
    expect(asset.chainCirculating!["X Layer"].current).toBe(1_409_030_000);
    expect(asset.supplyChainGuard?.status).toBe("repaired");
    if (offset) {
      expect(asset.supplyObservedAt).toBeUndefined();
      return;
    }
    expect(asset.supplyChainGuard?.chains[0]).toMatchObject({ resolution: "onchain-total-supply", observedAt: NOW, observedAtKind: "local-read" });
    // Oldest component observation: the repair read (sync clock) and, when named, the list clock.
    const aggregateClock = listObservedAt == null ? NOW : Math.min(NOW, listObservedAt);
    expect(asset.supplyObservedAt).toBe(aggregateClock);
    const published = StablecoinListResponseSchema.parse(normalizeStablecoinsPayload({ peggedAssets: [asset] })).peggedAssets[0];
    expect(published.supplyChainGuard?.chains[0]).toMatchObject({ observedAt: NOW, observedAtKind: "local-read" });
    expect(published.supplyObservedAt).toBe(aggregateClock);
    expect(mocks.onchain.mock.calls[0][1]).toBe(xlayerContract.address);
  });

  it("uses only upstream chart clocks for a mixed native and chart repair", async () => {
    const asset = usdg();
    asset.supplyObservedAt = NOW - 900;
    asset.chainCirculating = {
      "X Layer": asset.chainCirculating!["X Layer"],
      Ink: asset.chainCirculating!.Ink,
    };
    mocks.onchain.mockResolvedValueOnce(1_409_030_000n * XLAYER_SCALE);
    mocks.chart.mockResolvedValue(chartPoint(63_474_779.8, NOW - 6 * 3600));
    await runGuard(asset);
    expect(asset.supplyChainGuard?.chains.find((chain) => chain.chainId === "xlayer"))
      .toMatchObject({ observedAt: NOW, observedAtKind: "local-read" });
    expect(asset.supplyChainGuard?.chains.find((chain) => chain.chainId === "ink"))
      .toMatchObject({ observedAt: NOW - 6 * 3600, observedAtKind: "upstream" });
    expect(asset.supplyObservedAt).toBe(NOW - 6 * 3600);
  });

  it.each(["failed-read", "invalid-json", "invalid-schema"])("does not clobber persisted quarantine after %s", async (failure) => {
    if (failure === "failed-read") mocks.getCache.mockRejectedValue(new Error("D1 unavailable"));
    else mocks.getCache.mockResolvedValue({ value: failure === "invalid-json" ? "{" : JSON.stringify({ version: 2, pairs: {} }), updatedAt: NOW });
    const loaded = await loadChainDropoutState({} as D1Database);
    expect(loaded.stateReadFailed).toBe(true);
    const result = await runGuard(usdg(), { ...loaded });
    expect(result.quarantinedAssetIds).toEqual(["usdg-paxos"]);
    await persistChainDropoutState({} as D1Database, result, NOW);
    expect(mocks.setCache).not.toHaveBeenCalled();
  });

  it("recovers a non-seeded quarantine from the last publication when the state read fails on a later outage day", async () => {
    const outage = (prevDay: number): PeggedAsset => ({
      ...usdg(),
      circulating: { peggedUSD: 321_300_000 },
      chainCirculating: {
        Ethereum: leg(321_300_000),
        Solana: leg(0, prevDay),
      },
    });
    const day1 = outage(627_500_000);
    await runGuard(day1);
    expect(day1).toMatchObject({ supplyRestored: true, supplyChainGuard: { status: "quarantined", quarantinedSince: NOW } });

    mocks.getCache.mockRejectedValue(new Error("D1 unavailable"));
    const loaded = await loadChainDropoutState({} as D1Database);
    const day2 = outage(0);
    const second = await runGuard(day2, { now: NOW + DAY, ...loaded, previousAssetsById: new Map([["usdg-paxos", day1]]) });
    expect(second.quarantinedAssetIds).toEqual(["usdg-paxos"]);
    expect(day2.chainCirculating!.Solana.current).toBeNull();
    expect(day2.supplyChainGuard).toMatchObject({ status: "quarantined", quarantinedSince: NOW });
    expect(getCirculatingRawOrNull(day2)).toBe(321_300_000 + 627_500_000);
    await persistChainDropoutState({} as D1Database, second, NOW + DAY);
    expect(mocks.setCache).not.toHaveBeenCalled();
  });

  it.each([
    ["non-array chart", JSON.stringify({ error: "unavailable" })],
    ["unparseable chart", "{"],
    ["latest chart point without a usable peg bucket", JSON.stringify([
      { date: NOW - 2 * DAY, totalCirculatingUSD: { peggedUSD: 1_400_000_000 } },
      { date: NOW - 3600, totalCirculatingUSD: { peggedUSD: -1 } },
    ])],
  ])("fails closed when the native read throws and the chart is a %s", async (_case, body) => {
    mocks.onchain.mockRejectedValue(new Error("rpc down"));
    mocks.chart.mockResolvedValue({ response: { ok: true }, body });
    const asset = usdgXlayer();
    const result = await runGuard(asset);
    expect(result).toMatchObject({ repaired: 0, quarantinedAssetIds: ["usdg-paxos"] });
    expect(asset.chainCirculating!["X Layer"].current).toBeNull();
    expect(asset.supplyChainGuard?.chains[0]).toMatchObject({ resolution: "carried-baseline" });
    expect(Object.values(result.state.pairs)[0]).toMatchObject({ quarantinedSince: NOW, chartAttemptedAt: NOW });
    expect(Object.values(result.state.pairs)[0].chartPoint).toBeUndefined();
  });

  it("keeps publication successful when persisting guard state fails", async () => {
    mocks.setCache.mockRejectedValue(new Error("D1 write failed"));
    const result = await runGuard(usdg());
    await expect(persistChainDropoutState({} as D1Database, result, NOW)).resolves.toBeUndefined();
    expect(mocks.setCache).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["full", 100_000_000],
    ["partial", 85_000_000],
  ])("never double-counts a %s source reattribution of a dropped destination, across two persisted runs", async (_case, source) => {
    // Past the incident seed so baselines come only from the asset's own healthy history.
    const start = AFTER_SEED;
    const bridged = (sourceUsd: number, destinationUsd: number): PeggedAsset => ({
      ...usdg(),
      circulating: { peggedUSD: sourceUsd + destinationUsd },
      chainCirculating: {
        Ethereum: leg(sourceUsd, 80_000_000),
        "X Layer": leg(destinationUsd, 20_000_000),
      },
    });
    // A chart lane that would "repair" the destination to its true $20M.
    mocks.chart.mockResolvedValue(chartPoint(20_000_000, start - 3600));
    const healthy = await runGuard(bridged(80_000_000, 20_000_000), { now: start });
    expect(healthy.flagged).toBe(0);

    let state = healthy.state;
    for (const now of [start + 900, start + 1800]) {
      await persistChainDropoutState({} as D1Database, { ...healthy, state }, now);
      const calls = mocks.setCache.mock.calls;
      mocks.getCache.mockResolvedValue({ value: calls[calls.length - 1][2], updatedAt: now });
      const loaded = await loadChainDropoutState({} as D1Database);
      const outage = bridged(source, 0);
      const run = await runGuard(outage, { now, ...loaded });
      // Never source + repaired destination ($120M / $105M): the vetted pre-reattribution total is held.
      expect(getCirculatingRawOrNull(outage)).toBe(100_000_000);
      expect(outage.chainCirculating!["X Layer"].current).toBeNull();
      expect(outage.chainCirculating!.Ethereum.current).toBe(source);
      expect(outage.supplyChainGuard).toMatchObject({ status: "quarantined", chains: [{ chainId: "xlayer", resolution: "carried-baseline" }] });
      expect(outage.supplyChainGuard?.chains[0].repairedCurrentUsd).toBeUndefined();
      expect(outage.supplyChainGuard?.chains[0].observedAtKind).toBeUndefined();
      state = run.state;
    }
  });

  it("keeps the first-detection clock when a native-low release is withheld for a concurrent healthy-chain gain", async () => {
    mocks.onchain.mockResolvedValue(40_000_000n * XLAYER_SCALE);
    const asset = usdg();
    asset.chainCirculating = {
      "X Layer": asset.chainCirculating!["X Layer"],
      Ethereum: leg(330_000_000, 321_300_000),
    };
    asset.circulating = { peggedUSD: 330_000_000 };
    const result = await runGuard(asset);
    expect(asset.chainCirculating!["X Layer"].current).toBeNull();
    expect(asset.supplyChainGuard).toMatchObject({ status: "quarantined", quarantinedSince: NOW, concurrentGainUsd: 8_700_000 });
    expect(asset.supplyChainGuard?.chains[0].repairedCurrentUsd).toBeUndefined();
    expect(asset.supplyChainGuard?.chains[0].observedAtKind).toBeUndefined();
    expect(getCirculatingRawOrNull(asset)).toBeGreaterThan(0);
    const xlayer = Object.values(result.state.pairs).find((pair) => pair.chainId === "xlayer")!;
    expect(xlayer).toMatchObject({ quarantinedSince: NOW, baselineSource: "seed", ambiguousSince: NOW });
    expect(xlayer.baselineUsd).toBeGreaterThan(1_400_000_000);
    expect(xlayer.releasedAt).toBeUndefined();
  });

  it("nulls an immaterial flagged chain without changing aggregate or restored status", async () => {
    const asset = usdg();
    asset.chainCirculating = { "Hyperliquid L1": asset.chainCirculating!["Hyperliquid L1"] };
    const before = { ...asset.circulating };
    const result = await runGuard(asset);
    expect(asset.circulating).toEqual(before);
    expect(asset.supplyRestored).toBeUndefined();
    expect(asset.chainCirculating!["Hyperliquid L1"].current).toBeNull();
    expect(asset.supplyChainGuard?.status).toBe("chains-unavailable");
    expect(result.quarantinedAssetIds).toEqual([]);
  });

  it.each([-DAY, 0, DAY])("releases an immaterial pair only after a later low daily point (offset=%s)", async (pointOffset) => {
    const asset: PeggedAsset = {
      ...usdg(), id: "usdc-circle", symbol: "USDC", circulating: { peggedUSD: 70_000_000_000 },
      chainCirculating: { Tempo: leg(44_854_806.82, 94_886_012) },
    };
    const lowPoint = (date: number) => (chartPoint(44_854_806.82, date));
    mocks.chart.mockResolvedValue(lowPoint(NOW));
    const first = await runGuard(asset);
    expect(asset.chainCirculating!.Tempo.current).toBeNull();
    expect(asset.supplyRestored).toBeUndefined();
    const state = ChainDropoutStateSchema.parse(JSON.parse(JSON.stringify(first.state)));
    expect(Object.values(state.pairs)[0].quarantinedSince).toBe(NOW);
    mocks.chart.mockResolvedValue(lowPoint(NOW + pointOffset));
    const later: PeggedAsset = {
      ...usdg(), id: "usdc-circle", symbol: "USDC", circulating: { peggedUSD: 70_000_000_000 },
      chainCirculating: { Tempo: leg(44_854_806.82) },
    };
    const result = await runGuard(later, { now: NOW + DAY, state });
    expect(later.circulating).toEqual({ peggedUSD: 70_000_000_000 });
    expect(result.quarantinedAssetIds).toEqual([]);
    expect(later.supplyRestored).toBeUndefined();
    if (pointOffset > 0) {
      expect(later.chainCirculating!.Tempo.current).toBe(44_854_806.82);
      expect(later.supplyChainGuard).toBeUndefined();
      expect(Object.values(result.state.pairs)[0]).toMatchObject({
        baselineUsd: 44_854_806.82, baselineObservedAt: NOW + DAY, quarantinedSince: null,
      });
      const recovered = await runGuard(later, { now: NOW + DAY + 900, state: result.state });
      expect(recovered.flagged).toBe(0);
    } else {
      expect(later.chainCirculating!.Tempo.current).toBeNull();
      expect(later.supplyChainGuard?.status).toBe("chains-unavailable");
      expect(Object.values(result.state.pairs)[0]).toMatchObject({
        baselineUsd: 94_886_012, quarantinedSince: NOW,
      });
    }
  });

  it("never releases a material dropout from the same later low daily chart evidence", async () => {
    const makeTempo = (): PeggedAsset => ({
      ...usdg(), id: "usdc-circle", symbol: "USDC", circulating: { peggedUSD: 80_000_000 },
      chainCirculating: { Tempo: leg(44_854_806.82, 94_886_012) },
    });
    const first = await runGuard(makeTempo());
    mocks.chart.mockResolvedValue(chartPoint(44_854_806.82, NOW + DAY));
    const later = makeTempo();
    const result = await runGuard(later, { now: NOW + DAY, state: first.state });
    expect(result.quarantinedAssetIds).toEqual(["usdc-circle"]);
    expect(later).toMatchObject({ supplyRestored: true, supplyChainGuard: { status: "quarantined", quarantinedSince: NOW } });
    expect(later.chainCirculating!.Tempo.current).toBeNull();
    expect(Object.values(result.state.pairs)[0]).toMatchObject({ baselineUsd: 94_886_012, quarantinedSince: NOW });
  });

  it.each([
    ["satusd-river", "arbitrum", "Arbitrum", "peggedUSD", 10_735_947.2549878, 1_149_846.870580486, "2026-10-16T06:18:46Z"],
    ["satusd-river", "bob", "BOB", "peggedUSD", 15_262_228.437422091, 1_361_964.0212558752, "2026-11-03T10:09:25Z"],
    ["satusd-river", "base", "Base", "peggedUSD", 10_558_605.699254569, 239_013.52127648407, "2026-11-03T10:09:25Z"],
    ["satusd-river", "ethereum", "Ethereum", "peggedUSD", 8_377_639.753921411, 932_368.8165761745, "2026-11-03T10:09:23Z"],
    ["dusd-standx", "solana", "Solana", "peggedUSD", 3_013_043.925487889, 786_947.5441566098, "2026-11-03T10:16:00Z"],
    ["eurs-stasis", "polygon", "Polygon", "peggedEUR", 2_125_295.460187289, 472_657.74823731947, "2026-10-16T06:18:46Z"],
    ["sbc-brale", "polygon", "Polygon", "peggedUSD", 1_846_461.79, 362_696.62, "2026-11-06T18:42:00Z"],
    ["sbc-brale", "solana", "Solana", "peggedUSD", 15_916_420.30, 7_797_825.36, "2026-11-07T19:45:46Z"],
    ["gbpa-agant", "ethereum", "Ethereum", "peggedGBP", 1_338_734.83, 136.06, "2026-11-07T19:45:46Z"],
    ["europ-schuman", "solana", "Solana", "peggedEUR", 5_470_671.34, 2_397_116.59, "2026-11-06T18:42:00Z"],
    ["tryb-bilira", "plasma", "Plasma", "peggedTRY", 1_419_521, 267_810, "2026-11-04T00:05:26Z"],
    ["usdq-quantoz", "ethereum", "Ethereum", "peggedUSD", 7_000_000, 2_000_000, "2026-11-04T09:03:51Z"],
    ["usdglo-glo", "base", "Base", "peggedUSD", 1_018_000, 91_319.484821, "2026-11-04T09:03:51Z"],
  ] as const)("accepts only dated reviewed %s / %s reductions, not omitted or later incidents", async (assetId, chainId, chainLabel, pegKey, baseline, current, reviewDate) => {
    const reviewedAt = Date.parse(reviewDate) / 1000;
    const key = JSON.stringify([assetId, chainId]);
    const makeState = (quarantinedSince = reviewedAt - DAY): ChainDropoutState => (savedState(assetId, { chainId, chainLabel, baselineUsd: baseline, baselineObservedAt: quarantinedSince - 900, quarantinedSince, ambiguousSince: quarantinedSince, heldTotalUsd: 20_000_000 }));
    const companionLabel = chainLabel === "Ethereum" ? "Avalanche" : "Ethereum";
    const makeAsset = (includeChain = true): PeggedAsset => ({
      id: assetId, name: assetId, symbol: assetId, pegType: pegKey, supplySource: "defillama",
      circulating: { [pegKey]: 4_000_000 + (includeChain ? current : 0) },
      circulatingPrevDay: { [pegKey]: 4_000_000 + baseline },
      chainCirculating: {
        [companionLabel]: leg(4_000_000, 3_000_000),
        ...(includeChain ? { [chainLabel]: leg(current) } : {}),
      },
    });
    const asset = makeAsset();
    const original = structuredClone(asset);
    const accepted = await runGuard(asset, { now: reviewedAt, state: makeState() });
    expect(accepted.quarantinedAssetIds).toEqual([]);
    expect(accepted.historyFetches).toBe(0);
    expect(asset).toEqual(original);
    expect(accepted.state.pairs[key]).toMatchObject({ baselineUsd: current, quarantinedSince: null, releasedAt: reviewedAt });
    expect([accepted.state.pairs[key].ambiguousSince, accepted.state.pairs[key].heldTotalUsd]).toEqual([undefined, undefined]);

    for (const scenario of [
      { now: reviewedAt - 1, state: makeState(), asset: makeAsset() },
      { now: reviewedAt + 900, state: makeState(reviewedAt + 1), asset: makeAsset() },
      { now: reviewedAt, state: makeState(), asset: makeAsset(false) },
    ]) {
      const held = await runGuard(scenario.asset, { now: scenario.now, state: scenario.state });
      expect(held.quarantinedAssetIds).toEqual([assetId]);
      expect(scenario.asset.chainCirculating![chainLabel].current).toBeNull();
      expect(held.state.pairs[key].releasedAt).toBeUndefined();
    }
  });

  it("withholds provider anchors that predate GHO's reviewed perimeter change", async () => {
    const reviewedAt = Date.parse("2026-11-13T08:03:20Z") / 1000;
    for (const [age, kept] of [[0, 0], [2 * DAY, 1], [8 * DAY, 2], [31 * DAY, 3]] as const) {
      const asset: PeggedAsset = { ...usdg(), id: "gho-aave", circulating: { peggedUSD: 3e8 },
        chainCirculating: { Ethereum: leg(2e8, 8e8), Base: leg(1e8) } };
      const result = await runGuard(asset, { now: reviewedAt + age, state: savedState("gho-aave", {
        chainId: "ethereum", chainLabel: "Ethereum", baselineUsd: 8e8, baselineObservedAt: reviewedAt - DAY, quarantinedSince: reviewedAt - 900 }) });
      expect(result.quarantinedAssetIds).toEqual([]);
      expect(getCirculatingRawOrNull(asset)).toBe(3e8);
      expect([getPrevDayRawOrNull(asset), getPrevWeekRawOrNull(asset), getPrevMonthRawOrNull(asset)].map((value) => value != null))
        .toEqual([kept > 0, kept > 1, kept > 2]);
      expect([asset.chainCirculating!.Ethereum.circulatingPrevDay, asset.chainCirculating!.Base.circulatingPrevDay]).toEqual([kept ? 8e8 : null, 1e8]);
    }
  });

  it.each([0, 14 * DAY])("expires frxUSD's reviewed omitted HyperEVM identity after 14 days (%s)", async (offset) => {
    const reviewedAt = Date.parse("2026-11-07T19:45:46Z") / 1000;
    const asset: PeggedAsset = { ...usdg(), id: "frxusd-frax", circulating: { peggedUSD: 91_508_143.55 },
      chainCirculating: { Ethereum: { current: 91_465_070.06 }, "Hyperliquid L1": { current: 43_073.49 } } };
    const state = savedState(asset.id, { chainId: "hyperevm", chainLabel: "HyperEVM", baselineUsd: 3_749_116.70,
      baselineObservedAt: reviewedAt - 29 * DAY, quarantinedSince: reviewedAt - 24 * DAY });
    const result = await runGuard(asset, { now: reviewedAt + offset, state });
    expect(getCirculatingRawOrNull(asset)).toBe(91_508_143.55);
    expect(asset.supplyRestored).toBeUndefined();
    expect(asset.chainCirculating!.HyperEVM.current).toBeNull();
    expect(result.quarantinedAssetIds).toEqual(offset ? [asset.id] : []);
    const review = asset.supplyChainGuard?.chains[0].reviewedExclusion;
    if (offset) expect(review).toBeUndefined();
    else expect(review?.expiresAt).toBe(reviewedAt + 14 * DAY);
  });

  it("keeps low same-provider chart evidence quarantined and caches attempts hourly", async () => {
    const asset = usdg();
    mocks.chart.mockResolvedValue(chartPoint(0, NOW));
    const first = await runGuard(asset);
    expect(first.quarantinedAssetIds).toEqual(["usdg-paxos"]);
    const later = await runGuard(usdg(), { now: NOW + 900, state: first.state });
    expect(later.historyFetches).toBe(0);
    expect(later.flagged).toBe(3);
    expect(mocks.chart).toHaveBeenCalledTimes(3);
  });

  it("prioritizes deficits and caps sequential fresh chart attempts at eight", async () => {
    const asset = usdg();
    asset.chainCirculating = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`Unknown ${index}`, leg(0, (index + 1) * 1_000_000)]));
    let inflight = 0;
    let peak = 0;
    mocks.chart.mockImplementation(async () => { inflight++; peak = Math.max(peak, inflight); await Promise.resolve(); inflight--; return null; });
    const result = await runGuard(asset);
    expect(result).toMatchObject({ flagged: 10, historyFetches: CHAIN_DROPOUT_POLICY.maxHistoryFetches });
    expect(peak).toBe(1);
    expect(mocks.chart.mock.calls[0][0]).toContain("Unknown%209");
  });

  it("bootstraps from prevDay after seed expiry and respects threshold boundaries", async () => {
    const asset = usdg();
    asset.chainCirculating = { "X Layer": leg(500_000, 1_000_000), Ink: leg(0, 999_999) };
    await runGuard(asset, { now: CHAIN_DROPOUT_SEED_VALID_UNTIL + 1 });
    expect(asset.supplyChainGuard?.chains).toHaveLength(1);
    expect(asset.supplyChainGuard?.chains[0]).toMatchObject({ baselineSource: "list-prev-day", baselineUsd: 1_000_000 });
    expect(asset.chainCirculating!.Ink.current).toBe(0);
  });

  it("retains seeds for noncanonical chain labels", async () => {
    const seed = CHAIN_DROPOUT_SEED.find((entry) => entry.chainLabel === "XDC")!;
    const asset: PeggedAsset = { ...usdg(), id: seed.assetId, chainCirculating: { XDC: leg(0) } };
    await runGuard(asset);
    expect(asset.supplyChainGuard?.chains[0]).toMatchObject({ chainLabel: "XDC", baselineUsd: seed.baselineUsd, baselineSource: "seed" });
  });

  it("ignores frozen, other-lane restored and reconciled assets", async () => {
    const assets = [{ ...usdg(), frozen: true }, { ...usdg(), supplyRestored: true }, { ...usdg(), supplySource: "coingecko-gap-fill" }];
    const result = await guardChainDropouts({ assets, now: NOW, state: { version: 1, pairs: {} } });
    expect(result.flagged).toBe(0);
    const skipped = await runGuard(usdg(), { skipAssetIds: new Set(["usdg-paxos"]) });
    expect(skipped.flagged).toBe(0);
    expect(mocks.chart).not.toHaveBeenCalled();
  });

  it("reads every rwaUSDi roster leg without widening Pharos's registry admission", async () => {
    const rpcs = buildChainRpcs("test-placeholder");
    for (const pair of CHAIN_DROPOUT_ONCHAIN_ROSTER) {
      expect(CHAIN_META[pair.chainId]).toBeDefined();
      expect(hasRegistryRpc(rpcs.get(pair.chainId))).toBe(pair.chainId !== "pharos");
      expect(ACTIVE_META_BY_ID.get(pair.assetId)?.contracts?.filter((entry) => entry.chain === pair.chainId)).toHaveLength(1);
    }
    expect(CHAIN_DROPOUT_SEED).toHaveLength(39);
    expect(ChainDropoutStateSchema.parse({ version: 1, pairs: {} })).toEqual({ version: 1, pairs: {} } satisfies ChainDropoutState);
    const rows = Object.fromEntries(CHAIN_DROPOUT_ONCHAIN_ROSTER.filter((pair) => pair.assetId === "rwausdi-multipli")
      .map(({ chainId }) => [chainId, leg(1, 24_000_000)]));
    const incoming: PeggedAsset = { ...usdg(), id: "rwausdi-multipli", circulating: { peggedUSD: 7 }, chainCirculating: rows,
      priceListFillDefault: { value: 0.000055, upstreamSource: null } };
    const asset = structuredClone(incoming);
    mocks.onchain.mockResolvedValue(12_000_000n * 10n ** 6n);
    const result = await runGuard(asset, { chainRpcs: rpcs });
    expect(result).toMatchObject({ repaired: 7, quarantinedAssetIds: [], unavailableAssetIds: [], historyFetches: 0 });
    expect(asset).toMatchObject({ circulating: { peggedUSD: 84_000_000 }, supplySource: "defillama-chain-repair" });
    expect(asset.supplyRestored).toBeUndefined();
    expect(mocks.onchain.mock.calls.find(([config]) => config.chain === "pharos")?.slice(4)).toEqual(["https://rpc.pharos.xyz", "https://api.zan.top/public/pharos-mainnet"]);
    expect(mocks.onchain.mock.calls.find(([config]) => config.chain === "robinhood")?.slice(4)).toEqual(["https://rpc.mainnet.chain.robinhood.com", "https://robinhood-rpc.publicnode.com"]);
    rpcs.get("pharos")!.endpoints = rpcs.get("pharos")!.endpoints.map((endpoint) => ({ ...endpoint, routingDisabled: true }));
    const failed = await runGuard(incoming, { chainRpcs: rpcs });
    expect(failed.repaired).toBe(6);
    expect(incoming.supplyChainGuard?.status).toBe("quarantined");
    expect(incoming.supplyChainGuard?.chains.find((chain) => chain.chainId === "pharos")).toMatchObject({ resolution: "carried-baseline" });
  });
});

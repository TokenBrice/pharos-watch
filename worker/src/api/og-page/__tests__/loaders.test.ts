import { afterEach, describe, expect, it, vi } from "vitest";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { PSI_HEX_COLORS } from "@shared/lib/classification";
import { CLIENT_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { CLIENT_CORE_AGGREGATE_ACTIVE_IDS } from "@shared/lib/stablecoins/aggregate-client-registry";
import { makeAsset } from "../../../test-helpers/__shared/fixtures";

const mocks = vi.hoisted(() => ({
  loadStablecoinsCache: vi.fn(),
  handlePegSummary: vi.fn(),
  handleStabilityIndex: vi.fn(),
  handleChains: vi.fn(),
  handleMintBurnFlows: vi.fn(),
  handleDexLiquidity: vi.fn(),
  handleYieldRankings: vi.fn(),
  loadActiveSafetyScoreSource: vi.fn(),
  projectDependencyGraph: vi.fn(),
}));

vi.mock("../../../lib/stablecoins-cache", () => ({ loadStablecoinsCache: mocks.loadStablecoinsCache }));
vi.mock("../../peg-summary", () => ({ handlePegSummary: mocks.handlePegSummary }));
vi.mock("../../stability-index", () => ({ handleStabilityIndex: mocks.handleStabilityIndex }));
vi.mock("../../chains", () => ({ handleChains: mocks.handleChains }));
vi.mock("../../mint-burn-flows", () => ({ handleMintBurnFlows: mocks.handleMintBurnFlows }));
vi.mock("../../dex-liquidity", () => ({ handleDexLiquidity: mocks.handleDexLiquidity }));
vi.mock("../../yield-rankings-cache", () => ({ handleYieldRankings: mocks.handleYieldRankings }));
vi.mock("../../../lib/safety-score-active-source", () => ({ loadActiveSafetyScoreSource: mocks.loadActiveSafetyScoreSource }));
vi.mock("@shared/types/dependency-graph", () => ({ projectDependencyGraph: mocks.projectDependencyGraph }));
// Owner bodies are validated against their published schemas in production; these
// tests exercise the loaders' own decisions, so they read the fixture body as served.
vi.mock("../types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../types")>()),
  readOwnerJson: async (response: Response) => (response.ok ? response.json() : null),
}));

import { OG_PAGE_LOADERS } from "../index";
import { OG_SOURCE_BUDGET_SEC } from "../types";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { FRESHNESS_RATIOS, getCacheRatioThresholds } from "@shared/lib/status-thresholds";

const NOW = 1_790_000_000;
const db = {} as D1Database;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function stablecoinsCache(assets: unknown[], updatedAt = NOW - 60) {
  return { kind: "ok", payload: { peggedAssets: assets }, updatedAt };
}

function pegSummary(coins: Array<{ id: string; activeDepeg: boolean }>, asOf = NOW - 60) {
  return json({ coins, summary: null, methodology: { asOf } });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("route-card admission budgets", () => {
  it("admit at least two producer runs, so a card never flaps to timeless between runs", () => {
    expect(OG_SOURCE_BUDGET_SEC.stablecoins).toBeGreaterThanOrEqual(2 * CRON_INTERVALS["sync-stablecoins"]!);
    expect(OG_SOURCE_BUDGET_SEC.pegSummary).toBeGreaterThanOrEqual(2 * CRON_INTERVALS["sync-stablecoins"]!);
    for (const budget of Object.values(OG_SOURCE_BUDGET_SEC)) expect(Number.isFinite(budget) && budget > 0).toBe(true);
  });

  it("admit a figure for as long as its page publishes it as fresh", () => {
    expect(OG_SOURCE_BUDGET_SEC.mintBurnFlows).toBe(API_FRESHNESS_MAX_AGE_SEC.mintBurnFlows * FRESHNESS_RATIOS.FRESH);
    expect(OG_SOURCE_BUDGET_SEC.yieldRankings).toBe(
      Math.max(2 * CRON_INTERVALS["sync-yield-data"]!, API_FRESHNESS_MAX_AGE_SEC.yieldRankings * getCacheRatioThresholds("yield-data").degraded),
    );
  });
});

describe("home route card", () => {
  const coreAssets = () => [...CLIENT_CORE_AGGREGATE_ACTIVE_IDS].map((id) => makeAsset({ id, circulating: { peggedUSD: 1_000_000_000 } }));

  it("publishes the complete core market cap with independently failing support items", async () => {
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache(coreAssets()));
    mocks.handleStabilityIndex.mockRejectedValue(new Error("psi read failed"));
    mocks.handlePegSummary.mockResolvedValue(pegSummary([{ id: [...CLIENT_CORE_AGGREGATE_ACTIVE_IDS][0]!, activeDepeg: true }]));

    const load = await OG_PAGE_LOADERS.home(db, NOW);
    expect(load).toMatchObject({ kind: "ok", asOfSec: NOW - 60, budgetSec: OG_SOURCE_BUDGET_SEC.stablecoins });
    if (load.kind !== "ok") throw new Error("expected a live card");
    expect(load.hero).toMatch(/^\$\d/);
    // The failed PSI read is dropped, not rendered as a zero or a calm band.
    expect(load.support).toEqual(["1 active depeg"]);
  });

  it("swatches the PSI support item with the band it read this render", async () => {
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache(coreAssets()));
    mocks.handleStabilityIndex.mockResolvedValue(json({ current: { score: 91, band: "BEDROCK", avg24h: 92.4, avg24hBand: "STEADY", computedAt: NOW - 60 } }));
    mocks.handlePegSummary.mockResolvedValue(json({ error: "unavailable" }, 503));
    const load = await OG_PAGE_LOADERS.home(db, NOW);
    expect(load).toMatchObject({ kind: "ok", support: [{ text: "PSI Steady 92.4", swatchHex: PSI_HEX_COLORS.STEADY }] });
  });

  it("stays live through one missed producer run and fails closed only past two", async () => {
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache(coreAssets(), NOW - CRON_INTERVALS["sync-stablecoins"]! - 300));
    await expect(OG_PAGE_LOADERS.home(db, NOW)).resolves.toMatchObject({ kind: "ok" });

    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache(coreAssets(), NOW - OG_SOURCE_BUDGET_SEC.stablecoins - 1));
    await expect(OG_PAGE_LOADERS.home(db, NOW)).resolves.toEqual({ kind: "unavailable", reason: "stale-cache" });
  });

  it("mirrors the page's known subtotal with its partial note instead of going timeless", async () => {
    const partial = coreAssets();
    partial.pop();
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache(partial));
    const expected = CLIENT_CORE_AGGREGATE_ACTIVE_IDS.size;
    await expect(OG_PAGE_LOADERS.home(db, NOW)).resolves.toMatchObject({
      kind: "ok",
      context: "known market cap subtotal of tracked stablecoins",
      stampNote: `Partial · ${expected - 1}/${expected} assets observed`,
    });

    mocks.loadStablecoinsCache.mockResolvedValue({ kind: "error", reason: "missing-cache" });
    await expect(OG_PAGE_LOADERS.home(db, NOW)).resolves.toEqual({ kind: "unavailable", reason: "cache-missing" });
  });
});

describe("chains route card", () => {
  const chainsBody = (overrides: Record<string, unknown> = {}) => ({
    chains: [
      { name: "Tron", totalUsd: 30, dominanceShare: 0.3 },
      { name: "Ethereum", totalUsd: 50, dominanceShare: 0.5 },
      { name: "BSC", totalUsd: 10, dominanceShare: 0.1 },
      { name: "Base", totalUsd: 5, dominanceShare: 0.05 },
    ],
    globalTotalUsd: 100_000_000_000,
    supplyCoverage: { aggregateUnavailableAssetCount: 0, chainUnavailableObservationCount: 0, chainIdsWithUnavailableObservations: [] },
    updatedAt: NOW - 60,
    ...overrides,
  });

  const coreAssets = () => [...CLIENT_CORE_AGGREGATE_ACTIVE_IDS].map((id) => makeAsset({ id, circulating: { peggedUSD: 1_000_000 } }));

  it("publishes the global total with the top three chains by supply", async () => {
    mocks.handleChains.mockResolvedValue(json(chainsBody()));
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache(coreAssets()));
    await expect(OG_PAGE_LOADERS.chains(db, NOW)).resolves.toMatchObject({
      kind: "ok",
      hero: "$100.00B",
      context: "total market cap of tracked stablecoins, on 4 chains",
      support: ["Ethereum 50.0%", "Tron 30.0%", "BSC 10.0%"],
      visual: { kind: "share-bar", shares: [0.5, 0.3, 0.1] },
    });
  });

  it("labels a partial total with the homepage completeness verdict, counting absent members too", async () => {
    // `supplyCoverage` reports nothing missing; the core member is absent from the cache entirely.
    mocks.handleChains.mockImplementation(async () => json(chainsBody()));
    const partial = coreAssets();
    partial.pop();
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache(partial));
    const expected = CLIENT_CORE_AGGREGATE_ACTIVE_IDS.size;
    await expect(OG_PAGE_LOADERS.chains(db, NOW)).resolves.toMatchObject({
      kind: "ok",
      context: "known market cap subtotal of tracked stablecoins, on 4 chains",
      stampNote: `Partial · ${expected - 1}/${expected} assets observed`,
    });

    // The two reads must be one stablecoins generation.
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache(coreAssets(), NOW - 30));
    await expect(OG_PAGE_LOADERS.chains(db, NOW)).resolves.toEqual({ kind: "unavailable", reason: "owner-error" });
  });

  it("drops chain shares that exclude unavailable observations", async () => {
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache(coreAssets()));

    mocks.handleChains.mockResolvedValue(json(chainsBody({
      supplyCoverage: { aggregateUnavailableAssetCount: 0, chainUnavailableObservationCount: 3, chainIdsWithUnavailableObservations: ["tron"] },
    })));
    const partialShares = await OG_PAGE_LOADERS.chains(db, NOW);
    expect(partialShares).toMatchObject({ kind: "ok", support: [] });
    expect(partialShares).not.toHaveProperty("visual");

    mocks.handleChains.mockResolvedValue(json({ error: "Data not yet available" }, 503));
    await expect(OG_PAGE_LOADERS.chains(db, NOW)).resolves.toEqual({ kind: "unavailable", reason: "owner-error" });
  });
});

describe("timeline route card", () => {
  it("counts the full open set over the active registry, keeping an observed zero", async () => {
    const [activeA, activeB] = CLIENT_ACTIVE_STABLECOINS;
    mocks.handlePegSummary.mockResolvedValue(pegSummary([
      { id: activeA!.id, activeDepeg: true },
      { id: activeB!.id, activeDepeg: false },
      { id: "not-a-tracked-coin", activeDepeg: true },
    ]));
    await expect(OG_PAGE_LOADERS.timeline(db, NOW)).resolves.toMatchObject({ kind: "ok", hero: "1", context: "open depeg incident across tracked stablecoins" });

    mocks.handlePegSummary.mockResolvedValue(pegSummary([{ id: activeA!.id, activeDepeg: false }]));
    await expect(OG_PAGE_LOADERS.timeline(db, NOW)).resolves.toMatchObject({ kind: "ok", hero: "0", context: "open depeg incidents across tracked stablecoins" });
  });

  it("never publishes a count from a stale peg summary", async () => {
    mocks.handlePegSummary.mockResolvedValue(pegSummary([], NOW - OG_SOURCE_BUDGET_SEC.pegSummary - 1));
    await expect(OG_PAGE_LOADERS.timeline(db, NOW)).resolves.toEqual({ kind: "unavailable", reason: "stale-cache" });
  });
});

describe("flows route card", () => {
  const coin = (overrides: Record<string, unknown>) => ({
    id: "usdt-tether",
    mintVolume24hUsd: 0,
    burnVolume24hUsd: 0,
    netFlow24hUsd: 0,
    ...overrides,
  });
  const flowsBody = (coins: unknown[]) => ({ coins, updatedAt: NOW - 60 });

  it("publishes a signed net only for a complete window, with no verdict", async () => {
    mocks.handleMintBurnFlows.mockResolvedValue(json(flowsBody([
      coin({ mintVolume24hUsd: 300_000_000, burnVolume24hUsd: 100_000_000, netFlow24hUsd: 200_000_000,
        valuation: { window24h: { completeness: "complete", mintCompleteness: "complete", burnCompleteness: "complete", unpricedMintEventCount: 0, unpricedBurnEventCount: 0 } } }),
    ])));
    const load = await OG_PAGE_LOADERS.flows(db, NOW);
    expect(load).toMatchObject({
      kind: "ok",
      hero: "+$200.0M",
      visual: { kind: "pair-bars", bars: [{ value: 300_000_000, text: "Printed $300.0M" }, { value: 100_000_000, text: "Shredded $100.0M" }] },
    });
    expect(JSON.stringify(load)).not.toMatch(/softer|stronger|minting,|burning,/i);
  });

  it("shows a partial window's known gross as a lower bound, never a signed partial net", async () => {
    mocks.handleMintBurnFlows.mockResolvedValue(json(flowsBody([
      coin({ mintVolume24hUsd: 50_000_000, burnVolume24hUsd: 150_000_000, netFlow24hUsd: null,
        valuation: { window24h: { completeness: "partial", mintCompleteness: "partial", burnCompleteness: "complete", unpricedMintEventCount: 2, unpricedBurnEventCount: 0 } } }),
    ])));
    const load = await OG_PAGE_LOADERS.flows(db, NOW);
    expect(load).toMatchObject({ kind: "ok", hero: "≥ $200.0M", support: [] });
    expect(load).not.toHaveProperty("visual");
    expect(JSON.stringify(load)).not.toContain("-$100.0M");
  });
});

describe("freezewatch route card", () => {
  const activeAssets = () => CLIENT_ACTIVE_STABLECOINS.map((meta) => makeAsset({ id: meta.id, circulating: { peggedUSD: 1_000_000 } }));

  it("publishes the page's freezable share from complete supply", async () => {
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache(activeAssets()));
    const load = await OG_PAGE_LOADERS.freezewatch(db, NOW);
    expect(load).toMatchObject({ kind: "ok", context: "of tracked stablecoin market cap is under issuer freeze control" });
    if (load.kind !== "ok") throw new Error("expected a live card");
    expect(load.hero).toMatch(/%$/);
  });

  it("fails closed when supply coverage is partial", async () => {
    const assets = activeAssets();
    assets.pop();
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache(assets));
    await expect(OG_PAGE_LOADERS.freezewatch(db, NOW)).resolves.toEqual({ kind: "unavailable", reason: "incomplete-coverage" });
  });
});

describe("liquidity route card", () => {
  it("publishes the global DEX TVL and fails closed on invalid coverage evidence", async () => {
    mocks.handleDexLiquidity.mockResolvedValue(json({ __global__: { totalTvlUsd: 4_750_000_000, updatedAt: NOW - 60, unavailableReason: null } }));
    await expect(OG_PAGE_LOADERS.liquidity(db, NOW)).resolves.toMatchObject({ kind: "ok", hero: "$4.75B" });

    mocks.handleDexLiquidity.mockResolvedValue(json({ __global__: { totalTvlUsd: 4_750_000_000, updatedAt: NOW - 60, unavailableReason: "invalid-coverage-evidence" } }));
    await expect(OG_PAGE_LOADERS.liquidity(db, NOW)).resolves.toEqual({ kind: "unavailable", reason: "incomplete-coverage" });

    mocks.handleDexLiquidity.mockResolvedValue(json({}));
    await expect(OG_PAGE_LOADERS.liquidity(db, NOW)).resolves.toEqual({ kind: "unavailable", reason: "figure-null" });
  });
});

describe("yield route card", () => {
  const row = (id: string, safetyGrade: string | null, apy30d: number) => ({ id, safetyGrade, apy30d, sourceTvlUsd: 1, confidence: 1 });

  it("counts ranked yields and supports with the A/B median, never the top APY", async () => {
    mocks.handleYieldRankings.mockResolvedValue(json({
      rankings: [row("a", "A", 4), row("b", "B+", 6), row("c", "C", 25), row("d", null, 30)],
      updatedAt: NOW - 60,
    }));
    const load = await OG_PAGE_LOADERS.yield(db, NOW);
    expect(load).toMatchObject({ kind: "ok", hero: "4", support: ["Median 30D APY, A/B safety grade: 5.00%"] });
    expect(JSON.stringify(load)).not.toContain("30.00%");
  });

  it("keeps a degraded generation the page still shows and fails closed on a stale verdict", async () => {
    mocks.handleYieldRankings.mockResolvedValue(json({ rankings: [row("a", "A", 4)], updatedAt: NOW - 60, _meta: { status: "degraded" } }));
    await expect(OG_PAGE_LOADERS.yield(db, NOW)).resolves.toMatchObject({ kind: "ok" });
    mocks.handleYieldRankings.mockResolvedValue(json({ rankings: [row("a", "A", 4)], updatedAt: NOW - 60, _meta: { status: "stale" } }));
    await expect(OG_PAGE_LOADERS.yield(db, NOW)).resolves.toEqual({ kind: "unavailable", reason: "stale-cache" });
  });
});

describe("dependency-map route card", () => {
  it("serves the timeless card for a held publication", async () => {
    mocks.loadActiveSafetyScoreSource.mockResolvedValue({ kind: "held", snapshot: {} });
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache([]));
    mocks.projectDependencyGraph.mockReturnValue({ publicationStatus: "held", nodes: [], edges: [], updatedAt: NOW - 60 });
    await expect(OG_PAGE_LOADERS["dependency-map"](db, NOW)).resolves.toEqual({ kind: "unavailable", reason: "held-publication" });
  });

  it("publishes mapped exposure with the older read's stamp", async () => {
    mocks.loadActiveSafetyScoreSource.mockResolvedValue({ kind: "v9", snapshot: {} });
    mocks.projectDependencyGraph.mockReturnValue({
      publicationStatus: "current",
      publicationGenerationId: "gen-1",
      methodologyVersion: "10.17",
      updatedAt: NOW - 120,
      nodes: [{ id: "dai-makerdao", sharedBookId: null }, { id: "susds-sky", sharedBookId: null }],
      edges: [{ from: "dai-makerdao", to: "susds-sky", kind: "serial", wrapperForm: "pure", weight: 1 }],
    });
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache([
      makeAsset({ id: "dai-makerdao", circulating: { peggedUSD: 1_000 } }),
      makeAsset({ id: "susds-sky", circulating: { peggedUSD: 500 } }),
    ]));
    await expect(OG_PAGE_LOADERS["dependency-map"](db, NOW)).resolves.toMatchObject({
      kind: "ok",
      support: ["1 upstream hubs", "1 direct dependents"],
      stampNote: "methodology v10.17",
      // Stamped with the older read and expiring with the first budget to lapse.
      asOfSec: NOW - 120,
      freshUntilSec: Math.min(NOW - 120 + OG_SOURCE_BUDGET_SEC.reportCards, NOW - 60 + OG_SOURCE_BUDGET_SEC.stablecoins),
    });

    // No dependent with supply: the page publishes no figure, so neither does the card.
    mocks.loadStablecoinsCache.mockResolvedValue(stablecoinsCache([makeAsset({ id: "dai-makerdao", circulating: { peggedUSD: 1_000 } })]));
    await expect(OG_PAGE_LOADERS["dependency-map"](db, NOW)).resolves.toEqual({ kind: "unavailable", reason: "figure-null" });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { resolveDexDeploymentCensusMaxAgeSec } from "../../cron/dex-liquidity/deployment-census-coverage";
import { classifyStoredDexCensusState } from "../../cron/dex-discovery/census-state-machine";
import { computeDexDeploymentSupplyCoverage } from "../report-cards-snapshot-inputs";

const mocks = vi.hoisted(() => ({
  getCache: vi.fn(),
  loadDexLiquiditySnapshot: vi.fn(),
  loadRedemptionBackstopSnapshot: vi.fn(),
  loadFreshIndependentLiveReserveMap: vi.fn(),
}));

// Kept partial so the DEX/report-card cases below still see the real module.
vi.mock("../db-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db-cache")>()),
  getCache: mocks.getCache,
}));
vi.mock("../dex-liquidity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dex-liquidity")>()),
  loadDexLiquiditySnapshot: mocks.loadDexLiquiditySnapshot,
}));
vi.mock("../redemption-backstops-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../redemption-backstops-store")>()),
  loadRedemptionBackstopSnapshot: mocks.loadRedemptionBackstopSnapshot,
}));
vi.mock("../live-reserves/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../live-reserves/store")>()),
  loadFreshIndependentLiveReserveMap: mocks.loadFreshIndependentLiveReserveMap,
}));

const { loadReportCardsSnapshotInputs } = await import("../report-cards-snapshot-inputs");
const { RedemptionBackstopSnapshotUnavailableError } = await import("../redemption-backstops-store");

function supplyPoint(current: number) {
  return {
    current,
    circulatingPrevDay: current,
    circulatingPrevWeek: current,
    circulatingPrevMonth: current,
  };
}

describe("report-card DEX deployment supply join", () => {
  it.each([null, 0])("distinguishes unavailable chain supply from observed zero (%s)", (current) => {
    const coverage = computeDexDeploymentSupplyCoverage(
      {
        circulating: { peggedUSD: 100 },
        chainCirculating: { Ethereum: supplyPoint(100), Base: { current } },
        contracts: [{ chain: "ethereum", address: "0x111", decimals: 18 }],
      },
      [{ chain: "ethereum", contractAddress: "0x111", outcome: "observed_pools" }],
      new Map([["ethereum", 50]]),
    );
    if (current === null) expect(coverage).toBeNull();
    else expect(coverage).toMatchObject({ totalSupplyUsd: 100, observedSupplyRatio: 1 });
  });

  it("weights exact deployment outcomes by current chain supply", () => {
    const coverage = computeDexDeploymentSupplyCoverage(
      {
        circulating: { peggedUSD: 100_000_000 },
        chainCirculating: {
          Ethereum: supplyPoint(80_000_000),
          Base: supplyPoint(20_000_000),
        },
        contracts: [
          { chain: "ethereum", address: "0x111", decimals: 18 },
          { chain: "base", address: "0x222", decimals: 18 },
        ],
      },
      [
        { chain: "Ethereum", contractAddress: "0x111", outcome: "observed_pools" },
        { chain: "Base", contractAddress: "0x222", outcome: "provider_inaccessible" },
      ],
      new Map([
        ["ethereum", 5_000_000],
        ["base", 0],
      ]),
    );

    expect(coverage).toMatchObject({
      totalSupplyUsd: 100_000_000,
      observedSupplyUsd: 80_000_000,
      providerInaccessibleSupplyUsd: 20_000_000,
      observedSupplyRatio: 0.8,
      providerInaccessibleSupplyRatio: 0.2,
      unknownSupplyUsd: 0,
    });
  });

  it("keeps same-chain multi-contract supply unknown", () => {
    const coverage = computeDexDeploymentSupplyCoverage(
      {
        circulating: { peggedUSD: 10_000_000 },
        chainCirculating: { Ethereum: supplyPoint(10_000_000) },
        contracts: [
          { chain: "ethereum", address: "0x111", decimals: 18 },
          { chain: "ethereum", address: "0x222", decimals: 18 },
        ],
      },
      [
        { chain: "ethereum", contractAddress: "0x111", outcome: "observed_pools" },
        { chain: "ethereum", contractAddress: "0x222", outcome: "verified_no_pools" },
      ],
      new Map([["ethereum", 1_000_000]]),
    );

    expect(coverage).toMatchObject({
      unknownSupplyUsd: 10_000_000,
      unknownSupplyRatio: 1,
      unknownChains: ["ethereum"],
    });
  });

  it("treats contradictory observed-pool and chain-TVL evidence as unknown", () => {
    const coverage = computeDexDeploymentSupplyCoverage(
      {
        circulating: { peggedUSD: 10_000_000 },
        chainCirculating: { Ethereum: supplyPoint(10_000_000) },
        contracts: [{ chain: "ethereum", address: "0x111", decimals: 18 }],
      },
      [{ chain: "ethereum", contractAddress: "0x111", outcome: "observed_pools" }],
      new Map([["ethereum", 0]]),
    );

    expect(coverage).toMatchObject({
      observedSupplyUsd: 0,
      unknownSupplyUsd: 10_000_000,
      unknownChains: ["ethereum"],
    });
  });

  it("keeps stale deployment outcomes unknown at a fixed scoring clock", () => {
    const coverage = computeDexDeploymentSupplyCoverage(
      {
        circulating: { peggedUSD: 10_000_000 },
        chainCirculating: { Ethereum: supplyPoint(10_000_000) },
        contracts: [{ chain: "ethereum", address: "0x111", decimals: 18 }],
      },
      [
        {
          chain: "ethereum",
          contractAddress: "0x111",
          outcome: "observed_pools",
          observedAt: 1_000,
        },
      ],
      new Map([["ethereum", 1_000_000]]),
      { asOfSec: 10_000, maxOutcomeAgeSec: 1_000 },
    );

    expect(coverage).toMatchObject({
      observedSupplyUsd: 0,
      unknownSupplyUsd: 10_000_000,
      unknownChains: ["ethereum"],
    });
  });

  it("keeps future-dated deployment outcomes unknown at a fixed scoring clock", () => {
    const coverage = computeDexDeploymentSupplyCoverage(
      {
        circulating: { peggedUSD: 10_000_000 },
        chainCirculating: { Ethereum: supplyPoint(10_000_000) },
        contracts: [{ chain: "ethereum", address: "0x111", decimals: 18 }],
      },
      [
        {
          chain: "ethereum",
          contractAddress: "0x111",
          outcome: "observed_pools",
          observedAt: 10_001,
        },
      ],
      new Map([["ethereum", 1_000_000]]),
      { asOfSec: 10_000, maxOutcomeAgeSec: 1_000 },
    );

    expect(coverage).toMatchObject({
      observedSupplyUsd: 0,
      unknownSupplyUsd: 10_000_000,
      unknownChains: ["ethereum"],
    });
  });

  it("supersedes an older lowercase non-EVM deployment outcome after identity correction", () => {
    const solanaMint = "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1";
    const coverage = computeDexDeploymentSupplyCoverage(
      {
        circulating: { peggedUSD: 10_000_000 },
        chainCirculating: { Solana: supplyPoint(10_000_000) },
        contracts: [{ chain: "solana", address: solanaMint, decimals: 6 }],
      },
      [
        {
          chain: "solana",
          contractAddress: solanaMint.toLowerCase(),
          outcome: "verified_no_pools",
          observedAt: 1_000,
        },
        {
          chain: "Solana",
          contractAddress: solanaMint,
          outcome: "observed_pools",
          observedAt: 2_000,
        },
      ],
      new Map([["solana", 1_000_000]]),
      { asOfSec: 2_100, maxOutcomeAgeSec: 10_000 },
    );

    expect(coverage).toMatchObject({
      observedSupplyUsd: 10_000_000,
      unknownSupplyUsd: 0,
      unknownChains: [],
    });
  });

  it("distinguishes verified empty supply from provider-inaccessible supply", () => {
    const coverage = computeDexDeploymentSupplyCoverage(
      {
        circulating: { peggedUSD: 100 },
        chainCirculating: {
          Ethereum: supplyPoint(60),
          Base: supplyPoint(40),
        },
        contracts: [
          { chain: "ethereum", address: "0x111", decimals: 18 },
          { chain: "base", address: "0x222", decimals: 18 },
        ],
      },
      [
        { chain: "ethereum", contractAddress: "0x111", outcome: "verified_no_pools" },
        { chain: "base", contractAddress: "0x222", outcome: "provider_inaccessible" },
      ],
      new Map(),
    );

    expect(coverage).toMatchObject({
      verifiedNoPoolsSupplyRatio: 0.6,
      providerInaccessibleSupplyRatio: 0.4,
      observedSupplyRatio: 0,
      unknownSupplyRatio: 0,
    });
  });

  it("clamps floating-point ratio noise at the serialized contract boundary", () => {
    const coverage = computeDexDeploymentSupplyCoverage(
      {
        circulating: { peggedUSD: 0.3 },
        chainCirculating: {
          Ethereum: supplyPoint(0.1),
          Base: supplyPoint(0.2),
        },
        contracts: [
          { chain: "ethereum", address: "0x111", decimals: 18 },
          { chain: "base", address: "0x222", decimals: 18 },
        ],
      },
      [],
      new Map(),
    );

    expect(coverage?.unknownSupplyRatio).toBe(1);
  });
});

describe("report-card deployment-supply join attempt fence", () => {
  const NOW_SEC = 1_700_000_000;
  const HOUR_SEC = 3_600;
  const COIN_ID = "steakusdc-steakhouse";
  const COIN_META = ACTIVE_META_BY_ID.get(COIN_ID)!;
  const DEPLOYMENT = COIN_META.contracts![0]!;
  const CENSUS_MAX_AGE_SEC = resolveDexDeploymentCensusMaxAgeSec([DEPLOYMENT]);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1_000);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.loadDexLiquiditySnapshot.mockReset();
    mocks.loadRedemptionBackstopSnapshot.mockReset().mockResolvedValue({
      map: {},
      latestUpdatedAt: NOW_SEC - 60,
      runId: "redemption:test",
      methodologyVersion: "redemption:test",
      reserveInputAssessment: { state: "fresh", quarantined: {} },
    });
    mocks.loadFreshIndependentLiveReserveMap.mockReset()
      .mockResolvedValue(Object.assign(new Map(), { provenanceById: new Map() }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps a verified-empty outcome superseded by a later attributed attempt fence unknown", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      // A recrawl fenced this deployment at attemptFenceSec before network work,
      // then aborted, so the stored empty outcome still carries its older clock.
      const observedAtSec = NOW_SEC - HOUR_SEC;
      const attemptFenceSec = NOW_SEC - 60;
      sqlite.prepare(`INSERT INTO dex_liquidity (stablecoin_id, symbol, chain_tvl_json, updated_at)
        VALUES (?, ?, ?, ?)`).run(COIN_ID, COIN_META.symbol, JSON.stringify({ [DEPLOYMENT.chain]: 0 }), NOW_SEC - 60);
      sqlite.prepare(`INSERT INTO dex_deployment_outcomes
          (stablecoin_id, chain, contract_address, outcome, provider_set_json, reason,
           observed_pool_count, observed_at, last_attempt_at)
        VALUES (?, ?, ?, 'verified_no_pools', ?, ?, 0, ?, ?)`).run(
        COIN_ID, DEPLOYMENT.chain, DEPLOYMENT.address, JSON.stringify(["geckoterminal"]),
        "A provider completed the direct-token query with no eligible pool", observedAtSec, attemptFenceSec,
      );
      sqlite.prepare(`INSERT INTO dex_discovery_meta
          (stablecoin_id, consecutive_misses, last_crawl_at, last_hit_at, deployment_fence_attribution_at)
        VALUES (?, 0, ?, NULL, ?)`).run(COIN_ID, attemptFenceSec, attemptFenceSec);

      expect(classifyStoredDexCensusState({
        outcome: "verified_no_pools",
        reason: "A provider completed the direct-token query with no eligible pool",
        observedPoolCount: 0,
        observedAt: observedAtSec,
        discoveryLastCrawlAt: attemptFenceSec,
        providerCount: 1,
        nowSec: NOW_SEC,
        maxAgeSec: CENSUS_MAX_AGE_SEC,
        providerSetSuperseded: false,
      }).disposition).toBe("superseded");

      mocks.loadDexLiquiditySnapshot.mockResolvedValue({
        map: { [COIN_ID]: {} },
        latestUpdatedAt: NOW_SEC - 60,
      });
      const asset = makeStablecoin({
        id: COIN_ID,
        circulating: { peggedUSD: 100 },
        contracts: [DEPLOYMENT],
        chainCirculating: { Ethereum: supplyPoint(100) },
      });
      const inputs = await loadReportCardsSnapshotInputs(db, {
        preloadedStablecoinsCache: { kind: "ok", payload: { peggedAssets: [asset] }, updatedAt: NOW_SEC },
      });

      // Superseded evidence cannot manufacture verified-empty supply.
      expect(inputs.dexLiquiditySnapshot.map[COIN_ID]).toMatchObject({
        deploymentSupplyCoverage: {
          totalSupplyUsd: 100,
          observedSupplyUsd: 0,
          verifiedNoPoolsSupplyUsd: 0,
          verifiedNoPoolsSupplyRatio: 0,
          unknownSupplyUsd: 100,
          unknownSupplyRatio: 1,
          unknownChains: ["ethereum"],
        },
      });
    } finally {
      sqlite.close();
    }
  });

  it("withholds verified-empty supply for a row certified under a stale provider set", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      // A Kava native bank denom row persisted before EVM-namespace providers
      // were gated off: its empty CoinGecko scan certified a scope it never
      // covered, so it cannot count as verified-empty deployment supply.
      const coinId = "usdx-kava";
      const observedAtSec = NOW_SEC - 60;
      const lastCrawlAtSec = NOW_SEC - 120;
      sqlite.prepare(`INSERT INTO dex_liquidity (stablecoin_id, symbol, chain_tvl_json, updated_at)
        VALUES (?, ?, ?, ?)`).run(coinId, "USDX", JSON.stringify({ kava: 0 }), NOW_SEC - 60);
      sqlite.prepare(`INSERT INTO dex_deployment_outcomes
          (stablecoin_id, chain, contract_address, outcome, provider_set_json, reason,
           observed_pool_count, observed_at, last_attempt_at)
        VALUES (?, 'kava', 'usdx', 'verified_no_pools', ?, ?, 0, ?, ?)`).run(
        coinId,
        JSON.stringify(["coingecko", "geckoterminal", "dexscreener", "curve", "kava-swap"]),
        "A provider completed the direct-token query with no eligible pool",
        observedAtSec,
        observedAtSec,
      );
      sqlite.prepare(`INSERT INTO dex_discovery_meta
          (stablecoin_id, consecutive_misses, last_crawl_at, last_hit_at, deployment_fence_attribution_at)
        VALUES (?, 0, ?, NULL, ?)`).run(coinId, lastCrawlAtSec, lastCrawlAtSec);

      mocks.loadDexLiquiditySnapshot.mockResolvedValue({
        map: { [coinId]: {} },
        latestUpdatedAt: NOW_SEC - 60,
      });
      const asset = makeStablecoin({
        id: coinId,
        circulating: { peggedUSD: 100 },
        contracts: [{ chain: "kava", address: "usdx", decimals: 6 }],
        chainCirculating: { Kava: supplyPoint(100) },
      });
      const inputs = await loadReportCardsSnapshotInputs(db, {
        preloadedStablecoinsCache: { kind: "ok", payload: { peggedAssets: [asset] }, updatedAt: NOW_SEC },
      });

      expect(inputs.dexLiquiditySnapshot.map[coinId]).toMatchObject({
        deploymentSupplyCoverage: {
          totalSupplyUsd: 100,
          verifiedNoPoolsSupplyUsd: 0,
          verifiedNoPoolsSupplyRatio: 0,
          unknownSupplyUsd: 100,
          unknownSupplyRatio: 1,
          // The Osmosis IBC deployment carries no chain supply in this fixture.
          unknownChains: ["kava", "osmosis"],
        },
      });
    } finally {
      sqlite.close();
    }
  });
});
const scrvusdMeta = ACTIVE_META_BY_ID.get("scrvusd-curve")!;
// The rotating-sweep window grows with the reviewed deployment footprint, so the
// stale case sits one second past the window the production loader derives.
const scrvusdCensusMaxAgeSec = resolveDexDeploymentCensusMaxAgeSec([
  ...(scrvusdMeta.contracts ?? []),
  ...(scrvusdMeta.tradedContracts ?? []),
]);

const NOW_SEC = 1_700_000_000;

function db() {
  return mockD1([
    {
      match: "FROM dex_liquidity",
      rows: [],
    },
  ]);
}

function stablecoinsCache() {
  return {
    kind: "ok" as const,
    payload: { peggedAssets: [] },
    updatedAt: NOW_SEC,
  };
}

function liveReserves() {
  return Object.assign(new Map(), {
    provenanceById: new Map(),
  });
}

describe("report-card V9 publication input health", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1_000);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.getCache.mockReset().mockResolvedValue(null);
    mocks.loadDexLiquiditySnapshot.mockReset().mockResolvedValue({
      map: {},
      latestUpdatedAt: NOW_SEC - 60,
    });
    mocks.loadRedemptionBackstopSnapshot.mockReset().mockResolvedValue({
      map: {},
      latestUpdatedAt: NOW_SEC - 60,
      runId: "redemption:current",
      methodologyVersion: "redemption:test",
      reserveInputAssessment: { state: "fresh", quarantined: {} },
    });
    mocks.loadFreshIndependentLiveReserveMap
      .mockReset()
      .mockResolvedValue(liveReserves());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    // r2/data/results/scrvusd-curve.json adds six satellites: the rotating census sweep stays fresh past 48h.
    { id: "scrvusd-curve", ageSec: 48 * 60 * 60 + 1, observedSupplyRatio: 1, unknownChains: [] },
    { id: "scrvusd-curve", ageSec: scrvusdCensusMaxAgeSec + 1, observedSupplyRatio: 0, unknownChains: ["ethereum"] },
    { id: "usdc-circle", ageSec: 72 * 60 * 60, observedSupplyRatio: 1, unknownChains: [] },
  ])("ages deployment census independently of quotes ($id, $ageSec seconds)", async ({
    id, ageSec, observedSupplyRatio, unknownChains,
  }) => {
    const meta = ACTIVE_META_BY_ID.get(id)!;
    const deployments = [...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])];
    const ethereumDeployment = deployments.find((deployment) => deployment.chain === "ethereum")!;
    const asset = makeStablecoin({
      id,
      circulating: { peggedUSD: 100 },
      contracts: deployments,
      chainCirculating: Object.fromEntries(deployments.map((deployment) => {
        // Explicit observed zero closes each satellite without inventing a
        // positive supply allocation; the Ethereum liability reconciles to 100.
        const current = deployment.chain === "ethereum" ? 100 : 0;
        return [deployment.chain, {
          current, circulatingPrevDay: current, circulatingPrevWeek: current, circulatingPrevMonth: current,
        }];
      })),
    });
    mocks.loadDexLiquiditySnapshot.mockResolvedValue({
      map: { [asset.id]: {} },
      latestUpdatedAt: NOW_SEC - 4 * 60 * 60 - 1,
    });
    const inputs = await loadReportCardsSnapshotInputs(mockD1([{
      match: "FROM dex_liquidity",
      rows: [{
        stablecoin_id: asset.id,
        chain: "ethereum",
        contract_address: ethereumDeployment.address,
        outcome: "observed_pools",
        outcome_observed_at: NOW_SEC - ageSec,
        chain_tvl_json: JSON.stringify({ ethereum: 1_000 }),
      }],
    }]), {
      preloadedStablecoinsCache: {
        ...stablecoinsCache(),
        payload: { peggedAssets: [asset] },
      },
    });

    expect(inputs.dexLiquiditySnapshot.map[asset.id]).toMatchObject({
      deploymentSupplyCoverage: { observedSupplyRatio, unknownChains },
    });
    expect(inputs.liquidityStale).toBe(true);
    expect(inputs.v9PublicationInputHealth.dex.state).toBe("stale");
  });

  it("records a fulfilled but stale DEX scoring snapshot as stale", async () => {
    mocks.loadDexLiquiditySnapshot.mockResolvedValue({
      map: {},
      latestUpdatedAt: 1,
    });

    const inputs = await loadReportCardsSnapshotInputs(db(), {
      preloadedStablecoinsCache: stablecoinsCache(),
    });

    expect(inputs.v9PublicationInputHealth.dex).toEqual({
      state: "stale",
      generationId: "dex-liquidity-1",
      updatedAtSec: 1,
    });
  });

  it("records a rejected DEX scoring load as unavailable", async () => {
    mocks.loadDexLiquiditySnapshot.mockRejectedValue(
      new Error("DEX worker unavailable"),
    );

    const inputs = await loadReportCardsSnapshotInputs(db(), {
      preloadedStablecoinsCache: stablecoinsCache(),
    });

    expect(inputs.v9PublicationInputHealth.dex).toEqual({
      state: "unavailable",
      generationId: null,
      updatedAtSec: null,
    });
  });

  it("preserves applicable redemption and live-reserve loader failures", async () => {
    mocks.loadRedemptionBackstopSnapshot.mockRejectedValue(
      new RedemptionBackstopSnapshotUnavailableError(
        "redemption snapshot unavailable",
      ),
    );
    mocks.loadFreshIndependentLiveReserveMap.mockRejectedValue(
      new Error("live reserves unavailable"),
    );

    const inputs = await loadReportCardsSnapshotInputs(db(), {
      preloadedStablecoinsCache: stablecoinsCache(),
    });

    expect(inputs.v9PublicationInputHealth.redemption).toEqual({
      state: "unavailable",
      generationId: null,
      updatedAtSec: null,
    });
    expect(inputs.v9PublicationInputHealth.liveReserves).toEqual({
      state: "unavailable",
      coverageRatio: null,
    });
  });

  it("records zero coverage for a fulfilled empty independent reserve map", async () => {
    const inputs = await loadReportCardsSnapshotInputs(db(), {
      preloadedStablecoinsCache: stablecoinsCache(),
    });

    expect(inputs.v9PublicationInputHealth.liveReserves).toEqual({
      state: "available",
      coverageRatio: 0,
    });
  });

  it("holds a run whose consumed reserve binding is incompatible without changing the run clock", async () => {
    mocks.loadRedemptionBackstopSnapshot.mockResolvedValue({
      map: { test: { stablecoinId: "test" } }, latestUpdatedAt: NOW_SEC - 60,
      runId: "redemption:actual", methodologyVersion: "redemption:test", reserveInputAssessment: { state: "unavailable", quarantined: {} },
    });
    const inputs = await loadReportCardsSnapshotInputs(db(), { preloadedStablecoinsCache: stablecoinsCache() });
    expect(inputs.redemptionBackstopMap).toEqual({});
    expect(inputs.v9PublicationInputHealth.redemption).toEqual({ state: "unavailable", generationId: "redemption:actual", updatedAtSec: NOW_SEC - 60 });
    expect(inputs.inputFreshness.redemptionBackstops.ageSeconds).toBe(60);
  });

  it("keeps a run current when only individual assets carry inadmissible reserve evidence", async () => {
    const map = { test: { stablecoinId: "test" }, other: { stablecoinId: "other" } };
    mocks.loadRedemptionBackstopSnapshot.mockResolvedValue({
      map, latestUpdatedAt: NOW_SEC - 60, runId: "redemption:actual", methodologyVersion: "redemption:test",
      reserveInputAssessment: { state: "fresh", quarantined: { test: "freshness-unverified" } },
    });
    const inputs = await loadReportCardsSnapshotInputs(db(), { preloadedStablecoinsCache: stablecoinsCache() });
    expect(inputs.redemptionBackstopMap).toEqual(map);
    expect(inputs.v9PublicationInputHealth.redemption.state).toBe("current");
  });

  it("marks a completed empty redemption snapshot as not applicable", async () => {
    const inputs = await loadReportCardsSnapshotInputs(db(), {
      preloadedStablecoinsCache: stablecoinsCache(),
    });

    expect(inputs.v9PublicationInputHealth.redemption).toEqual({
      state: "not-applicable",
      generationId: "redemption:current",
      updatedAtSec: NOW_SEC - 60,
    });
  });
});

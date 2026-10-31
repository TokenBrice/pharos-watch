import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { resolveDexDeploymentCensusMaxAgeSec } from "../../cron/dex-liquidity/deployment-census-coverage";
import { classifyStoredDexCensusState } from "../../cron/dex-discovery/census-state-machine";
import { computeDexDeploymentSupplyCoverage } from "../report-cards-snapshot-inputs";

const mocks = vi.hoisted(() => ({
  loadDexLiquiditySnapshot: vi.fn(),
  loadRedemptionBackstopSnapshot: vi.fn(),
  loadFreshIndependentLiveReserveMap: vi.fn(),
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
});

import { describe, expect, it, vi } from "vitest";
import type { DdrActiveEventInput } from "@shared/lib/depeg-resolver";
import type { StablecoinMeta } from "@shared/types/core";
import { mockD1 } from "../../../test-helpers/__shared/mock-d1";
import { buildDewsStablecoinIdsDigest } from "../../../lib/dews-publication-pointer";
import * as activeSafetyScoreSource from "../../../lib/safety-score-active-source";
import {
  makeWorkerReportCardsV9Response,
  makeWorkerV9Card,
} from "../../../test-helpers/report-cards-v9";
import type { DdrEventDbRow } from "../types";
import { loadDdrContext, type DdrLoadedContext } from "../context";
import { deriveMintSurge, resolveDdrIncidents } from "../incident-resolution";
import {
  allocateDdrRunId,
  clearV9DependencyImpairment,
  hydrateV9DependencyImpairment,
  toStructural,
} from "../utils";

const NOW_SEC = 1_780_358_400;
const DAY = 86_400;

function publishedDewsConfigs(signalsJson = "{}") {
  const computedAt = NOW_SEC - 60;
  const row = {
    stablecoin_id: "usdc-circle",
    score: 66,
    band: "WARNING",
    signals_json: signalsJson,
    computed_at: computedAt,
  };
  return [
    {
      match: "FROM cache WHERE key = ?",
      matchBinds: ["dews:published-generation"],
      rows: [],
      first: {
        value: JSON.stringify({
          updatedAt: computedAt,
          source: "compute-dews",
          publishStatus: "published",
          coverageVersion: 2,
          expectedRowCount: 1,
          stablecoinIdsDigest: buildDewsStablecoinIdsDigest([row.stablecoin_id]),
        }),
        updated_at: computedAt,
      },
    },
    { match: "pharos:stress-signals:published-exact", rows: [row] },
  ];
}

function activeInput(overrides: Partial<DdrActiveEventInput> = {}): DdrActiveEventInput {
  return {
    id: 101,
    stablecoinId: "usdc-circle",
    symbol: "USDC",
    pegType: "peggedUSD",
    direction: "below",
    peakDeviationBps: -350,
    startedAt: NOW_SEC - DAY,
    pegReference: 1,
    currentDeviationBps: -250,
    ...overrides,
  };
}

function activeRow(overrides: Partial<DdrEventDbRow> = {}): DdrEventDbRow {
  const active = activeInput();
  return {
    id: active.id,
    stablecoin_id: active.stablecoinId,
    symbol: active.symbol,
    peg_type: active.pegType,
    direction: active.direction,
    peak_deviation_bps: active.peakDeviationBps,
    started_at: active.startedAt,
    ended_at: null,
    recovery_price: null,
    peg_reference: active.pegReference,
    source: "live",
    confirmation_sources: null,
    pending_reason: null,
    provenance_replay_run_id: null,
    provenance_replay_version: null,
    ...overrides,
  };
}

function supplyHistory(startedAt: number) {
  return [
    { date: startedAt - 30 * DAY, usd: 1_000_000_000 },
    { date: startedAt - 7 * DAY, usd: 1_000_000_000 },
    { date: startedAt, usd: 1_000_000_000 },
  ];
}

function loadedContext(overrides: Partial<DdrLoadedContext> = {}): DdrLoadedContext {
  const active = activeInput();
  return {
    active: [active],
    activeCoinIds: [active.stablecoinId],
    activeEventById: new Map(),
    incidents: [],
    quarantined: new Set(),
    supplyByCoin: new Map([[active.stablecoinId, supplyHistory(active.startedAt)]]),
    mintBurnHourlyByCoin: new Map(),
    dewsByCoin: new Map(),
    liqByCoin: new Map(),
    liqTvlChange7dByCoin: new Map(),
    liqTvlChange30dByCoin: new Map(),
    liqVolumeChange30dByCoin: new Map(),
    redemptionByCoin: new Map(),
    safetyByCoin: new Map(),
    v9ExitByCoin: new Map(),
    safetyContext: { status: "identity-missing", reason: "test", identity: null },
    lineage: {
      trainingWindow: { start: NOW_SEC - 365 * DAY, end: NOW_SEC },
      eventCount: 0,
      incidentCount: 0,
      coinCount: 0,
      quarantinedCoins: 0,
    },
    ...overrides,
  };
}

describe("deriveMintSurge", () => {
  const startedAt = NOW_SEC - DAY;
  const snapshots = [
    { date: startedAt - 7 * DAY, usd: 1_000_000 },
    { date: startedAt, usd: 1_000_000 },
  ];

  it("uses event-time hourly net issuance when mint-burn coverage exists", () => {
    expect(
      deriveMintSurge(
        snapshots,
        startedAt,
        0,
        [
          { hourTs: startedAt - 2 * DAY, netFlowUsd: 150_000 },
          { hourTs: startedAt - DAY, netFlowUsd: 60_001 },
          { hourTs: startedAt + 3600, netFlowUsd: 900_000 },
        ],
        true,
      ),
    ).toEqual({ mintSurge: true, mintSurgeCoverage: "mint-burn-hourly" });

    expect(
      deriveMintSurge(
        snapshots,
        startedAt,
        90,
        [{ hourTs: startedAt - DAY, netFlowUsd: 200_000 }],
        true,
      ),
    ).toEqual({ mintSurge: false, mintSurgeCoverage: "mint-burn-hourly" });
  });

  it("marks mint-burn coverage unavailable when event-time onset supply is invalid", () => {
    expect(
      deriveMintSurge(
        [
          { date: startedAt - 7 * DAY, usd: 0 },
          { date: startedAt, usd: 0 },
        ],
        startedAt,
        90,
        [{ hourTs: startedAt - DAY, netFlowUsd: 200_000 }],
        true,
      ),
    ).toEqual({ mintSurge: null, mintSurgeCoverage: "unavailable" });
  });

  it("marks the change-7d fallback explicitly when mint-burn coverage is absent", () => {
    expect(deriveMintSurge(snapshots, startedAt, 25, [], false)).toEqual({
      mintSurge: true,
      mintSurgeCoverage: "supply-history-proxy",
    });
    expect(deriveMintSurge(snapshots, startedAt, null, [], false)).toEqual({
      mintSurge: null,
      mintSurgeCoverage: "unavailable",
    });
  });
});

describe("toStructural", () => {
  it("projects the published V9 mint posture band and incident status", () => {
    // 9.1: the band is hydrated from the V9 publication, not recomputed from
    // curated metadata. An installed projection is authoritative, including
    // when it publishes no band for an asset.
    hydrateV9DependencyImpairment([
      {
        id: "fixture-k1",
        dependencies: { serial: [] },
        breakdowns: {
          control: { components: [{ kind: "mint", posture: "concentrated-admin" }] },
        },
      },
    ]);
    const structural = toStructural({
      id: "fixture-k1",
      symbol: "FK1",
      name: "Fixture K1",
      flags: {
        backing: "rwa-backed",
        pegCurrency: "USD",
        governance: "centralized",
        yieldBearing: false,
        rwa: false,
        navToken: false,
      },
      mintAuthority: {
        mintPath: "issuer-direct-mint",
        authorityPosture: "concentrated-admin",
        confidence: "verified",
        summary: "Single reviewed issuer mint controller.",
        mintIncidents: [
          {
            date: "2026-05-24",
            status: "active",
            summary: "Unbacked minting incident remains unresolved.",
            sources: [],
          },
        ],
        review: {
          evidence: "Reviewed against the mint controller.",
          reviewer: "Pharos",
          reviewedAt: "2026-05-25",
        },
      },
    } as StablecoinMeta);

    expect(structural.mintAuthorityScoreBand).toBe("concentrated");
    expect(structural.mintIncidents).toEqual([
      { date: "2026-05-24", status: "active", resolvedAt: null },
    ]);
    clearV9DependencyImpairment();
  });

  it("falls back to the curated posture band when no V9 projection is installed", () => {
    // The retired engine derived the band from curated metadata, so K1's band
    // leg was always evaluable. A held or unavailable V9 publication must not
    // silently drop it — that would fail *open* on a kill signal exactly when
    // the pipeline is degraded.
    clearV9DependencyImpairment();
    const meta = {
      id: "fixture-k1-held",
      symbol: "FK1H",
      name: "Fixture K1 Held",
      flags: {
        backing: "rwa-backed",
        pegCurrency: "USD",
        governance: "centralized",
        yieldBearing: false,
        rwa: false,
        navToken: false,
      },
      mintAuthority: {
        mintPath: "issuer-direct-mint",
        authorityPosture: "unbounded-or-compromised",
        confidence: "verified",
        summary: "Unbounded reviewed issuer mint controller.",
        review: {
          evidence: "Reviewed against the mint controller.",
          reviewer: "Pharos",
          reviewedAt: "2026-05-25",
        },
      },
    } as StablecoinMeta;

    expect(toStructural(meta).mintAuthorityScoreBand).toBe("exposed");

    // With a projection installed, a published "no band" stays authoritative.
    hydrateV9DependencyImpairment([
      { id: "fixture-k1-held", dependencies: { serial: [] } },
    ]);
    expect(toStructural(meta).mintAuthorityScoreBand).toBeNull();
    clearV9DependencyImpairment();
  });

  it("keeps a wrapper healthy when the V9 serial parent is tracked and non-terminal", () => {
    hydrateV9DependencyImpairment([
      {
        id: "wrapper-fixture",
        dependencies: { serial: [{ upstreamAssetId: "usdc-circle" }] },
      },
    ]);

    try {
      expect(
        toStructural({
          id: "wrapper-fixture",
          symbol: "WRAP",
          name: "Wrapper fixture",
          flags: {
            backing: "rwa-backed",
            pegCurrency: "USD",
            governance: "centralized",
            yieldBearing: false,
            rwa: false,
            navToken: false,
          },
        } as StablecoinMeta).dependencyImpaired,
      ).toBe(false);
    } finally {
      clearV9DependencyImpairment();
    }
  });
});

describe("allocateDdrRunId", () => {
  it("falls back to Math.random entropy when Web Crypto is unavailable", () => {
    vi.stubGlobal("crypto", undefined);
    try {
      expect(allocateDdrRunId("daily", NOW_SEC)).toMatch(/^ddr:daily:1780358400:[0-9a-f]{12}$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("loadDdrContext", () => {
  it("degrades when the stablecoins cache is stale", async () => {
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          {
            key: "stablecoins",
            value: JSON.stringify({
              peggedAssets: [
                {
                  id: "usdc-circle",
                  symbol: "USDC",
                  name: "USD Coin",
                  pegType: "peggedUSD",
                  price: 1,
                  circulating: { peggedUSD: 1_000_000_000 },
                },
              ],
            }),
            updated_at: NOW_SEC - 3 * 3600,
          },
        ],
      },
    ]);

    const result = await loadDdrContext(db, [activeRow()], NOW_SEC);

    expect(result).toEqual({ kind: "degraded", reason: "stablecoins-cache-stale", dataAsOf: NOW_SEC - 3 * 3600 });
  });

  it("hydrates live DDR inputs from DEWS signals, DEX TVL history, and Safety Score history", async () => {
    const row = activeRow();
    const card = makeWorkerV9Card({
      id: "usdc-circle",
      score: 90,
      grade: "A",
    });
    if (card.breakdowns == null) throw new Error("V9 fixture requires exit breakdowns");
    const snapshot = makeWorkerReportCardsV9Response({
      asOfSec: NOW_SEC - 120,
      updatedAt: NOW_SEC - 60,
      cards: [
        {
          ...card,
          pillars: {
            ...card.pillars,
            exit: {
              ...card.pillars.exit,
              reasons: [{ code: "correlated-exit-routes", message: "Routes share a common dependency.", path: "exit" }],
            },
          },
          breakdowns: {
            ...card.breakdowns,
            exit: {
              ...card.breakdowns.exit,
              primaryRoute: {
                ...card.breakdowns.exit.primaryRoute!,
                capacity: {
                  executableUsd: 500_000,
                  requestedNotionalUsd: 1_000_000,
                  completionRatio: 0.5,
                  maxCostBps: 200,
                  executionCostBps: 100,
                  settlementDelaySec: 60,
                  capacityScoringHorizon: "immediate",
                  chain: "ethereum",
                  protocol: "fixture",
                  poolId: "fixture-pool",
                  evidenceKind: "measured-executable-depth",
                  observedAtSec: NOW_SEC - 60,
                },
              },
            },
          },
        },
      ],
    });
    vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreSource")
      .mockResolvedValue({
        kind: "v9",
        expectedModel: "v9",
        snapshot,
      });
    const signalsJson = JSON.stringify({
      signals: {
        black: { value: 80, available: true },
        supply: { value: 10, available: true },
      },
    });
    const db = mockD1([
      ...publishedDewsConfigs(signalsJson),
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          {
            key: "stablecoins",
            value: JSON.stringify({
              peggedAssets: [
                {
                  id: "usdc-circle",
                  symbol: "USDC",
                  name: "USD Coin",
                  pegType: "peggedUSD",
                  price: 0.97,
                  circulating: { peggedUSD: 1_000_000_000 },
                },
              ],
            }),
            updated_at: NOW_SEC,
          },
        ],
      },
      { match: "FROM depeg_events WHERE ended_at IS NOT NULL", rows: [] },
      {
        match: "FROM supply_history",
        rows: supplyHistory(row.started_at).map((snapshot) => ({
          stablecoin_id: "usdc-circle",
          snapshot_date: snapshot.date,
          circulating_usd: snapshot.usd,
        })),
      },
      {
        match: "FROM mint_burn_hourly",
        rows: [{ stablecoin_id: "usdc-circle", hour_ts: row.started_at - DAY, net_flow_usd: 123_456 }],
      },
      {
        match: "FROM dex_liquidity_history",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            total_tvl_usd: 100,
            total_volume_24h_usd: 50,
            snapshot_date: NOW_SEC - 7 * DAY,
            coverage_class: "primary",
            coverage_confidence: 1,
          },
          {
            stablecoin_id: "usdc-circle",
            total_tvl_usd: 200,
            total_volume_24h_usd: 100,
            snapshot_date: NOW_SEC - 30 * DAY,
            coverage_class: "primary",
            coverage_confidence: 1,
          },
        ],
      },
      {
        match: "FROM dex_liquidity WHERE stablecoin_id",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            liquidity_score: 15,
            concentration_hhi: 0.8,
            total_tvl_usd: 40,
            total_volume_24h_usd: 20,
            updated_at: NOW_SEC - 60,
          },
        ],
      },
      {
        match: "FROM redemption_backstop_runs",
        rows: [
          {
            run_id: "run-live",
            completed_at: NOW_SEC - 30,
            expected_count: 1,
            written_count: 1,
            min_updated_at: NOW_SEC - 60,
            max_updated_at: NOW_SEC - 60,
            methodology_version: "4.07",
            metadata_json: null,
          },
        ],
      },
      {
        match: "FROM redemption_backstop_run_rows",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            immediate_capacity_ratio: 0.4,
            route_family: "offchain-issuer",
            updated_at: NOW_SEC - 60,
          },
        ],
      },
    ]);

    const result = await loadDdrContext(db, [row], NOW_SEC);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.context.dewsByCoin.get("usdc-circle")?.signals_json).toBe(signalsJson);
    expect(result.context.mintBurnHourlyByCoin.get("usdc-circle")).toEqual([
      { hourTs: row.started_at - DAY, netFlowUsd: 123_456 },
    ]);
    expect(result.context.liqByCoin.get("usdc-circle")?.total_tvl_usd).toBe(40);
    expect(result.context.liqTvlChange7dByCoin.get("usdc-circle")).toBeCloseTo(-60);
    expect(result.context.liqTvlChange30dByCoin.get("usdc-circle")).toBeCloseTo(-80);
    expect(result.context.liqVolumeChange30dByCoin.get("usdc-circle")).toBeCloseTo(-80);
    expect(result.context.redemptionByCoin.get("usdc-circle")).toMatchObject({
      immediate_capacity_ratio: 0.4,
      route_family: "offchain-issuer",
      updated_at: NOW_SEC - 60,
    });
    expect(result.context.safetyByCoin.get("usdc-circle")).toMatchObject({ grade: "A", score: 90 });
    expect(result.context.v9ExitByCoin.get("usdc-circle")).toMatchObject({
      pillarScore: card.pillars.exit.score,
      reasonCodes: ["correlated-exit-routes"],
      stressRequest: { requestedNotionalUsd: 1_000_000, maxCostBps: 200, comparisonWindowSec: 86_400 },
      primaryRoute: {
        key: "redemption:reviewed",
        score: card.breakdowns.exit.primaryRoute?.score,
        capacity: {
          executableUsd: 500_000,
          requestedNotionalUsd: 1_000_000,
          completionRatio: 0.5,
        },
      },
    });
    expect(result.context.safetyContext).toMatchObject({ status: "v9-identified", reason: null });
  });

  it("degrades rather than resolving from a partially staged DEWS generation", async () => {
    const computedAt = NOW_SEC - 60;
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["dews:published-generation"],
        rows: [],
        first: {
          value: JSON.stringify({
            updatedAt: computedAt,
            source: "compute-dews",
            publishStatus: "published",
            coverageVersion: 2,
            expectedRowCount: 2,
            stablecoinIdsDigest: buildDewsStablecoinIdsDigest(["usdc-circle", "usdt-tether"]),
          }),
          updated_at: computedAt,
        },
      },
      {
        match: "FROM cache WHERE key = ?",
        rows: [{
          key: "stablecoins",
          value: JSON.stringify({
            peggedAssets: [{
              id: "usdc-circle",
              symbol: "USDC",
              name: "USD Coin",
              pegType: "peggedUSD",
              price: 0.97,
              circulating: { peggedUSD: 1_000_000_000 },
            }],
          }),
          updated_at: NOW_SEC,
        }],
      },
      {
        match: "pharos:stress-signals:published-exact",
        rows: [{
          stablecoin_id: "usdc-circle",
          score: 66,
          band: "WARNING",
          signals_json: "{}",
          computed_at: computedAt,
        }],
      },
      { match: "FROM redemption_backstop_runs", rows: [] },
    ]);

    const result = await loadDdrContext(db, [activeRow()], NOW_SEC);

    expect(result).toMatchObject({
      kind: "degraded",
      reason: expect.stringContaining("published generation coverage mismatch: rows=1/2"),
    });
  });

  it("keeps a missing completed redemption run non-fatal with empty redemption context", async () => {
    const db = mockD1([
      ...publishedDewsConfigs(),
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          {
            key: "stablecoins",
            value: JSON.stringify({
              peggedAssets: [
                {
                  id: "usdc-circle",
                  symbol: "USDC",
                  name: "USD Coin",
                  pegType: "peggedUSD",
                  price: 0.97,
                  circulating: { peggedUSD: 1_000_000_000 },
                },
              ],
            }),
            updated_at: NOW_SEC,
          },
        ],
      },
      { match: "FROM redemption_backstop_runs", rows: [] },
    ]);

    const result = await loadDdrContext(db, [activeRow()], NOW_SEC);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.context.redemptionByCoin.size).toBe(0);
  });

  it("leaves V9 exit context null-degraded when the published V9 snapshot is held", async () => {
    const card = makeWorkerV9Card({ id: "usdc-circle" });
    const snapshot = makeWorkerReportCardsV9Response({
      updatedAt: NOW_SEC - 60,
      cards: [card],
      publicationHealth: {
        schemaVersion: 1,
        status: "held",
        acceptedPublicationGenerationId: "report-cards:v9:1",
        acceptedAtSec: NOW_SEC - 120,
        attemptedAtSec: NOW_SEC - 60,
        heldSinceSec: NOW_SEC - 60,
        reasons: [{ code: "dex-stale" }],
      },
    });
    vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreSource")
      .mockResolvedValue({ kind: "v9", expectedModel: "v9", snapshot });
    const db = mockD1([
      ...publishedDewsConfigs(),
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          {
            key: "stablecoins",
            value: JSON.stringify({
              peggedAssets: [
                {
                  id: "usdc-circle",
                  symbol: "USDC",
                  name: "USD Coin",
                  pegType: "peggedUSD",
                  price: 1,
                  circulating: { peggedUSD: 1_000_000_000 },
                },
              ],
            }),
            updated_at: NOW_SEC,
          },
        ],
      },
      { match: "FROM redemption_backstop_runs", rows: [] },
    ]);

    const result = await loadDdrContext(db, [activeRow()], NOW_SEC);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.context.safetyContext).toMatchObject({
      status: "cache-unavailable",
      reason: "v9-publication-held",
    });
    expect(result.context.v9ExitByCoin).toEqual(new Map());
  });

  it("degrades when the redemption live-signal read fails", async () => {
    const db = mockD1([
      ...publishedDewsConfigs(),
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          {
            key: "stablecoins",
            value: JSON.stringify({
              peggedAssets: [
                {
                  id: "usdc-circle",
                  symbol: "USDC",
                  name: "USD Coin",
                  pegType: "peggedUSD",
                  price: 0.97,
                  circulating: { peggedUSD: 1_000_000_000 },
                },
              ],
            }),
            updated_at: NOW_SEC,
          },
        ],
      },
      {
        match: "FROM redemption_backstop_runs",
        rows: [
          {
            run_id: "run-live",
            completed_at: NOW_SEC - 30,
            expected_count: 1,
            written_count: 1,
            min_updated_at: NOW_SEC - 60,
            max_updated_at: NOW_SEC - 60,
            methodology_version: "4.07",
            metadata_json: null,
          },
        ],
      },
      {
        match: "FROM redemption_backstop_run_rows",
        rows: [],
        throwError: new Error("run rows unavailable"),
      },
    ]);

    const result = await loadDdrContext(db, [activeRow()], NOW_SEC);

    expect(result).toMatchObject({
      kind: "degraded",
      reason: expect.stringContaining("redemption_backstop:"),
    });
  });

  it("degrades when the covered mint-burn read fails", async () => {
    const db = mockD1([
      ...publishedDewsConfigs(),
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          {
            key: "stablecoins",
            value: JSON.stringify({
              peggedAssets: [
                {
                  id: "usdc-circle",
                  symbol: "USDC",
                  name: "USD Coin",
                  pegType: "peggedUSD",
                  price: 0.97,
                  circulating: { peggedUSD: 1_000_000_000 },
                },
              ],
            }),
            updated_at: NOW_SEC,
          },
        ],
      },
      { match: "FROM mint_burn_hourly", rows: [], throwError: new Error("hourly rows unavailable") },
      { match: "FROM redemption_backstop_runs", rows: [] },
    ]);

    const result = await loadDdrContext(db, [activeRow()], NOW_SEC);

    expect(result).toMatchObject({
      kind: "degraded",
      reason: expect.stringContaining("mint_burn_hourly:hourly rows unavailable"),
    });
  });
});

describe("resolveDdrIncidents", () => {
  it("passes blacklist surge, TVL collapse, and Safety Score into Stage 1 factors", () => {
    const active = activeInput({ stablecoinId: "usda-avalon", symbol: "USDA" });
    const context = loadedContext({
      active: [active],
      activeCoinIds: [active.stablecoinId],
      supplyByCoin: new Map([[active.stablecoinId, supplyHistory(active.startedAt)]]),
      dewsByCoin: new Map([
        [
          active.stablecoinId,
          {
            stablecoin_id: active.stablecoinId,
            score: 66,
            band: "WARNING",
            signals_json: JSON.stringify({
              signals: {
                black: { value: 80, available: true },
                supply: { value: 10, available: true },
              },
            }),
            computed_at: NOW_SEC - 60,
          },
        ],
      ]),
      liqByCoin: new Map([
        [
          active.stablecoinId,
          {
            stablecoin_id: active.stablecoinId,
            liquidity_score: 15,
            concentration_hhi: 0.8,
            total_tvl_usd: 40,
            total_volume_24h_usd: 20,
            updated_at: NOW_SEC - 60,
          },
        ],
      ]),
      liqTvlChange7dByCoin: new Map([[active.stablecoinId, -60]]),
      liqTvlChange30dByCoin: new Map([[active.stablecoinId, -80]]),
      liqVolumeChange30dByCoin: new Map([[active.stablecoinId, -80]]),
      safetyByCoin: new Map([
        [active.stablecoinId, { stablecoin_id: active.stablecoinId, grade: "A", score: 90, recorded_at: NOW_SEC - DAY }],
      ]),
      safetyContext: { status: "v9-identified", reason: null, identity: null },
    });

    const [row] = resolveDdrIncidents(context, NOW_SEC);

    expect(row.resolution.factors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "K3_freeze_seizure", severity: "severe" }),
        expect.objectContaining({ code: "K5_exit_collapse", severity: "severe" }),
        expect.objectContaining({ code: "R5_proven_meanreversion", severity: "strong" }),
      ]),
    );
    expect(row.relatedContext).toMatchObject({ dewsScore: 66, liquidityScore: 15, safetyGrade: "A", safetyScore: 90 });
  });

  it("passes lock-time supply contraction and 30-day exit collapse into K6", () => {
    const active = activeInput();
    const context = loadedContext({
      supplyByCoin: new Map([
        [
          active.stablecoinId,
          [
            { date: NOW_SEC - 30 * DAY, usd: 100 },
            { date: active.startedAt - 7 * DAY, usd: 100 },
            { date: active.startedAt, usd: 100 },
            { date: NOW_SEC, usd: 50 },
          ],
        ],
      ]),
      liqByCoin: new Map([
        [
          active.stablecoinId,
          {
            stablecoin_id: active.stablecoinId,
            liquidity_score: 60,
            concentration_hhi: 0.2,
            total_tvl_usd: 40,
            total_volume_24h_usd: 20,
            updated_at: NOW_SEC - 60,
          },
        ],
      ]),
      liqTvlChange30dByCoin: new Map([[active.stablecoinId, -60]]),
    });

    const [row] = resolveDdrIncidents(context, NOW_SEC);

    expect(row.relatedContext.supplyChange7dPct).toBe(0);
    expect(row.relatedContext.supplyChange30dPct).toBe(-50);
    expect(row.resolution.factors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "K6_wind_down",
          severity: "elevated",
          label: expect.stringContaining("30-day DEX TVL fell 60%"),
        }),
      ]),
    );
  });

  it("passes fresh 24-hour DEX volume into the calm-catastrophic K6 fingerprint", () => {
    const active = activeInput({
      stablecoinId: "calm-catastrophic",
      symbol: "CALM",
      peakDeviationBps: -5_465,
    });
    const context = loadedContext({
      active: [active],
      activeCoinIds: [active.stablecoinId],
      supplyByCoin: new Map([[active.stablecoinId, supplyHistory(active.startedAt)]]),
      liqByCoin: new Map([
        [
          active.stablecoinId,
          {
            stablecoin_id: active.stablecoinId,
            liquidity_score: 60,
            concentration_hhi: 0.2,
            total_tvl_usd: 1_500_000,
            total_volume_24h_usd: 89,
            updated_at: NOW_SEC - 60,
          },
        ],
      ]),
    });

    const [row] = resolveDdrIncidents(context, NOW_SEC);

    expect(row.resolution.factors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "K6_wind_down",
          severity: "elevated",
          label: expect.stringContaining("only $89 DEX volume / 24h"),
        }),
      ]),
    );
  });

  it("passes the DEWS supply signal as a bank-run K5 input", () => {
    const context = loadedContext({
      dewsByCoin: new Map([
        [
          "usdc-circle",
          {
            stablecoin_id: "usdc-circle",
            score: 40,
            band: "ALERT",
            signals_json: JSON.stringify({ supply: { value: 65, available: true } }),
            computed_at: NOW_SEC - 60,
          },
        ],
      ]),
      liqByCoin: new Map([
        [
          "usdc-circle",
          {
            stablecoin_id: "usdc-circle",
            liquidity_score: 80,
            concentration_hhi: 0.2,
            total_tvl_usd: 100,
            total_volume_24h_usd: 50,
            updated_at: NOW_SEC - 60,
          },
        ],
      ]),
    });

    const [row] = resolveDdrIncidents(context, NOW_SEC);
    const k5 = row.resolution.factors.find((factor) => factor.code === "K5_exit_collapse");

    expect(k5).toMatchObject({
      severity: "elevated",
      label: "Sustained one-sided outflow (bank-run signal)",
    });
  });

  it("ignores malformed fresh DEWS signals without fabricating a K5 input", () => {
    const context = loadedContext({
      dewsByCoin: new Map([
        [
          "usdc-circle",
          {
            stablecoin_id: "usdc-circle",
            score: 40,
            band: "ALERT",
            signals_json: "{bad json",
            computed_at: NOW_SEC - 60,
          },
        ],
      ]),
      liqByCoin: new Map([
        [
          "usdc-circle",
          {
            stablecoin_id: "usdc-circle",
            liquidity_score: 80,
            concentration_hhi: 0.2,
            total_tvl_usd: 100,
            total_volume_24h_usd: 50,
            updated_at: NOW_SEC - 60,
          },
        ],
      ]),
    });

    const [row] = resolveDdrIncidents(context, NOW_SEC);

    expect(row.relatedContext.dewsScore).toBe(40);
    expect(row.resolution.factors.some((factor) => factor.code === "K5_exit_collapse")).toBe(false);
  });

  it("omits stale live context while preserving sparse supply coverage", () => {
    const context = loadedContext({
      supplyByCoin: new Map([["usdc-circle", [{ date: NOW_SEC - DAY, usd: 1_000_000 }]]]),
      dewsByCoin: new Map([
        [
          "usdc-circle",
          {
            stablecoin_id: "usdc-circle",
            score: 80,
            band: "DANGER",
            signals_json: "{bad json",
            computed_at: NOW_SEC - 3 * 3600,
          },
        ],
      ]),
      liqByCoin: new Map([
        [
          "usdc-circle",
          {
            stablecoin_id: "usdc-circle",
            liquidity_score: 10,
            concentration_hhi: 0.9,
            total_tvl_usd: 10,
            total_volume_24h_usd: 5,
            updated_at: NOW_SEC - 3 * 3600,
          },
        ],
      ]),
      redemptionByCoin: new Map([
        [
          "usdc-circle",
          {
            stablecoin_id: "usdc-circle",
            immediate_capacity_ratio: 0.5,
            route_family: "native",
            updated_at: NOW_SEC - 8 * DAY,
          },
        ],
      ]),
    });

    const [row] = resolveDdrIncidents(context, NOW_SEC);

    expect(row.relatedContext).toMatchObject({
      dewsScore: null,
      liquidityScore: null,
      supplyChange7dPct: null,
      supplyChange30dPct: null,
      mintSurge: null,
    });
  });
});

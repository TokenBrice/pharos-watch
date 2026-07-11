import { describe, expect, it } from "vitest";
import type { DdrActiveEventInput } from "@shared/lib/depeg-resolver";
import { mockD1 } from "../../../test-helpers/__shared/mock-d1";
import { buildDewsStablecoinIdsDigest } from "../../../lib/dews-publication-pointer";
import type { DdrEventDbRow } from "../types";
import { loadDdrContext, type DdrLoadedContext } from "../context";
import { resolveDdrIncidents } from "../incident-resolution";

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
    dewsByCoin: new Map(),
    liqByCoin: new Map(),
    liqTvlChange7dByCoin: new Map(),
    redemptionByCoin: new Map(),
    safetyByCoin: new Map(),
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
        match: "FROM dex_liquidity_history",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            total_tvl_usd: 100,
            snapshot_date: NOW_SEC - 7 * DAY,
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
      {
        match: "FROM safety_grade_history h",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            grade: "A",
            score: 90,
            recorded_at: NOW_SEC - DAY,
          },
        ],
      },
    ]);

    const result = await loadDdrContext(db, [row], NOW_SEC);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.context.dewsByCoin.get("usdc-circle")?.signals_json).toBe(signalsJson);
    expect(result.context.liqByCoin.get("usdc-circle")?.total_tvl_usd).toBe(40);
    expect(result.context.liqTvlChange7dByCoin.get("usdc-circle")).toBeCloseTo(-60);
    expect(result.context.redemptionByCoin.get("usdc-circle")).toMatchObject({
      immediate_capacity_ratio: 0.4,
      route_family: "offchain-issuer",
      updated_at: NOW_SEC - 60,
    });
    expect(result.context.safetyByCoin.get("usdc-circle")).toMatchObject({ grade: "A", score: 90 });
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
            updated_at: NOW_SEC - 60,
          },
        ],
      ]),
      liqTvlChange7dByCoin: new Map([[active.stablecoinId, -60]]),
      safetyByCoin: new Map([
        [active.stablecoinId, { stablecoin_id: active.stablecoinId, grade: "A", score: 90, recorded_at: NOW_SEC - DAY }],
      ]),
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

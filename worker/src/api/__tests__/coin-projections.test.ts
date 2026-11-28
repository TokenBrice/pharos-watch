import type { DexExitRouteObservation } from "@shared/types/exit-route";
import { afterEach, describe, onTestFinished, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { makeYieldRanking, makeAltYieldSource } from "@shared/test-utils/yield-ranking-fixtures";
import { DexLiquidityCoinResponseSchema, DexLiquidityMapSchema, DexLiquidityTableMapSchema, DexLiquidityTableRowSchema } from "@shared/types/dex-liquidity";
import { RedemptionBackstopCoinResponseSchema, RedemptionBackstopsResponseSchema } from "@shared/types/redemption";
import { YieldRankingsCoinResponseSchema, YieldRankingsResponseSchema } from "@shared/types/yield";
import { makeDexLiquidityRow } from "../../test-helpers/__shared/fixtures";
import { dexRouteObservation } from "../../lib/__tests__/safety-score-v9-extension-routes.test-support";
import { makeDexRouteObservationCoverage } from "../../cron/__tests__/dex-liquidity-persistence.test-support";
import { makeRedemptionRow, completedRun } from "./redemption-backstops.test-support";
import { handleDexLiquidity, handleDexLiquidityCoin, handleDexLiquidityTable } from "../dex-liquidity";
import { handleRedemptionBackstops, handleRedemptionBackstopCoin } from "../redemption-backstops";
import { handleYieldRankings, handleYieldRankingsCoin } from "../yield-rankings-cache";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { FRESHNESS_RATIOS } from "@shared/lib/status-thresholds";
import { conditionalGetResponse, scopeResponseEtag } from "../../lib/api-response";

vi.mock("../../lib/safety-score-index", () => ({
  loadActiveSafetyScoreIndex: vi.fn(async () => ({ kind: "error", reason: "safety-score-index-unavailable", snapshot: null })),
}));

function insert(sqlite: DatabaseSync, table: string, row: Record<string, unknown>) {
  const entries = Object.entries(row);
  const values = entries.map(([, value]) => {
    if (value === null || typeof value === "number" || typeof value === "string") return value;
    throw new Error("Unexpected fixture SQL value");
  });
  sqlite.prepare(`INSERT INTO ${table} (${entries.map(([key]) => key).join(",")}) VALUES (${entries.map(() => "?").join(",")})`).run(...values);
}

const now = 1_790_000_000;
const staleAge = Math.max(API_FRESHNESS_MAX_AGE_SEC.dexLiquidity, API_FRESHNESS_MAX_AGE_SEC.redemptionBackstops) * FRESHNESS_RATIOS.FRESH + 1;
const freezeClock = () => vi.spyOn(Date, "now").mockReturnValue(now * 1000);
const coinUrl = (path: string, id: string) => new URL(`https://site-api.pharos.watch/api/${path}?stablecoin=${id}`);
const dexCoin = (db: D1Database, id = "usdt-tether") => handleDexLiquidityCoin(db, coinUrl("dex-liquidity-coin", id));
const redemptionCoin = (db: D1Database, id = "cusd-cap") => handleRedemptionBackstopCoin(db, coinUrl("redemption-backstop-coin", id));
const yieldCoin = (db: D1Database) => handleYieldRankingsCoin(db, coinUrl("yield-rankings-coin", "usdc-circle"));

function expectFreshHeaders(response: Response) {
  expect(response.headers.get("X-Data-Updated-At")).toBe(String(now));
  expect(response.headers.get("X-Data-Age")).toBe("0");
  expect(response.headers.get("Warning")).toBeNull();
  expect(response.headers.get("Cache-Control")).not.toBe("no-store");
}

function openDatabase(options?: Parameters<typeof createLatestSchemaSqlite>[0]) {
  const fixture = createLatestSchemaSqlite(options);
  onTestFinished(() => fixture.sqlite.close());
  return fixture;
}

function seedDexPair(sqlite: DatabaseSync, selectedAt: number, otherAt: number, selected: Parameters<typeof makeDexLiquidityRow>[0] = {}, generationId?: string | null) {
  const generation = generationId === undefined ? {} : { publication_generation_id: generationId };
  for (const [symbol, stablecoin_id, updated_at, extra] of [
    ["USDT", "usdt-tether", selectedAt, selected], ["USDC", "usdc-circle", otherAt, {}],
  ] as const) {
    insert(sqlite, "dex_liquidity", { symbol, ...makeDexLiquidityRow({ stablecoin_id, updated_at, ...extra }), ...generation });
  }
}

async function redemptionProjection(db: D1Database, sqlite: DatabaseSync, run: ReturnType<typeof completedRun>, rows: Record<string, unknown>[]) {
  insert(sqlite, "redemption_backstop_runs", { ...run, started_at: run.min_updated_at, status: "completed" });
  for (const row of rows) insert(sqlite, "redemption_backstop_run_rows", makeRedemptionRow({ snapshot_run_id: run.run_id, ...row }));
  const full = await handleRedemptionBackstops(db);
  const projected = await redemptionCoin(db);
  const fullBody = RedemptionBackstopsResponseSchema.parse(await full.json());
  const body = RedemptionBackstopCoinResponseSchema.parse(await projected.json());
  return { full, fullBody, projected, body };
}

function seedYield(sqlite: DatabaseSync, updatedAt: number, publicationAt: number, body: Record<string, unknown>) {
  insert(sqlite, "cache", { key: "yield-rankings", updated_at: updatedAt, value: JSON.stringify({
    riskFreeRate: 4, scalingFactor: 1, medianApy: null, ...body, updatedAt: publicationAt,
    publication: { generationId: "yield-projection-run", updatedAt: publicationAt, cutoffAt: publicationAt, schemaVersion: 1, status: "published" },
  }) });
}

afterEach(() => vi.restoreAllMocks());

describe("site-only coin projections", () => {
  it.each([false, true])("matches DEX full-row values, nulls and warnings with invalid coverage=%s", async (invalidCoverage) => {
    freezeClock();
    const { sqlite, db } = openDatabase();
    seedDexPair(sqlite, now - 100_000, now - 100_000, invalidCoverage ? { coverage_confidence: 2 } : {});
    const full = await handleDexLiquidity(db);
    const fullBody = DexLiquidityMapSchema.parse(await full.json());
    const projected = await dexCoin(db);
    const body = DexLiquidityCoinResponseSchema.parse(await projected.json());
    expect(Object.keys(body.coins)).toEqual(["usdt-tether"]);
    expect(body.coins["usdt-tether"]).toEqual(fullBody["usdt-tether"]);
    expect(body.projection).toMatchObject({ totalCount: 2, updatedAt: now - 100_000,
      unavailableReason: invalidCoverage ? "invalid-coverage-evidence" : null });
    expect(projected.headers.get("X-Data-Updated-At")).toBe(full.headers.get("X-Data-Updated-At"));
    expect(projected.headers.get("Warning")).toBe(full.headers.get("Warning"));
    const table = DexLiquidityTableMapSchema.parse(await (await handleDexLiquidityTable(db)).json());
    for (const [id, row] of Object.entries(fullBody)) expect(table[id]).toEqual(DexLiquidityTableRowSchema.parse(row));
    expect(table["usdt-tether"]).not.toHaveProperty("topPools");
    const missing = DexLiquidityCoinResponseSchema.parse(await (await dexCoin(db, "dai-makerdao")).json());
    expect(missing.coins).toEqual({});
    expect(missing.projection).toMatchObject({ unavailableReason: "row-not-published", generationId: null, updatedAt: null, totalCount: 2 });
  });

  it("projects only a comparable same-pool weekly sell observation on the detail endpoint", async () => {
    const id = "trusd-tori";
    const pool = "ethereum:0xd1d954bc94c843815ec7b8119f2de00af27fa6ff";
    const output = "ethereum:0xcacd6fd266af91b8aed52accc382b4e165586e29";
    const route = dexRouteObservation(1_795_857_263, {
      routeId: `dex:${id}:dl:${encodeURIComponent(pool)}:${encodeURIComponent(output)}`,
      scope: { kind: "chain-contract", chain: "ethereum", contractOrPoolId: pool, protocol: "curve" },
      output: { kind: "tracked-stablecoin", trackedAssetIds: ["frxusd-frax"], assetKeys: [output] },
      executableUsd: 3_231.89, completionRatio: 0.003232, freshnessSeconds: 110,
    });
    const coverage = { ...makeDexRouteObservationCoverage(), capabilityMatrixVersion: "p4a.10" };
    const prior = { ...route, executableUsd: 186_813.88, completionRatio: 0.186814, observedAt: 1_795_266_731 };
    const { db, sqlite } = openDatabase();
    const day = 1_795_219_200;
    let current = route;
    let updatedAt = 1_795_857_035;
    let clock = route.observedAt + route.freshnessSeconds;
    vi.spyOn(Date, "now").mockImplementation(() => clock * 1000);
    const read = async (observation: DexExitRouteObservation, version = "7.53", assetId = id) => {
      sqlite.exec("DELETE FROM dex_liquidity; DELETE FROM dex_liquidity_history");
      insert(sqlite, "dex_liquidity", { symbol: "trUSD", ...makeDexLiquidityRow({ stablecoin_id: assetId,
        updated_at: updatedAt, methodology_version: "7.56", score_components_json: JSON.stringify({
          exitRouteObservations: [current], exitRouteObservationCoverage: coverage,
        }) }) });
      insert(sqlite, "dex_liquidity_history", { stablecoin_id: assetId, total_tvl_usd: 5_922_372,
        snapshot_date: day, coverage_class: "mixed", coverage_confidence: 0.74, methodology_version: version,
        exit_route_summary_json: JSON.stringify({ observations: [observation], coverage }) });
      const body = DexLiquidityCoinResponseSchema.parse(await (await dexCoin(db, assetId)).json());
      return body.coins[assetId].weeklyExitRouteBaselines;
    };
    for (const observation of [prior, { ...prior, executableUsd: 0, completionRatio: 0 }]) {
      const { routeId, observedAt, executableUsd } = observation;
      expect(await read(observation)).toEqual([{ routeId, observedAt, executableUsd }]);
    }
    for (const patch of [
      { requestedNotionalUsd: 100_000 }, { maxCostBps: 100 }, { settlementHorizonSec: 3600 },
      { observedAt: prior.observedAt - 86_400 }, { freshnessSeconds: 10_801 }, { reserveModelId: "different" },
      { output: { ...prior.output, assetKeys: ["different"] } },
    ]) expect(await read({ ...prior, ...patch })).toBeUndefined();
    expect(await read(prior, "7.52")).toBeUndefined();

    const currentDay = day + 7 * 86_400;
    clock = currentDay + 120;
    updatedAt = currentDay + 30;
    current = { ...route, observedAt: currentDay - 30, freshnessSeconds: 90 };
    const previous = { ...prior, observedAt: day - 30, freshnessSeconds: 90 };
    expect(await read(previous)).toHaveLength(1);
    expect(await read({ ...previous, freshnessSeconds: 10 })).toBeUndefined();
    expect(await read({ ...previous, observedAt: day + 86_400 })).toBeUndefined();
    clock = currentDay + 40;
    expect(await read(previous)).toBeUndefined();
    clock = currentDay + 120;
    current = { ...current, freshnessBasisAt: currentDay - 120, freshnessSeconds: 180 };
    expect(await read(previous)).toHaveLength(1);
    expect(await read({ ...previous, freshnessBasisAt: day - 10 })).toBeUndefined();

    for (const [input, outputId, expected] of [
      [id, "strusd-tori", undefined], ["strusd-tori", id, 1],
    ] as const) {
      const identity = { routeId: `dex:${input}:${outputId}`, output: { ...route.output,
        trackedAssetIds: [outputId], assetKeys: [`ethereum:${outputId}`] } };
      current = { ...current, ...identity };
      expect((await read({ ...previous, ...identity }, "7.53", input))?.length).toBe(expected);
    }
  });

  it.each([false, true])("binds DEX row, census and producer clock across publication rollover (legacy=%s)", async (legacy) => {
    freezeClock();
    let switched = false;
    const { sqlite, db } = openDatabase({ onAll: (sql) => {
      if (switched || !sql.includes("projection_total_count")) return;
      switched = true;
      sqlite.prepare("UPDATE dex_liquidity SET updated_at = ?, publication_generation_id = ?").run(now, legacy ? null : "G2");
    } });
    for (const generation of ["G1", "G2"]) {
      insert(sqlite, "dex_liquidity_publication_generations", { generation_id: generation, started_at: now, state: "published", expected_row_count: 2, created_at: now });
    }
    seedDexPair(sqlite, now - staleAge, now, {}, legacy ? null : "G1");
    const response = await dexCoin(db);
    const body = DexLiquidityCoinResponseSchema.parse(await response.json());
    expect(switched).toBe(true);
    expect(body.projection).toMatchObject({ generationId: legacy ? null : "G1", updatedAt: now - staleAge, totalCount: 2 });
    expect(body.coins["usdt-tether"].updatedAt).toBe(now - staleAge);
    expect(response.headers.get("X-Data-Updated-At")).toBe(String(now - staleAge));
    expect(response.headers.get("X-Data-Age")).toBe(String(staleAge));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each([false, true])("uses the DEX publication clock without hiding ancient row evidence (table=%s)", async (table) => {
    const clock = freezeClock();
    const ancientUpdatedAt = now - 174 * 86_400;
    const { sqlite, db } = openDatabase();
    seedDexPair(sqlite, ancientUpdatedAt, now);
    const path = table ? "dex-liquidity-table" : "dex-liquidity";
    const response = await (table ? handleDexLiquidityTable(db) : handleDexLiquidity(db));
    const body = (table ? DexLiquidityTableMapSchema : DexLiquidityMapSchema).parse(await response.clone().json());
    expect(body["usdt-tether"].updatedAt).toBe(ancientUpdatedAt);
    expect(body["usdt-tether"].warning).toContain("110");
    expect(body["usdc-circle"].updatedAt).toBe(now);
    expect(body["usdc-circle"].warning).toBeNull();
    expectFreshHeaders(response);

    const cached = scopeResponseEtag(response, path, true);
    const etag = cached.headers.get("ETag");
    expect(etag).toBeTruthy();
    const request = new Request(`https://site-api.pharos.watch/api/${path}`, {
      headers: { "If-None-Match": etag! },
    });
    const notModified = conditionalGetResponse(request, cached.clone());
    expect(notModified.status).toBe(304);
    for (const name of ["ETag", "Date", "Cache-Control", "X-Data-Updated-At", "X-Data-Freshness-Budget"]) {
      expect(notModified.headers.get(name)).toBe(cached.headers.get(name));
    }
    clock.mockReturnValue((now + 86_400) * 1000);
    expect(conditionalGetResponse(request, cached).status).toBe(200);

    clock.mockReturnValue(now * 1000);
    const coinResponse = scopeResponseEtag(
      await dexCoin(db),
      "dex-liquidity-coin?stablecoin=usdt-tether", true,
    );
    const coin = DexLiquidityCoinResponseSchema.parse(await coinResponse.clone().json());
    expect(coin.coins["usdt-tether"].updatedAt).toBe(ancientUpdatedAt);
    expect(coin.projection.updatedAt).toBe(ancientUpdatedAt);
    expect(coinResponse.headers.get("X-Data-Updated-At")).toBe(String(ancientUpdatedAt));
    expect(coinResponse.headers.get("Warning")).toContain("110");
    expect(coinResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(coinResponse.headers.get("ETag")).toBeNull();
    expect(conditionalGetResponse(request, coinResponse).status).toBe(200);
  });

  it("retains the admitted redemption generation clock and the selected row's own evidence clock", async () => {
    freezeClock();
    const { sqlite, db } = openDatabase();
    const run = completedRun("unequal-clocks", { expected_count: 2, written_count: 2, min_updated_at: now - staleAge, max_updated_at: now });
    const { full, fullBody, projected, body } = await redemptionProjection(db, sqlite, run, [
      { updated_at: now - staleAge }, { stablecoin_id: "usdc-circle", updated_at: now },
    ]);
    expect(fullBody.updatedAt).toBe(now);
    expect(fullBody.coins["cusd-cap"].updatedAt).toBe(now - staleAge);
    expectFreshHeaders(full);
    expect(body.projection).toMatchObject({ generationId: run.run_id, totalCount: 2, updatedAt: now - staleAge });
    // Whole-run admission makes HTTP freshness follow the immutable manifest,
    // while projection/row evidence keeps its original per-coin timestamp.
    expect(body.updatedAt).toBe(now);
    expect(body.coins["cusd-cap"].updatedAt).toBe(now - staleAge);
    expectFreshHeaders(projected);
    expect(projected.headers.get("Cache-Control")).toBe(full.headers.get("Cache-Control"));
  });

  it.each([null, 0, 10_000_000])("matches completed redemption row including nullable capacity %s", async (capacity) => {
    freezeClock();
    const { sqlite, db } = openDatabase();
    const run = completedRun("projection-run");
    const { full, fullBody, projected, body } = await redemptionProjection(db, sqlite, run, [{ immediate_capacity_usd: capacity }]);
    expect(body.coins["cusd-cap"]).toEqual(fullBody.coins["cusd-cap"]);
    expect(body.methodology).toEqual(fullBody.methodology);
    expect(body.projection).toMatchObject({ generationId: run.run_id, totalCount: 1, updatedAt: fullBody.updatedAt });
    expect(projected.headers.get("Warning")).toBe(full.headers.get("Warning"));
    const missingResponse = await redemptionCoin(db, "usdc-circle");
    expect(missingResponse.status).toBe(200);
    const missing = RedemptionBackstopCoinResponseSchema.parse(await missingResponse.json());
    expect(missing.projection).toMatchObject({ generationId: run.run_id, updatedAt: null, totalCount: 1, unavailableReason: "row-not-published" });
  });

  it.each([0, 100_000])("matches hydrated yield row and cohort warning/coverage at age %s", async (age) => {
    freezeClock();
    const { sqlite, db } = openDatabase();
    const updatedAt = now - age;
    seedYield(sqlite, updatedAt, updatedAt, {
      rankings: [makeYieldRanking({ altSources: [makeAltYieldSource()] }),
        makeYieldRanking({ id: "usdt-tether", safetyScore: null, safetyGrade: null, pharosYieldScore: null, altSources: [makeAltYieldSource()] })],
      warnings: [{ code: "test-input-warning", message: "Retained producer warning" }],
    });
    const full = await handleYieldRankings(db);
    const fullBody = YieldRankingsResponseSchema.parse(await full.json());
    const projected = await yieldCoin(db);
    const body = YieldRankingsCoinResponseSchema.parse(await projected.json());
    expect(body.rankings).toEqual(fullBody.rankings.filter((row) => row.id === "usdc-circle"));
    for (const field of ["warnings", "provenance", "publication"] as const) expect(body[field]).toEqual(fullBody[field]);
    expect(body.projection.totalCount).toBe(2);
    expect(projected.headers.get("Warning")).toBe(full.headers.get("Warning"));
  });

  it("rejects a yield envelope whose producer clock does not match its selected publication", async () => {
    freezeClock();
    const { sqlite, db } = openDatabase();
    seedYield(sqlite, now, now - 1, { rankings: [makeYieldRanking()] });
    const response = await yieldCoin(db);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ reason: "yield-rankings-malformed" });
  });

  it("rejects missing and duplicate coin parameters before reading storage", async () => {
    const { db } = openDatabase();
    for (const handler of [handleDexLiquidityCoin, handleRedemptionBackstopCoin, handleYieldRankingsCoin]) {
      for (const query of ["", "?stablecoin=usdc-circle&stablecoin=usdt-tether"]) {
        expect((await handler(db, new URL(`https://site-api.pharos.watch/api/projection${query}`))).status).toBe(400);
      }
    }
  });
});

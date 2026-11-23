import { describe, expect, it, vi } from "vitest";
import { mockD1 as createMockD1, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { persistDewsResults } from "../dews/persistence";
import { computeDEWS } from "../dews";
import { makeDewsInput } from "./dews.test-support";
import { loadPreviousStressSignalCurrentRows as loadPrev, loadStressSignalCurrentRowForCoin as loadCoin, loadStressSignalCurrentRows as loadAll, loadPublishedStressSignalGeneration as loadGen, loadTelegramDewsCurrentRows as loadTg, mergeNewestStressSignalRows as mergeRows, type StressSignalCurrentRow } from "../stress-signals-current-rows";
import { buildDewsStablecoinIdsDigest as idsDigest } from "../dews-publication-pointer";
import { loadDewsSourceState } from "../dews/source-state";
import { computeAndStoreDEWS } from "../dews/service";

const nowSec = 1_778_400_000, at = nowSec - 60, STALE = { staleAfterSec: 300 };
const sigJson = JSON.stringify({ supply: { value: 10, available: true } });
const ptr = (updatedAt: number, ids?: readonly string[], ov: Record<string, unknown> = {}) => ({
  key: "dews:published-generation", updated_at: updatedAt,
  value: JSON.stringify({ updatedAt, source: "compute-dews", publishStatus: "published", ...(ids === undefined ? {} : { coverageVersion: 2, expectedRowCount: ids.length, stablecoinIdsDigest: idsDigest(ids) }), ...ov }),
});
const row = (id: string, computed_at: number, score = 10): StressSignalCurrentRow & Record<string, unknown> => ({ stablecoin_id: id, score, band: "CALM", signals_json: sigJson, computed_at });
const one = (computed_at: number, score = 25, band = "WATCH") => ({ score, band, signals_json: sigJson, computed_at });
const mockD1 = (tables: MockTableConfig[]) => createMockD1(tables, { assertMatchesUsed: true });
const ptrTbl = (p: Record<string, unknown> | null, ex: Partial<MockTableConfig> = {}): MockTableConfig => ({ match: "FROM cache WHERE key = ?", matchBinds: ["dews:published-generation"], rows: p ? [p] : [], ...(p ? { first: p } : {}), ...ex });
const qTbl = (tag: string, rows: Record<string, unknown>[], ex: Partial<MockTableConfig> = {}): MockTableConfig => ({ match: `pharos:${tag}`, rows, ...ex });

describe("stress-signal current-row helpers", () => {
  it("withholds rejected first-run diagnostic rows from every current reader until acceptance", async () => {
    const { sqlite, db } = createLatestSchemaSqlite(), scored = computeDEWS(makeDewsInput())!;
    const persist = (clock: number, degradedSources: string[]) => persistDewsResults({ db, results: [{ ...scored, stablecoinId: "usdt-tether", score: 70 }], eligibleIds: new Set(["usdt-tether"]), degradedSources, nowSec: clock });
    try {
      await persist(at - 60, ["yield-rankings-freshness"]);
      expect(sqlite.prepare("SELECT score FROM stress_signals_latest WHERE stablecoin_id = ?").get("usdt-tether")).toEqual({ score: 70 });
      expect(sqlite.prepare("SELECT score FROM stress_signals WHERE stablecoin_id = ?").get("usdt-tether")).toEqual({ score: 70 });
      expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get("dews:published-generation")).toBeUndefined();
      expect((await loadAll(db, nowSec, STALE)).results).toEqual([]);
      expect(await loadCoin(db, "usdt-tether", nowSec, STALE)).toBeNull();
      expect(await loadTg(db, nowSec, STALE)).toEqual([]);
      expect(await loadPrev(db, nowSec, STALE)).toEqual([]);
      await persist(at, []);
      const expRow = expect.objectContaining({ stablecoin_id: "usdt-tether", score: 70, computed_at: at });
      expect((await loadAll(db, nowSec, STALE)).results).toEqual([expRow]);
      expect(await loadCoin(db, "usdt-tether", nowSec, STALE)).toMatchObject({ score: 70, computed_at: at });
      expect(await loadTg(db, nowSec, STALE)).toEqual([expRow]);
      expect(await loadPrev(db, nowSec, STALE)).toEqual([expect.objectContaining({ stablecoin_id: "usdt-tether", computed_at: at })]);
    } finally { sqlite.close(); }
  });

  it("merges latest rows over legacy rows while preserving legacy-only rows", () => {
    expect(mergeRows([row("usdt-tether", nowSec - 120, 12), row("usdc-circle", at, 30)], [row("usdt-tether", nowSec - 30, 15)])).toEqual([row("usdt-tether", nowSec - 30, 15), row("usdc-circle", at, 30)]);
  });

  it("loads one exact canonical generation from the publication pointer", async () => {
    const rows = [row("usdt-tether", at), row("usdc-circle", at)];
    const db = mockD1([ptrTbl(ptr(at, ["usdt-tether", "usdc-circle"])), qTbl("stress-signals:published-exact", rows.map((e) => ({ ...e })), { matchBinds: [at] })]);
    await expect(loadGen(db, nowSec)).resolves.toEqual({ status: "ok", computedAt: at, rows, exactCoverageVerified: true });
  });

  it("rejects a partial canonical generation instead of mixing staged rows", async () => {
    const db = mockD1([ptrTbl(ptr(at, ["usdt-tether", "usdc-circle"])), qTbl("stress-signals:published-exact", [{ ...row("usdc-circle", at) }], { matchBinds: [at] })]);
    await expect(loadGen(db, nowSec)).resolves.toEqual({ status: "unavailable", sourceStatus: "invalid", reason: "published generation coverage mismatch: rows=1/2" });
  });

  it("falls back to canonical history rows when latest materialization is stale", async () => {
    const db = mockD1([ptrTbl(ptr(at)), qTbl("stress-signals:latest-all", [{ ...row("usdt-tether", nowSec - 1_000, 20) }]), qTbl("stress-signals:legacy-latest-all", [{ ...row("usdt-tether", nowSec - 120, 12) }])]);
    expect((await loadAll(db, nowSec, STALE)).results).toEqual([row("usdt-tether", nowSec - 120, 12)]);
  });

  it("keeps the stale bounded latest rows when the canonical history read rejects", async () => {
    const stale = row("usdt-tether", nowSec - 1_000, 20), onReadError = vi.fn();
    const db = mockD1([ptrTbl(ptr(at)), qTbl("stress-signals:latest-all", [stale]), qTbl("stress-signals:legacy-latest-all", [], { throwError: new Error("D1 unavailable") })]);
    expect((await loadAll(db, nowSec, { ...STALE, onReadError })).results).toEqual([stale]); expect(onReadError).toHaveBeenCalledTimes(1);
  });

  it("keeps the single-coin latest row when the exact published read rejects", async () => {
    const older = one(at - 60), onReadError = vi.fn();
    const db = mockD1([ptrTbl(ptr(at, ["usdt-tether", "usdc-circle"])), qTbl("stress-signals:latest-one", [older], { matchBinds: ["usdt-tether", at], first: older }), qTbl("stress-signals:published-exact-one", [], { matchBinds: ["usdt-tether", at], throwError: new Error("D1 exhausted") })]);
    expect(await loadCoin(db, "usdt-tether", nowSec, { ...STALE, onReadError })).toEqual(older); expect(onReadError).toHaveBeenCalledTimes(1);
  });

  it("keeps a stale single-coin latest row when the legacy history read rejects", async () => {
    const stale = one(nowSec - 1_000), onReadError = vi.fn();
    const db = mockD1([ptrTbl(ptr(at)), qTbl("stress-signals:latest-one", [stale], { matchBinds: ["usdt-tether", at], first: stale }), qTbl("stress-signals:legacy-latest-one", [], { throwError: new Error("D1 unavailable") })]);
    expect(await loadCoin(db, "usdt-tether", nowSec, { ...STALE, onReadError })).toEqual(stale); expect(onReadError).toHaveBeenCalledTimes(1);
  });

  it("skips canonical history when the scoped latest generation is complete and fresh", async () => {
    const rows = [row("usdt-tether", at, 12), row("usdc-circle", at, 30)];
    const db = mockD1([ptrTbl(ptr(at, ["usdt-tether", "usdc-circle"])), qTbl("stress-signals:latest-all", rows.map((r) => ({ ...r })), { matchBinds: [at] })]);
    expect((await loadAll(db, nowSec, STALE)).results).toEqual(rows);
  });

  it("loads the exact canonical generation when chunked staging hides part of the published latest set", async () => {
    const sub = row("usdc-circle", at, 30), canon = [row("usdt-tether", at, 12), sub];
    const db = mockD1([ptrTbl(ptr(at, ["usdt-tether", "usdc-circle"])), qTbl("stress-signals:latest-all", [{ ...sub }], { matchBinds: [at] }), qTbl("stress-signals:published-exact-all", canon.map((r) => ({ ...r })), { matchBinds: [at] })]);
    expect((await loadAll(db, nowSec, STALE)).results).toEqual(canon);
  });

  it("fails closed when the exact published generation has lost a row", async () => {
    const db = mockD1([ptrTbl(ptr(at, ["usdt-tether", "usdc-circle"])), qTbl("stress-signals:latest-all", [{ ...row("usdc-circle", at) }], { matchBinds: [at] }), qTbl("stress-signals:published-exact-all", [{ ...row("usdt-tether", at) }], { matchBinds: [at] })]);
    expect((await loadAll(db, nowSec, STALE)).results).toEqual([]);
  });

  it("degrades to the bounded latest rows when the exact generation read rejects", async () => {
    const sub = row("usdc-circle", at), onReadError = vi.fn();
    const db = mockD1([ptrTbl(ptr(at, ["usdt-tether", "usdc-circle"])), qTbl("stress-signals:latest-all", [{ ...sub }], { matchBinds: [at] }), qTbl("stress-signals:published-exact-all", [], { matchBinds: [at], throwError: new Error("D1 unavailable") })]);
    expect((await loadAll(db, nowSec, { ...STALE, onReadError })).results).toEqual([sub]); expect(onReadError).toHaveBeenCalledTimes(1);
  });

  it("keeps the canonical merge for legacy pointers without exact-set proof", async () => {
    const lat = row("usdt-tether", at, 20), canon = row("usdt-tether", at, 22);
    const db = mockD1([ptrTbl(ptr(at)), qTbl("stress-signals:latest-all", [{ ...lat }], { matchBinds: [at] }), qTbl("stress-signals:legacy-latest-all", [{ ...canon }], { matchBinds: [at] })]);
    expect((await loadAll(db, nowSec, STALE)).results).toEqual([lat]);
  });

  it("keeps the canonical merge when latest rows do not all match the published generation", async () => {
    const lat = row("usdt-tether", at - 60, 20), canon = row("usdt-tether", at, 22);
    const db = mockD1([ptrTbl(ptr(at)), qTbl("stress-signals:latest-all", [{ ...lat }], { matchBinds: [at] }), qTbl("stress-signals:legacy-latest-all", [{ ...canon }], { matchBinds: [at] })]);
    expect((await loadAll(db, nowSec, STALE)).results).toEqual([canon]);
  });

  it("keeps a stale single-coin latest row when no legacy row exists", async () => {
    const stale = one(nowSec - 1_000);
    const db = mockD1([ptrTbl(ptr(at)), qTbl("stress-signals:latest-one", [stale], { matchBinds: ["usdt-tether", at], first: stale }), qTbl("stress-signals:legacy-latest-one", [], { matchBinds: ["usdt-tether", at], first: null })]);
    expect(await loadCoin(db, "usdt-tether", nowSec, STALE)).toEqual(stale);
  });

  it("does not revive an older single-coin row under an exact publication pointer", async () => {
    const older = one(at - 60);
    const db = mockD1([ptrTbl(ptr(at, ["usdt-tether", "usdc-circle"])), qTbl("stress-signals:latest-one", [older], { matchBinds: ["usdt-tether", at], first: older }), qTbl("stress-signals:published-exact-one", [], { matchBinds: ["usdt-tether", at], first: null })]);
    expect(await loadCoin(db, "usdt-tether", nowSec, STALE)).toBeNull();
  });

  it("serves a fresh single-coin latest row under an accepted legacy pointer", async () => {
    const fresh = one(at);
    const db = mockD1([ptrTbl(ptr(at)), qTbl("stress-signals:latest-one", [fresh], { matchBinds: ["usdt-tether", at], first: fresh })]);
    expect(await loadCoin(db, "usdt-tether", nowSec, STALE)).toEqual(fresh);
  });

  it("reports a single-coin latest-read failure and falls back to canonical history", async () => {
    const canon = one(nowSec - 120, 12, "CALM"), onReadError = vi.fn();
    const db = mockD1([ptrTbl(ptr(at)), qTbl("stress-signals:latest-one", [], { matchBinds: ["usdt-tether", at], throwError: new Error("D1 unavailable") }), qTbl("stress-signals:legacy-latest-one", [canon], { matchBinds: ["usdt-tether", at], first: canon })]);
    expect(await loadCoin(db, "usdt-tether", nowSec, { ...STALE, onReadError })).toEqual(canon);
    expect(onReadError).toHaveBeenCalledTimes(1); expect(String(onReadError.mock.calls[0]?.[0])).toContain("D1 unavailable");
  });

  it("does not read unbounded current rows when the publication pointer is invalid", async () => {
    expect((await loadAll(mockD1([ptrTbl(ptr(at, undefined, { publishStatus: "draft" }))]), nowSec, STALE)).results).toEqual([]);
  });

  it("does not read single-coin current rows when the publication pointer cannot be read", async () => {
    expect(await loadCoin(mockD1([ptrTbl(null, { throwError: new Error("D1 unavailable") })]), "usdt-tether", nowSec, STALE)).toBeNull();
  });

  it("fails closed when the exact published generation reads zero rows", async () => {
    const db = mockD1([ptrTbl(ptr(at, ["usdt-tether", "usdc-circle"])), qTbl("stress-signals:published-exact", [], { matchBinds: [at] })]);
    await expect(loadGen(db, nowSec)).resolves.toEqual({ status: "unavailable", sourceStatus: "missing", reason: `published generation ${at} has no rows` });
  });

  it("returns rows without exact-coverage proof for a legacy pointer", async () => {
    const rows = [row("usdt-tether", at)];
    const db = mockD1([ptrTbl(ptr(at)), qTbl("stress-signals:published-exact", rows.map((e) => ({ ...e })), { matchBinds: [at] })]);
    await expect(loadGen(db, nowSec)).resolves.toEqual({ status: "ok", computedAt: at, rows, exactCoverageVerified: false });
  });

  it("serves the telegram lane through its own exact published query set", async () => {
    const rows = [row("usdt-tether", at)];
    const db = mockD1([ptrTbl(ptr(at, ["usdt-tether"])), qTbl("telegram-dispatch:dews-published-exact", rows.map((e) => ({ ...e })), { matchBinds: [at] })]);
    expect(await loadTg(db, nowSec, STALE)).toEqual(rows);
  });

  it("serves previous stress rows through their own exact published query set", async () => {
    const rows = [row("usdt-tether", at)];
    const db = mockD1([ptrTbl(ptr(at, ["usdt-tether"])), qTbl("dews:previous-stress-published-exact", rows.map((e) => ({ ...e })), { matchBinds: [at] })]);
    expect(await loadPrev(db, nowSec, STALE)).toEqual(rows);
  });

  it("reports the pointer state when the publication pointer is missing", async () => {
    const loaded = await loadGen(mockD1([ptrTbl(null)]), nowSec);
    expect(loaded.status).toBe("unavailable"); expect(loaded.status === "unavailable" && loaded.reason).toContain("missing");
  });

  it("reports a bounded reason when the exact generation read throws", async () => {
    const db = mockD1([ptrTbl(ptr(at, ["usdt-tether"])), qTbl("stress-signals:published-exact", [], { matchBinds: [at], throwError: new Error("D1 exhausted") })]);
    await expect(loadGen(db, nowSec)).resolves.toEqual({ status: "unavailable", sourceStatus: "read-failed", reason: "generation-read-failed:D1 exhausted" });
  });

  it("rejects a same-count substituted identity in the exact canonical generation", async () => {
    const db = mockD1([ptrTbl(ptr(at, ["usdt-tether", "usdc-circle"])), qTbl("stress-signals:published-exact", [row("usdt-tether", at), row("substituted", at)], { matchBinds: [at] })]);
    await expect(loadGen(db, nowSec)).resolves.toMatchObject({ status: "unavailable" });
  });

  it.each(["read-failed", "future-clock"] as const)("reports the previous accepted generation as unavailable when the pointer is %s", async (state) => {
    const p = state === "future-clock" ? ptr(nowSec + 120, ["usdt-tether"]) : null;
    const db = mockD1([ptrTbl(p, state === "read-failed" ? { first: null, throwError: new Error("D1 read failed") } : {}), { match: "", rows: [], allowUnused: true }]);
    const failures: string[] = [];
    const loaded = await loadDewsSourceState({ db, nowSec, registerSourceFailure: (s) => failures.push(s), registerMalformedPersistedInput: () => {} });
    expect(failures).toEqual([]); expect(loaded.previousSignals.generationUnavailable).toBe(true);
  });

  it("publishes over an unreadable accepted-generation pointer instead of holding forever", async () => {
    const { sqlite, db } = createLatestSchemaSqlite(), clock = Math.floor(Date.now() / 1000), invAt = clock - 1800;
    const ins = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
    ins.run("dews:published-generation", JSON.stringify({ updatedAt: invAt, source: "compute-dews", publishStatus: "published", coverageVersion: 1 }), invAt);
    ins.run("stablecoins", JSON.stringify({ peggedAssets: [{ id: "usdt-tether", symbol: "USDT", pegType: "peggedUSD", price: 1, priceConfidence: "high", circulating: { peggedUSD: 100_000_000 }, circulatingPrevDay: { peggedUSD: 99_000_000 }, circulatingPrevWeek: { peggedUSD: 98_000_000 } }] }), clock - 60);
    sqlite.prepare("INSERT INTO dex_liquidity (stablecoin_id, symbol, weighted_balance_ratio, avg_pool_stress, liquidity_score, total_tvl_usd, updated_at, methodology_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("usdt-tether", "USDT", 0.8, 20, 80, 5_000_000, clock - 60, "3.2");
    try {
      const res = await computeAndStoreDEWS(db), meta = JSON.parse(res.metadata ?? "{}") as Record<string, unknown>;
      expect(res.itemCount).toBeGreaterThan(0); expect(meta.publicationPointerWritten).toBe(true); expect(meta.degradedSources).not.toContain("stress-signals-latest");
      await expect(loadGen(db, clock + 3600)).resolves.toMatchObject({ status: "ok" });
      expect(JSON.parse((sqlite.prepare("SELECT value FROM cache WHERE key = ?").get("dews:published-generation") as { value: string }).value)).toMatchObject({ source: "compute-dews", coverageVersion: 2 });
      expect(JSON.parse((sqlite.prepare("SELECT signals_json FROM stress_signal_publication_rows WHERE stablecoin_id = ?").get("usdt-tether") as { signals_json: string }).signals_json).signals.pool.smoothing).toBe("previous-unavailable");
    } finally { sqlite.close(); }
  });

  it("keeps first-run bootstrap healthy when no accepted-generation pointer exists", async () => {
    const failures: string[] = [];
    await loadDewsSourceState({ db: mockD1([ptrTbl(null), { match: "", rows: [], allowUnused: true }]), nowSec, registerSourceFailure: (s) => failures.push(s), registerMalformedPersistedInput: () => {} });
    expect(failures).toEqual([]);
  });

  it("fails closed on same-count wrong identities in both latest and canonical fallback", async () => {
    const db = mockD1([ptrTbl(ptr(at, ["usdt-tether", "usdc-circle"])), qTbl("stress-signals:latest-all", [row("usdt-tether", at), row("wrong-latest", at)], { matchBinds: [at] }), qTbl("stress-signals:published-exact-all", [row("usdt-tether", at), row("wrong-canonical", at)], { matchBinds: [at] })]);
    expect((await loadAll(db, nowSec, STALE)).results).toEqual([]);
  });
});

import { describe, expect, it, vi } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { fxRatesCacheRows } from "./fx-rate-state.test-support";
import { CLOCK_INPUT_STATES, CLOCK_NOW_SEC } from "@shared/test-utils/boundary-contract-vectors.test-support";
import { buildCacheStatuses as buildStatuses } from "../status/cache-freshness";
import { buildFreshnessMeta as buildMeta, getLatestSuccessfulCronTimestampResult as latestCron } from "../api-freshness";
import { addFreshnessHeaders as addHeaders } from "../api-freshness-headers";
import { API_FRESHNESS_ALLOWED_FUTURE_SKEW_SEC as SKEW, measureFreshnessAge as measureAge } from "../api-freshness-age";

const N = 1_800_000_000;
const js = JSON.stringify;
const nowS = () => Math.floor(Date.now() / 1000);
const withSql = async <T>(fn: (s: ReturnType<typeof createLatestSchemaSqlite>) => Promise<T> | T) => {
  const s = createLatestSchemaSqlite();
  try { return await fn(s); } finally { s.sqlite.close(); }
};
const withNow = (sec: number, fn: () => void) => {
  const spy = vi.spyOn(Date, "now").mockReturnValue(sec * 1000);
  try { fn(); } finally { spy.mockRestore(); }
};
const freshnessDb = (o: { cacheRows?: Record<string, unknown>[]; tableAge?: number | null; pointer?: Record<string, unknown> | null; cronRows?: Record<string, unknown>[]; cacheError?: Error; cronError?: Error } = {}) => mockD1([
  { match: "cache WHERE key IN", rows: o.cacheRows ?? [], throwError: o.cacheError },
  { match: "FROM cache WHERE key = ?", rows: [], first: o.pointer ?? null },
  { match: "FROM dex_liquidity", rows: [{ age: o.tableAge ?? null }] },
  { match: "FROM yield_data", rows: [{ age: o.tableAge ?? null }] },
  { match: "GROUP BY job", rows: o.cronRows ?? [], throwError: o.cronError },
]);
const cacheRow = (key: string, updatedAt: number, value: unknown = {}) => ({ key, updated_at: updatedAt, value: js(value) });
const yieldEnv = (generationId: string, updatedAt: number) => js({ updatedAt, publication: { generationId, updatedAt, cutoffAt: updatedAt, schemaVersion: 1, status: "published" } });
const SRC = { "dex-liquidity": "sync-dex-liquidity", "yield-data": "sync-yield-data", dews: "compute-dews" } as const;
const sentinelRow = (key: keyof typeof SRC, updatedAt: number, ov: Record<string, unknown> = {}) => {
  const generationId = typeof ov.generationId === "string" ? ov.generationId : `${key}:${updatedAt}`;
  return { ...cacheRow(`freshness:${key}`, updatedAt, { updatedAt, source: SRC[key], publishStatus: "ok", generationId, ...ov }), served_generation_id: generationId };
};
const dewsPtr = (updatedAt: number) => cacheRow("dews:published-generation", updatedAt, { updatedAt, source: "compute-dews", publishStatus: "published", coverageVersion: 2, expectedRowCount: 2, stablecoinIdsDigest: "a".repeat(64) });
const baseCacheRows = (now = N) => [cacheRow("stablecoins", now - 60), cacheRow("stablecoin-charts", now - 60), cacheRow("usds-status", now - 60), ...fxRatesCacheRows(now - 60), cacheRow("bluechip-ratings", now - 60)];
const stdCaches = (now = N, ov: { dex?: Record<string, unknown> | null; yld?: Record<string, unknown> | null; dews?: Record<string, unknown> | null; extra?: Record<string, unknown>[] } = {}) => [
  ...baseCacheRows(now),
  ...(ov.dex === null ? [] : [ov.dex ?? sentinelRow("dex-liquidity", now - 120)]),
  ...(ov.yld === null ? [] : [ov.yld ?? sentinelRow("yield-data", now - 180)]),
  ...(ov.dews === null ? [] : [ov.dews ?? sentinelRow("dews", now - 240)]),
  ...(ov.extra ?? []),
];
const seedYieldCache = (sqlite: ReturnType<typeof createLatestSchemaSqlite>["sqlite"], genId: string, at: number, update = false) => {
  const s = sentinelRow("yield-data", at, { generationId: genId });
  if (update) {
    sqlite.prepare("UPDATE cache SET value = ?, updated_at = ? WHERE key = ?").run(s.value, s.updated_at, s.key);
    sqlite.prepare("UPDATE cache SET value = ?, updated_at = ? WHERE key = 'yield-rankings'").run(yieldEnv(genId, at), at);
  } else {
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(s.key, s.value, s.updated_at);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('yield-rankings', ?, ?)").run(yieldEnv(genId, at), at);
  }
};

describe("public freshness clock skew", () => {
  it("clamps public age and degrades timestamps beyond the explicit future-skew allowance", () => {
    const updatedAt = N + SKEW + 1;
    withNow(N, () => {
      expect(measureAge(N, updatedAt, SKEW)).toEqual({ ageSeconds: 0, futureSkewSeconds: SKEW + 1 });
      expect(buildMeta(updatedAt, 60, "test-generic")).toMatchObject({ updatedAt, ageSeconds: 0, status: "degraded" });
      expect(addHeaders({ "Cache-Control": "public, max-age=60" }, updatedAt, 60)).toEqual({ "Cache-Control": "no-store", "X-Data-Age": "0", "X-Data-Updated-At": String(updatedAt), "X-Data-Freshness": "degraded", "X-Data-Freshness-Reason": "future-timestamp", Warning: `199 - "Response timestamp is ${SKEW + 1}s in the future"` });
    });
  });

  it("tolerates bounded producer clock skew while keeping the public age nonnegative", () => {
    const updatedAt = N + SKEW;
    withNow(N, () => {
      expect(buildMeta(updatedAt, 60, "test-generic")).toMatchObject({ ageSeconds: 0, status: "fresh" });
      expect(addHeaders({}, updatedAt, 60)).toEqual({ "X-Data-Age": "0", "X-Data-Updated-At": String(updatedAt) });
    });
  });

  it("keeps a caller-supplied 110 verdict instead of relabelling it as stale", () => {
    const warning = '110 - "Response is degraded (2500s old, max 1800s)"; safety-score dependency publication held (600s old)';
    withNow(N, () => {
      expect(addHeaders({ Warning: warning, "Cache-Control": "public, max-age=60" }, N - 2500, 1800, { freshBudgetSec: 1800 })).toEqual({ Warning: warning, "Cache-Control": "no-store", "X-Data-Age": "2500", "X-Data-Updated-At": String(N - 2500) });
    });
  });
});

describe("self-describing freshness bands", () => {
  it.each([[480, "fresh"], [481, "degraded"], [720, "degraded"], [721, "stale"]] as const)("reconstructs the generic verdict at age %s", (age, exp) => {
    const m = buildMeta(N - age, 60, "test-generic", { assessedAt: N });
    expect(m.assessedAt - m.updatedAt).toBe(m.ageSeconds); expect(m.freshBudgetSec).toBe(480); expect(m.degradedBudgetSec).toBe(720);
    expect(m.status).toBe(exp); expect(m.status).toBe(m.ageSeconds <= m.freshBudgetSec ? "fresh" : m.ageSeconds <= m.degradedBudgetSec ? "degraded" : "stale");
  });

  it.each([[1800, "fresh"], [1801, "degraded"], [3600, "degraded"], [3601, "stale"]] as const)("preserves explicit route bands at age %s", (age, exp) => {
    expect(buildMeta(N - age, 1800, "test-generic", { assessedAt: N, freshBudgetSec: 1800, degradedBudgetSec: 3600 })).toMatchObject({ status: exp, freshBudgetSec: 1800, degradedBudgetSec: 3600 });
  });
});

describe("getLatestSuccessfulCronTimestampResult", () => {
  it("returns ok when a successful cron run exists", async () => {
    await expect(latestCron(mockD1([{ match: "as started_at FROM cron_runs", rows: [], first: { started_at: 1_700_000_000 } }]), "sync-yield-data")).resolves.toEqual({ timestamp: 1_700_000_000, status: "ok" });
  });
  it("returns missing when no successful cron run exists", async () => {
    await expect(latestCron(mockD1([{ match: "as started_at FROM cron_runs", rows: [], first: { started_at: null } }]), "sync-yield-data")).resolves.toEqual({ timestamp: null, status: "missing" });
  });
  it("returns lookup_failed when the cron query throws", async () => {
    await expect(latestCron(mockD1([{ match: "as started_at FROM cron_runs", rows: [], throwError: new Error("boom") }]), "sync-yield-data")).resolves.toEqual({ timestamp: null, status: "lookup_failed" });
  });
  it("dates several producer lanes from their oldest confirmed output", async () => withSql(async ({ sqlite, db }) => {
    const ins = sqlite.prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status, metadata) VALUES (?, ?, 100, 'ok', ?)");
    ins.run("sync-mint-burn", 1_700_000_600, js({ outputPublishedAt: 1_700_000_600 }));
    ins.run("sync-mint-burn-extended", 1_700_000_000, js({ outputPublishedAt: 1_700_000_000 }));
    await expect(latestCron(db, ["sync-mint-burn", "sync-mint-burn-extended"])).resolves.toEqual({ timestamp: 1_700_000_000, status: "ok" });
    await expect(latestCron(db, ["sync-mint-burn", "sync-blacklist"])).resolves.toEqual({ timestamp: null, status: "missing" });
  }));
});

describe("buildCacheStatuses sentinel validation", () => {
  it.each(CLOCK_INPUT_STATES)("preserves $state clock evidence without borrowing the request clock", async ({ state, updatedAt, generationId }) => {
    if (state === "missing" || state === "future") {
      const { caches } = await buildStatuses(freshnessDb({ cacheRows: updatedAt === null ? [] : [cacheRow("stablecoins", updatedAt)] }), CLOCK_NOW_SEC);
      expect(caches.stablecoins).toMatchObject({ healthy: false, ageSeconds: null });
      if (state === "future") expect(caches.stablecoins.timestampReason).toBe("future-timestamp");
    } else if (state === "mismatched-generation") {
      const { caches } = await buildStatuses(freshnessDb({ cacheRows: [{ ...sentinelRow("yield-data", updatedAt, { generationId }), served_generation_id: "generation:current" }] }), CLOCK_NOW_SEC);
      expect(caches["yield-data"]).toMatchObject({ healthy: false, generationId: null, sentinelValidationReason: "generation-mismatch" });
    } else {
      expect(buildMeta(updatedAt, 60, "test-generic", { assessedAt: CLOCK_NOW_SEC, freshBudgetSec: 60, degradedBudgetSec: 60 })).toMatchObject({ status: state === "expired" ? "stale" : "fresh", updatedAt });
    }
  });

  it.each([60, 61])("admits ordinary cache clocks only within the %s-second future boundary", async (off) => {
    const { caches } = await buildStatuses(freshnessDb({ cacheRows: [cacheRow("stablecoins", N + off)] }), N);
    expect(caches.stablecoins).toMatchObject(off === 60 ? { ageSeconds: 0, healthy: true } : { ageSeconds: null, healthy: false, timestampReason: "future-timestamp" });
  });

  it.each(["table", "cron"] as const)("rejects future %s fallback clocks instead of clamping them fresh", async (src) => {
    const { caches } = await buildStatuses(freshnessDb({ tableAge: src === "table" ? -61 : null, cronRows: src === "cron" ? [{ job: "sync-yield-data", started_at: N + 61 }] : [] }), N);
    expect(caches["yield-data"]).toMatchObject({ ageSeconds: null, healthy: false, timestampReason: "future-timestamp" });
  });

  it("does not grade a sentinel for a different served generation as healthy", async () => {
    const { caches } = await buildStatuses(freshnessDb({ cacheRows: [{ ...sentinelRow("yield-data", N - 60), served_generation_id: "other-winner" }], tableAge: 60 }), N);
    expect(caches["yield-data"]).toMatchObject({ healthy: false, generationId: null, sentinelValidationReason: "generation-mismatch" });
  });

  it.each([21600, 21601, 43200, 43201])("preserves generation and yield freshness bands at %s seconds", async (age) => {
    const { caches } = await buildStatuses(freshnessDb({ cacheRows: [sentinelRow("yield-data", N - age, { generationId: "yield-winner" })], cronRows: [{ job: "sync-yield-data", started_at: N - age, degraded_runs_since_ok: 0 }] }), N);
    expect(caches["yield-data"]).toMatchObject({ generationId: "yield-winner", publishedAt: N - age, ageSeconds: age, maxAge: 7200, healthyMaxAge: 21600, healthy: age <= 21600 });
    expect(buildMeta(N - age, 7200, "yield-data", { assessedAt: N }).status).toBe(age <= 21600 ? "fresh" : age <= 43200 ? "degraded" : "stale");
  });

  it.each(["legacy", "table", "cron"] as const)("preserves the publication clock without inventing identity for %s evidence", async (src) => {
    const { caches } = await buildStatuses(freshnessDb({ cacheRows: src === "legacy" ? [sentinelRow("yield-data", N - 30, { generationId: undefined })] : [], tableAge: src !== "cron" ? 60 : null, cronRows: src === "cron" ? [{ job: "sync-yield-data", started_at: N - 60 }] : [] }), N);
    expect(caches["yield-data"]).toMatchObject({ generationId: null, publishedAt: N - 60, ageSeconds: 60, freshnessSource: src === "cron" ? "cron-fallback" : "table-fallback" });
  });

  it.each([0, 1])("validates concurrent DEWS publication against the cache read clock (future offset %s)", async (off) => {
    const obsAt = N + 20, db = freshnessDb({ cacheRows: [{ ...sentinelRow("dews", obsAt + off), observed_at: obsAt }], cronRows: [{ job: "compute-dews", started_at: obsAt, degraded_runs_since_ok: 0 }] });
    const { caches } = await buildStatuses(db, N);
    expect(caches.dews).toMatchObject(off === 0 ? { freshnessSource: "freshness-sentinel", degraded: false, ageSeconds: 0 } : { degraded: true, degradedReason: "freshness-sentinel-invalid:future-updated-at" });
    expect(db.getHistory().some((e) => e.sql.includes("unixepoch() AS observed_at"))).toBe(true);
  });

  it("ignores newer non-best yield sources when measuring fallback freshness", async () => withSql(async ({ db, sqlite }) => {
    const ins = sqlite.prepare("INSERT INTO yield_data (stablecoin_id, source_key, symbol, current_apy, apy_7d, apy_30d, yield_source, yield_type, data_source, is_best, updated_at) VALUES ('usdc-circle', ?, 'USDC', 4, 4, 4, 'lending', 'lending', 'defillama', ?, ?)");
    ins.run("best", 1, N - 600); ins.run("alternative", 0, N - 10);
    expect((await buildStatuses(db, N)).caches["yield-data"]).toMatchObject({ ageSeconds: 600, freshnessSource: "table-fallback", generationId: null, publishedAt: N - 600 });
    sqlite.exec("UPDATE yield_data SET is_best = 0");
    expect((await buildStatuses(db, N)).caches["yield-data"]).toMatchObject({ ageSeconds: null, generationId: null, publishedAt: null });
  }));

  it("reads completed yield input quality and its latest cause without changing producer status", async () => withSql(async ({ db, sqlite }) => {
    const now = nowS(), reason = "yield-supplemental:family-degraded:aaveV3:upstream-unavailable";
    seedYieldCache(sqlite, "yield-imperfect", now - 60);
    const ins = sqlite.prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status, metadata, degraded_reason) VALUES ('sync-yield-data', ?, 1, ?, ?, ?)");
    ins.run(now - 180, "ok", js({ outputPublishedAt: now - 180, quality: { degraded: false, reasons: [] } }), null);
    ins.run(now - 120, "degraded", js({ reason: "yield-publication-transaction-failed" }), "yield-publication-transaction-failed");
    ins.run(now - 60, "ok", js({ outputPublishedAt: now - 60, quality: { degraded: true, reasons: [reason] } }), null);
    expect((await buildStatuses(db, now)).caches["yield-data"]).toMatchObject({ ageSeconds: 60, degraded: true, degradedReason: reason, streakDegradedRuns: 1, generationId: "yield-imperfect", publishedAt: now - 60 });
    expect(sqlite.prepare("SELECT status, degraded_reason FROM cron_runs ORDER BY started_at DESC LIMIT 1").get()).toEqual({ status: "ok", degraded_reason: null });
    ins.run(now - 30, "ok", js({ outputPublishedAt: null, quality: { degraded: false, reasons: [], advisoryReasons: ["yield-supplemental:family-degraded:pendle:pendle-rate-limited-backoff"] } }), null);
    expect((await buildStatuses(db, now)).caches["yield-data"]).toMatchObject({ degraded: true, degradedReason: reason, streakDegradedRuns: 1 });
    ins.run(now - 10, "ok", js({ outputPublishedAt: now - 10 }), null);
    seedYieldCache(sqlite, "yield-clean", now - 10, true);
    expect((await buildStatuses(db, now)).caches["yield-data"]).toMatchObject({ degraded: false, degradedReason: null, streakDegradedRuns: 0, healthy: true });
  }));

  it.each([
    { label: "no terminal history", rows: [] },
    { label: "older confirmed publication", rows: [{ job: "sync-dex-liquidity", started_at: N - 600, generation_id: "dex-old", degraded_runs_since_ok: 0 }] },
    { label: "older generation completing after the new source clock", rows: [{ job: "sync-dex-liquidity", started_at: N - 30, generation_id: "dex-old", degraded_runs_since_ok: 0 }] },
  ])("keeps DEX publication quality unknown with $label", async ({ rows }) => {
    const { caches } = await buildStatuses(freshnessDb({ cacheRows: [sentinelRow("dex-liquidity", N - 60, { generationId: "dex-new" })], cronRows: rows }), N);
    expect(caches["dex-liquidity"]).toMatchObject({ freshnessSource: "freshness-sentinel", generationId: "dex-new", publishedAt: N - 60, degraded: null, degradedReason: "producer-publication-unconfirmed", streakDegradedRuns: null, healthy: false });
  });

  it.each(["error", "degraded", "skipped_neutral"])("keeps a fresh clean publication healthy after an unpublished %s attempt", async (status) => withSql(async ({ db, sqlite }) => {
    const now = nowS();
    seedYieldCache(sqlite, "retained-clean", now - 600);
    const ins = sqlite.prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status, metadata, degraded_reason) VALUES ('sync-yield-data', ?, 20000, ?, ?, ?)");
    ins.run(now - 600, "ok", js({ outputPublishedAt: now - 590, persistence: { generationId: "retained-clean" } }), null);
    ins.run(now - 60, status, js({ outputPublishedAt: null, reason: "candidate-not-published" }), "candidate-not-published");
    expect((await buildStatuses(db, now)).caches["yield-data"]).toMatchObject({ ageSeconds: 600, degraded: false, degradedReason: null, streakDegradedRuns: 0, healthy: true, generationId: "retained-clean", publishedAt: now - 600 });
    expect((await buildStatuses(db, now + 22_000)).caches["yield-data"]).toMatchObject({ ageSeconds: 22_600, degraded: false, healthy: false, publishedAt: now - 600 });
    seedYieldCache(sqlite, "new-unconfirmed", now - 60, true);
    expect((await buildStatuses(db, now)).caches["yield-data"]).toMatchObject({ generationId: "new-unconfirmed", degraded: null, degradedReason: "producer-publication-unconfirmed", healthy: false });
  }));

  it.each([false, true])("orders publication quality by output clock when the latest output is degraded=%s", async (degraded) => withSql(async ({ db, sqlite }) => {
    const now = nowS();
    seedYieldCache(sqlite, "latest-output", now - 60);
    const ins = sqlite.prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status, metadata) VALUES ('sync-yield-data', ?, 120000, 'ok', ?)");
    ins.run(now - 180, js({ outputPublishedAt: now - 60, quality: { degraded, reasons: ["latest-output-quality"] } }));
    ins.run(now - 120, js({ outputPublishedAt: now - 100, quality: { degraded: !degraded, reasons: ["older-output-quality"] } }));
    expect((await buildStatuses(db, now)).caches["yield-data"]).toMatchObject({ degraded, degradedReason: degraded ? "latest-output-quality" : null, streakDegradedRuns: degraded ? 1 : 0, publishedAt: now - 60 });
  }));

  it("uses valid freshness sentinels without hot-table fallback queries", async () => {
    const db = mockD1([{ match: "cache WHERE key IN", rows: stdCaches() }, { match: "GROUP BY job", rows: [] }]);
    const { caches, diagnostics, warnings } = await buildStatuses(db, N);
    expect(caches["dex-liquidity"]).toMatchObject({ ageSeconds: 120, freshnessSource: "freshness-sentinel", producerJob: "sync-dex-liquidity", producerIntervalSec: 3600, endpointMaxAge: 14400, availabilityMaxAge: 43200 });
    expect(caches["yield-data"]).toMatchObject({ ageSeconds: 180, freshnessSource: "freshness-sentinel", producerJob: "sync-yield-data", producerIntervalSec: 7200, endpointMaxAge: 7200, availabilityMaxAge: 7200 });
    expect(caches.dews).toMatchObject({ ageSeconds: 240, freshnessSource: "freshness-sentinel", producerJob: "compute-dews", producerIntervalSec: 1800, endpointMaxAge: 3600, availabilityMaxAge: 3600 });
    expect(diagnostics).toEqual([]); expect(warnings).toEqual([]);
    const hist = db.getHistory().map((e) => e.sql);
    for (const frag of ["SELECT (? - MAX(updated_at))", "FROM yield_data", "FROM stress_signals"]) expect(hist.some((s) => s.includes(frag))).toBe(false);
  });

  it("falls back to table freshness when a sentinel has the wrong producer source", async () => {
    const db = mockD1([{ match: "cache WHERE key IN", rows: stdCaches(N, { dex: sentinelRow("dex-liquidity", N - 120, { source: "sync-yield-data" }) }) }, { match: "GROUP BY job", rows: [] }, { match: "dex_liquidity", rows: [], first: { age: 45 } }]);
    const { caches, diagnostics, warnings } = await buildStatuses(db, N);
    const w = "dex-liquidity: freshness sentinel invalid (wrong-source); using table-fallback";
    expect(caches["dex-liquidity"]).toMatchObject({ ageSeconds: 45, freshnessSource: "table-fallback", sentinelValidationReason: "wrong-source", warning: w });
    expect(diagnostics).toEqual([expect.objectContaining({ key: "dex-liquidity", freshnessSource: "table-fallback", sentinelValidationReason: "wrong-source" })]);
    expect(warnings).toContain(w); expect(db.getHistory().some((e) => e.sql.includes("FROM dex_liquidity"))).toBe(true);
  });

  it("falls back to cron freshness when a malformed sentinel and table freshness both fail", async () => {
    const db = mockD1([{ match: "cache WHERE key IN", rows: stdCaches(N, { dex: { key: "freshness:dex-liquidity", updated_at: N - 120, value: "{bad-json" } }) }, { match: "GROUP BY job", rows: [{ job: "sync-dex-liquidity", started_at: N - 300 }] }, { match: "dex_liquidity", rows: [], throwError: new Error("table unavailable") }]);
    const { caches, diagnostics, warnings } = await buildStatuses(db, N);
    const w = "dex-liquidity: freshness sentinel invalid (malformed-json); using cron-fallback";
    expect(caches["dex-liquidity"]).toMatchObject({ ageSeconds: 300, freshnessSource: "cron-fallback", sentinelValidationReason: "malformed-json", warning: w });
    expect(diagnostics).toEqual([expect.objectContaining({ key: "dex-liquidity", freshnessSource: "cron-fallback", failureSource: "table-freshness", sentinelValidationReason: "malformed-json" })]);
    expect(warnings).toContain(w);
  });

  it.each([
    ["missing", { first: null }, []], ["malformed", { first: { key: "dews:published-generation", updated_at: 1, value: "{" } }, []],
    ["future", { first: dewsPtr(1_800_003_600) }, []], ["rejected", { throwError: new Error("D1 down") }, ["dews"]],
  ] as const)("names only a rejected DEWS pointer read as a rejected read (%s)", async (_k, pointer, exp) => {
    const db = mockD1([{ match: "cache WHERE key IN", rows: [sentinelRow("dews", N - 240, { source: "wrong-producer" })] }, { match: "GROUP BY job", rows: [] }, { match: "FROM cache WHERE key = ?", matchBinds: ["dews:published-generation"], rows: [], ...pointer }]);
    const { caches, failures, rejectedReads } = await buildStatuses(db, N, { keys: ["dews"] });
    expect(caches.dews?.ageSeconds).toBeNull(); expect(failures.map((f) => f.key)).toEqual(["dews"]); expect(rejectedReads).toEqual(exp);
  });

  it("uses the DEWS publication pointer instead of partial stress-signal rows", async () => {
    const db = mockD1([{ match: "cache WHERE key IN", rows: stdCaches(N, { dews: sentinelRow("dews", N - 240, { source: "wrong-producer" }) }) }, { match: "GROUP BY job", rows: [] }, { match: "FROM cache WHERE key = ?", matchBinds: ["dews:published-generation"], rows: [dewsPtr(N - 420)] }]);
    const { caches, diagnostics, warnings } = await buildStatuses(db, N);
    expect(caches.dews).toMatchObject({ ageSeconds: 420, freshnessSource: "table-fallback", sentinelValidationReason: "wrong-source" });
    expect(diagnostics).toContainEqual(expect.objectContaining({ key: "dews", freshnessSource: "table-fallback" }));
    expect(warnings).toContain("dews: freshness sentinel invalid (wrong-source); using table-fallback");
    expect(db.getHistory().some((e) => e.sql.includes("FROM stress_signals"))).toBe(false);
  });

  it("keeps yield-data healthy through one missed hourly publish (<= 2x availability budget)", async () => {
    const db = mockD1([{ match: "cache WHERE key IN", rows: stdCaches(N, { yld: sentinelRow("yield-data", N - 1_800) }) }, { match: "GROUP BY job", rows: [{ job: "sync-yield-data", started_at: N - 1_800, degraded_runs_since_ok: 0 }] }]);
    const { caches, statusFloor } = await buildStatuses(db, N);
    expect(caches["yield-data"]).toMatchObject({ ageSeconds: 1_800, healthy: true }); expect(statusFloor).toBe("healthy");
  });

  it("degrades yield-data past 3x its hourly budget while other caches stay fresh", async () => {
    const db = mockD1([{ match: "cache WHERE key IN", rows: stdCaches(N, { yld: sentinelRow("yield-data", N - 22_000) }) }, { match: "GROUP BY job", rows: [] }]);
    const { caches, statusFloor } = await buildStatuses(db, N);
    expect(caches["yield-data"]).toMatchObject({ ageSeconds: 22_000, healthy: false }); expect(statusFloor).toBe("degraded");
  });

  it("fails closed when DEWS publication evidence is missing even if cron history is fresh", async () => {
    const db = mockD1([{ match: "cache WHERE key IN", rows: stdCaches(N, { dews: { key: "freshness:dews", updated_at: N - 240, value: "{bad-json" } }) }, { match: "GROUP BY job", rows: [{ job: "compute-dews", started_at: N - 30 }] }, { match: "FROM cache WHERE key = ?", matchBinds: ["dews:published-generation"], rows: [], first: null }]);
    const { caches, failures, statusFloor } = await buildStatuses(db, N);
    expect(caches.dews?.ageSeconds).toBeNull(); expect(caches.dews?.freshnessSource).toBeUndefined();
    expect(failures).toContainEqual(expect.objectContaining({ key: "dews", source: "table-freshness", message: expect.stringContaining("no-pointer") }));
    expect(statusFloor).toBe("stale");
  });

  it("reports a table-query failure when cron timestamps rescue a missing sentinel", async () => {
    const db = mockD1([{ match: "cache WHERE key IN", rows: stdCaches(N, { dex: null }) }, { match: "GROUP BY job", rows: [{ job: "sync-dex-liquidity", started_at: N - 300 }] }, { match: "dex_liquidity", rows: [], throwError: new Error("table unavailable") }]);
    const { caches, diagnostics, warnings } = await buildStatuses(db, N);
    const w = "dex-liquidity: freshness table query failed; using cron fallback";
    expect(caches["dex-liquidity"]).toMatchObject({ ageSeconds: 300, freshnessSource: "cron-fallback", warning: w });
    expect(diagnostics).toContainEqual({ key: "dex-liquidity", freshnessSource: "cron-fallback", warning: w, failureSource: "table-freshness" });
    expect(warnings).toContain(w);
  });

  it("escalates the global floor to stale when yield-data blows past its override ceiling", async () => {
    const db = mockD1([{ match: "cache WHERE key IN", rows: stdCaches(N, { yld: sentinelRow("yield-data", N - 50_000) }) }, { match: "GROUP BY job", rows: [] }]);
    const { caches, statusFloor } = await buildStatuses(db, N);
    expect(caches["yield-data"]).toMatchObject({ ageSeconds: 50_000, healthy: false }); expect(statusFloor).toBe("stale");
  });

  it("publishes a degraded quality verdict when a sentinel-backed cache has no sentinel at all", async () => {
    const db = mockD1([{ match: "cache WHERE key IN", rows: stdCaches(N, { yld: null }) }, { match: "GROUP BY job", rows: [{ job: "compute-dews", started_at: N - 240, degraded_runs_since_ok: 0 }] }, { match: "FROM yield_data", rows: [], first: { age: 60 } }]);
    const { caches } = await buildStatuses(db, N);
    expect(caches["yield-data"]).toMatchObject({ ageSeconds: 60, freshnessSource: "table-fallback", degraded: true, degradedReason: "freshness-sentinel-missing", healthy: false });
    expect(caches.dews).toMatchObject({ degraded: false, healthy: true });
  });

  it("degrades a sentinel-fresh cache whose confirmed publication has degraded inputs", async () => {
    const db = mockD1([{ match: "cache WHERE key IN", rows: stdCaches(N, { yld: sentinelRow("yield-data", N - 60) }) }, { match: "GROUP BY job", rows: [{ job: "sync-yield-data", started_at: N - 60, degraded_runs_since_ok: 3, latest_reason: "yield-source-coverage-degraded" }] }]);
    expect((await buildStatuses(db, N)).caches["yield-data"]).toMatchObject({ ageSeconds: 60, freshnessSource: "freshness-sentinel", degraded: true, degradedReason: "yield-source-coverage-degraded", streakDegradedRuns: 3, healthy: false });
  });

  it("publishes unknown quality, never a clean verdict, when the producer-history read fails", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const db = mockD1([{ match: "cache WHERE key IN", rows: stdCaches(N, { yld: sentinelRow("yield-data", N - 60) }) }, { match: "GROUP BY job", rows: [], throwError: new Error("cron lookup failed") }]);
      expect((await buildStatuses(db, N)).caches["yield-data"]).toMatchObject({ freshnessSource: "freshness-sentinel", streakDegradedRuns: null, degraded: null, degradedReason: "producer-history-unreadable", healthy: false });
    } finally { spy.mockRestore(); }
  });
});

describe("buildCacheStatuses", () => {
  it("ignores an unknown provider instead of evaluating its freshness", async () => {
    const db = freshnessDb({ cacheRows: stdCaches(N, { dex: sentinelRow("dex-liquidity", N - 60), yld: sentinelRow("yield-data", N - 60), dews: sentinelRow("dews", N - 60), extra: [cacheRow("unknown-provider", N - 86_400)] }) });
    const { caches, statusFloor } = await buildStatuses(db, N);
    expect(caches).not.toHaveProperty("unknown-provider"); expect(statusFloor).toBe("healthy");
  });

  it("uses table timestamps for table-backed datasets and the publication pointer for DEWS", async () => {
    const now = nowS(), db = freshnessDb({ tableAge: 120, pointer: dewsPtr(now - 120) });
    const { caches } = await buildStatuses(db, now);
    expect(caches["dex-liquidity"]).toMatchObject({ ageSeconds: 120, freshnessSource: "table-fallback" });
    expect(caches["yield-data"]).toMatchObject({ ageSeconds: 120, freshnessSource: "table-fallback" });
    expect(caches.dews?.ageSeconds).toBe(120);
    expect(db.getHistory().some((e) => e.sql.includes("FROM stress_signals"))).toBe(false);
  });

  it("admits table clocks within allowed skew without accepting a future DEWS pointer", async () => {
    const { caches } = await buildStatuses(freshnessDb({ tableAge: -30 }), nowS());
    expect(caches["dex-liquidity"]?.ageSeconds).toBe(0); expect(caches["yield-data"]?.ageSeconds).toBe(0); expect(caches.dews?.ageSeconds).toBeNull();
  });

  it("grades a DEWS pointer observed after the captured run clock at age zero", async () => withSql(async ({ db, sqlite }) => {
    const ptrAt = nowS(), runClk = ptrAt - 30, prevAt = ptrAt - 1_800, freshAt = runClk - 60;
    const sv = (updatedAt: number, source: string, generationId: string) => js({ updatedAt, source, publishStatus: "ok", generationId });
    const ins = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
    for (const k of ["stablecoins", "stablecoin-charts", "usds-status", "bluechip-ratings"]) ins.run(k, "{}", freshAt);
    for (const r of fxRatesCacheRows(freshAt)) ins.run(r.key, r.value, r.updated_at);
    ins.run("freshness:dex-liquidity", sv(freshAt, "sync-dex-liquidity", "dex:global"), freshAt);
    ins.run("freshness:yield-data", sv(freshAt, "sync-yield-data", "yield:current"), freshAt);
    ins.run("yield-rankings", yieldEnv("yield:current", freshAt), freshAt);
    ins.run("freshness:dews", sv(prevAt, "compute-dews", `dews:${prevAt}`), prevAt);
    const p = dewsPtr(ptrAt); ins.run(p.key, p.value, p.updated_at);
    sqlite.prepare("INSERT INTO dex_liquidity_publication_generations (generation_id, started_at, state, expected_row_count, written_row_count, created_at) VALUES (?, ?, 'published', 1, 1, ?)").run("dex:global", freshAt, freshAt);
    sqlite.prepare("INSERT INTO dex_liquidity (stablecoin_id, symbol, updated_at, liquidity_score, publication_generation_id, publication_state) VALUES ('__global__', 'ALL', ?, 70, 'dex:global', 'published')").run(freshAt);
    const { caches, diagnostics, failures, statusFloor, warnings } = await buildStatuses(db, runClk);
    expect(caches.dews).toMatchObject({ ageSeconds: 0, publishedAt: ptrAt, freshnessSource: "table-fallback", sentinelValidationReason: "generation-mismatch", degraded: true, degradedReason: "freshness-sentinel-invalid:generation-mismatch", healthy: false });
    expect(failures).not.toContainEqual(expect.objectContaining({ key: "dews" }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ key: "dews", freshnessSource: "table-fallback", sentinelValidationReason: "generation-mismatch" }));
    expect(warnings).toContain("dews: freshness sentinel invalid (generation-mismatch); using table-fallback");
    expect(statusFloor).toBe("healthy");
  }));

  it("does not let producer cron timestamps replace missing DEWS publication evidence", async () => {
    const now = nowS(), { caches, diagnostics, failures, warnings } = await buildStatuses(freshnessDb({ cronRows: [{ job: "compute-dews", started_at: now - 300 }] }), now);
    expect(caches.dews?.ageSeconds).toBeNull(); expect(caches.dews?.warning).toBeUndefined();
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ key: "dews" }));
    expect(failures).toEqual([{ key: "dews", source: "table-freshness", message: "DEWS published generation unavailable (no-pointer): publication pointer is missing" }]);
    expect(warnings).not.toContain("dews: freshness table query failed; using cron fallback");
  });

  it("uses table fallback warnings when the cache lookup fails", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const { caches, diagnostics, failures, warnings } = await buildStatuses(freshnessDb({ tableAge: 45, cacheError: new Error("cache lookup failed") }), nowS());
      const w = "dex-liquidity: freshness sentinel lookup failed; using table fallback";
      expect(caches["dex-liquidity"]).toMatchObject({ ageSeconds: 45, warning: w });
      expect(diagnostics).toContainEqual({ key: "dex-liquidity", freshnessSource: "table-fallback", warning: w, failureSource: "cache-table" });
      expect(failures).toContainEqual({ key: "__cache__", source: "cache-table", message: "cache lookup failed" });
      expect(warnings).toContain(w); expect(spy).toHaveBeenCalledWith(expect.stringContaining(`[api-freshness] ${w}`));
    } finally { spy.mockRestore(); }
  });

  it("uses cron fallback warnings when cache lookup fails and table freshness is unavailable", async () => {
    const now = nowS(), spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const { caches, diagnostics, failures, warnings } = await buildStatuses(freshnessDb({ cacheError: new Error("cache lookup failed"), cronRows: [{ job: "sync-dex-liquidity", started_at: now - 90 }, { job: "sync-yield-data", started_at: now - 120 }, { job: "compute-dews", started_at: now - 150 }] }), now);
      const w = "dex-liquidity: freshness sentinel lookup failed; using cron fallback";
      expect(caches["dex-liquidity"]).toMatchObject({ ageSeconds: 90, warning: w });
      expect(diagnostics).toContainEqual({ key: "dex-liquidity", freshnessSource: "cron-fallback", warning: w, failureSource: "cache-table" });
      expect(failures).toContainEqual({ key: "__cache__", source: "cache-table", message: "cache lookup failed" });
      expect(warnings).toContain(w); expect(spy).toHaveBeenCalledWith(expect.stringContaining(`[api-freshness] ${w}`));
    } finally { spy.mockRestore(); }
  });

  it("records cron fallback failures when both table and producer fallback lookups are unavailable", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { failures } = await buildStatuses(freshnessDb({ cronError: new Error("cron lookup failed") }), nowS());
      expect(failures).toContainEqual({ key: "dex-liquidity", source: "cron-fallback", message: "cron lookup failed" });
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("[api-freshness] Failed to read producer cron fallbacks"));
    } finally { spy.mockRestore(); }
  });

  it("uses fx-rates-meta usableSyncAt for cache freshness and keeps cadence-aware source warnings separate", async () => {
    const now = nowS();
    const db = freshnessDb({ tableAge: 60, pointer: dewsPtr(now - 60), cacheRows: [cacheRow("stablecoins", now - 60), cacheRow("stablecoin-charts", now - 60), cacheRow("usds-status", now - 60), ...fxRatesCacheRows(now - 30, { peggedEUR: 1.08 }, { usableSyncAt: now - 180, mode: "cached-fallback", sourceUpdatedAtByPeg: { peggedEUR: now - 8 * 3600 }, sourceModeByPeg: { peggedEUR: "cached" }, sourceCadenceByPeg: { peggedEUR: "intraday" }, consecutiveFallbackRuns: 4 }), cacheRow("bluechip-ratings", now - 60)] });
    const { caches, statusFloor, warnings } = await buildStatuses(db, now);
    expect(caches["fx-rates"]).toMatchObject({ ageSeconds: 180, mode: "cached-fallback", sourceStatus: "degraded", consecutiveFallbackRuns: 4 });
    expect(statusFloor).toBe("degraded"); expect(warnings[0]).toContain("cached fallback FX rates");
  });

  it("publishes the healthy band each cache verdict was measured against", async () => {
    const db = mockD1([
      { match: "cache WHERE key IN", rows: stdCaches(N, { yld: sentinelRow("yield-data", N - 22_000), dews: sentinelRow("dews", N - 3_473) }) },
      { match: "GROUP BY job", rows: [{ job: "compute-dews", started_at: N - 3_473, degraded_runs_since_ok: 0 }, { job: "sync-dex-liquidity", started_at: N - 120, degraded_runs_since_ok: 0 }, { job: "sync-yield-data", started_at: N - 22_000, degraded_runs_since_ok: 0 }] },
    ]);
    const { caches } = await buildStatuses(db, N);
    expect(caches.dews).toMatchObject({ ageSeconds: 3_473, maxAge: 3_600, healthyMaxRatio: 12, healthyMaxAge: 43_200, healthy: true });
    expect(caches["yield-data"]).toMatchObject({ ageSeconds: 22_000, maxAge: 7_200, healthyMaxRatio: 3, healthyMaxAge: 21_600, healthy: false });
    expect(Object.entries(caches).filter(([, c]) => c.healthyMaxAge !== c.maxAge * (c.healthyMaxRatio ?? 0)).map(([k]) => k)).toEqual([]);
    expect(Object.entries(caches).filter(([, c]) => c.healthy !== (c.ageSeconds != null && c.ageSeconds <= (c.healthyMaxAge ?? 0))).map(([k]) => k)).toEqual([]);
  });
});

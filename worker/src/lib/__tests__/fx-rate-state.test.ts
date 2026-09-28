import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { sha256Hex } from "@shared/lib/sha256";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { D1PreparedStatement } from "@shared/types/cloudflare-runtime";
import { setCacheIfNewer } from "../db-cache";
import {
  buildFxCacheStatus,
  getFxReferenceTypeFromState,
  hydrateFxRateState,
  loadFxRateState,
  persistFxRateState,
  type FxRateState,
  type FxRatesMeta,
} from "../fx-rate-state";

function buildState(meta: Record<string, unknown>, rates: Record<string, number>) {
  const nowSec = Math.floor(Date.now() / 1000);
  return hydrateFxRateState(
    { value: JSON.stringify(rates), updatedAt: nowSec - 60 },
    { value: JSON.stringify(meta), updatedAt: nowSec - 60 },
  );
}

describe("fx-rate-state cadence-aware freshness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps business-daily references fresh before the next publish window", () => {
    vi.setSystemTime(new Date("2026-03-11T08:00:00Z"));
    const nowSec = Math.floor(Date.now() / 1000);
    const state = buildState(
      {
        usableSyncAt: nowSec - 60,
        mode: "live",
        sourceUpdatedAtByPeg: { peggedEUR: nowSec - (16 * 3600) },
        sourceModeByPeg: { peggedEUR: "live" },
        sourceCadenceByPeg: { peggedEUR: "business-daily" },
        sourceDateByPeg: { peggedEUR: "2026-03-10" },
        consecutiveFallbackRuns: 0,
      },
      { peggedEUR: 1.08 },
    );

    expect(state).not.toBeNull();
    expect(getFxReferenceTypeFromState(state, "peggedEUR", 6 * 3600, nowSec)).toBe("fresh");
    expect(buildFxCacheStatus(state, 1800, nowSec).cacheStatus.sourceStatus).toBe("fresh");
  });

  it("keeps Friday business-daily references fresh through the weekend", () => {
    vi.setSystemTime(new Date("2026-03-15T12:00:00Z"));
    const nowSec = Math.floor(Date.now() / 1000);
    const state = buildState(
      {
        usableSyncAt: nowSec - 60,
        mode: "live",
        sourceUpdatedAtByPeg: { peggedEUR: nowSec - (44 * 3600) },
        sourceModeByPeg: { peggedEUR: "live" },
        sourceCadenceByPeg: { peggedEUR: "business-daily" },
        sourceDateByPeg: { peggedEUR: "2026-03-13" },
        consecutiveFallbackRuns: 0,
      },
      { peggedEUR: 1.08 },
    );

    expect(state).not.toBeNull();
    expect(getFxReferenceTypeFromState(state, "peggedEUR", 6 * 3600, nowSec)).toBe("fresh");
    expect(buildFxCacheStatus(state, 1800, nowSec).cacheStatus.sourceStatus).toBe("fresh");
  });

  it("keeps business-daily references fresh through TARGET closing days", () => {
    // The ECB page still shows 2026-04-02 on Easter Monday because both
    // 2026-04-03 (Good Friday) and 2026-04-06 (Easter Monday) are TARGET
    // closing days and therefore not publish days.
    vi.setSystemTime(new Date("2026-04-06T19:00:00Z"));
    const nowSec = Math.floor(Date.now() / 1000);
    const state = buildState(
      {
        usableSyncAt: nowSec - 60,
        mode: "live",
        sourceUpdatedAtByPeg: { peggedAUD: nowSec - (48 * 3600) },
        sourceModeByPeg: { peggedAUD: "live" },
        sourceCadenceByPeg: { peggedAUD: "business-daily" },
        sourceDateByPeg: { peggedAUD: "2026-04-02" },
        consecutiveFallbackRuns: 0,
      },
      { peggedAUD: 0.64 },
    );

    expect(state).not.toBeNull();
    expect(getFxReferenceTypeFromState(state, "peggedAUD", 6 * 3600, nowSec)).toBe("fresh");
    expect(buildFxCacheStatus(state, 1800, nowSec).cacheStatus.sourceStatus).toBe("fresh");
  });

  it("flags 1 missed business-daily publish as degraded", () => {
    vi.setSystemTime(new Date("2026-04-07T18:00:00Z"));
    const nowSec = Math.floor(Date.now() / 1000);
    const state = buildState(
      {
        usableSyncAt: nowSec - 60,
        mode: "live",
        sourceUpdatedAtByPeg: { peggedAUD: nowSec - (5 * DAY_SECONDS) },
        sourceModeByPeg: { peggedAUD: "live" },
        sourceCadenceByPeg: { peggedAUD: "business-daily" },
        sourceDateByPeg: { peggedAUD: "2026-04-02" },
        consecutiveFallbackRuns: 0,
      },
      { peggedAUD: 0.64 },
    );

    expect(state).not.toBeNull();
    expect(buildFxCacheStatus(state, 1800, nowSec).cacheStatus.sourceStatus).toBe("degraded");
  });

  it("flags 2 missed business-daily publishes as stale", () => {
    vi.setSystemTime(new Date("2026-04-08T18:00:00Z"));
    const nowSec = Math.floor(Date.now() / 1000);
    const state = buildState(
      {
        usableSyncAt: nowSec - 60,
        mode: "live",
        sourceUpdatedAtByPeg: { peggedAUD: nowSec - (6 * DAY_SECONDS) },
        sourceModeByPeg: { peggedAUD: "live" },
        sourceCadenceByPeg: { peggedAUD: "business-daily" },
        sourceDateByPeg: { peggedAUD: "2026-04-02" },
        consecutiveFallbackRuns: 0,
      },
      { peggedAUD: 0.64 },
    );

    expect(state).not.toBeNull();
    expect(getFxReferenceTypeFromState(state, "peggedAUD", 6 * 3600, nowSec)).toBe("stale");
    expect(buildFxCacheStatus(state, 1800, nowSec).cacheStatus.sourceStatus).toBe("stale");
  });

  it("flags 1 normal business-daily publish lag as degraded", () => {
    vi.setSystemTime(new Date("2026-03-12T18:00:00Z"));
    const nowSec = Math.floor(Date.now() / 1000);
    const state = buildState(
      {
        usableSyncAt: nowSec - 60,
        mode: "live",
        sourceUpdatedAtByPeg: { peggedEUR: nowSec - (48 * 3600) },
        sourceModeByPeg: { peggedEUR: "live" },
        sourceCadenceByPeg: { peggedEUR: "business-daily" },
        sourceDateByPeg: { peggedEUR: "2026-03-11" },
        consecutiveFallbackRuns: 0,
      },
      { peggedEUR: 1.08 },
    );

    expect(state).not.toBeNull();
    expect(buildFxCacheStatus(state, 1800, nowSec).cacheStatus.sourceStatus).toBe("degraded");
  });

  it("keeps intraday degradation visible in health while treating it as stale for strict reference checks", () => {
    vi.setSystemTime(new Date("2026-03-11T08:00:00Z"));
    const nowSec = Math.floor(Date.now() / 1000);
    const state = buildState(
      {
        usableSyncAt: nowSec - 60,
        mode: "cached-fallback",
        sourceUpdatedAtByPeg: { peggedGOLD: nowSec - (8 * 3600) },
        sourceModeByPeg: { peggedGOLD: "cached" },
        sourceCadenceByPeg: { peggedGOLD: "intraday" },
        sourceDateByPeg: { peggedGOLD: null },
        consecutiveFallbackRuns: 1,
      },
      { peggedGOLD: 2900 },
    );

    expect(state).not.toBeNull();
    expect(getFxReferenceTypeFromState(state, "peggedGOLD", 6 * 3600, nowSec)).toBe("stale");
    expect(buildFxCacheStatus(state, 1800, nowSec).cacheStatus.sourceStatus).toBe("degraded");
  });

  it("keeps malformed metadata rates usable but never attaches fabricated provenance", () => {
    vi.setSystemTime(new Date("2026-03-11T08:00:00Z"));
    const nowSec = Math.floor(Date.now() / 1000);

    const state = hydrateFxRateState(
      { value: JSON.stringify({ peggedEUR: 1.08 }), updatedAt: nowSec - 60 },
      { value: "{bad json", updatedAt: nowSec - 60 },
    );

    expect(state).not.toBeNull();
    expect(state?.metadataIdentity).toBe("malformed");
    expect(state?.rates).toEqual({ peggedEUR: 1.08 });
    // The rates row's own publication clock remains the cache age...
    expect(state?.usableSyncAt).toBe(nowSec - 60);
    // ...but it is never substituted for a source observation time.
    expect(state?.sourceUpdatedAtByPeg.peggedEUR).toBeNull();
    expect(state?.sourceModeByPeg.peggedEUR).toBeUndefined();
    expect(getFxReferenceTypeFromState(state, "peggedEUR", 6 * 3600, nowSec)).toBe("stale");
  });

  it("returns null when the rates cache JSON is malformed", () => {
    const state = hydrateFxRateState(
      { value: "{bad json", updatedAt: 1_700_000_000 },
      null,
    );

    expect(state).toBeNull();
  });
});

const NOW_SEC = Math.floor(Date.parse("2026-03-11T08:00:00Z") / 1000);

function liveMeta(syncAt: number, sourceUpdatedAt: number | null = syncAt - 60): FxRatesMeta {
  return {
    usableSyncAt: syncAt,
    mode: "live",
    sourceUpdatedAtByPeg: { peggedEUR: sourceUpdatedAt },
    sourceModeByPeg: { peggedEUR: "live" },
    sourceCadenceByPeg: { peggedEUR: "intraday" },
    sourceDateByPeg: { peggedEUR: null },
    consecutiveFallbackRuns: 0,
  };
}

function verifiedRows(rates: Record<string, number>, meta: FxRatesMeta, updatedAt: number) {
  const ratesValue = JSON.stringify(rates);
  return {
    rates: { value: ratesValue, updatedAt },
    meta: { value: JSON.stringify({ ...meta, ratesSha256: sha256Hex(ratesValue) }), updatedAt },
  };
}

describe("fx-rate-state generation identity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("admits a digest-verified pair as one generation", () => {
    const rows = verifiedRows({ peggedEUR: 1.08 }, liveMeta(NOW_SEC - 60), NOW_SEC - 60);
    const state = hydrateFxRateState(rows.rates, rows.meta);

    expect(state?.metadataIdentity).toBe("verified");
    expect(getFxReferenceTypeFromState(state, "peggedEUR", 6 * 3600, NOW_SEC)).toBe("fresh");
    expect(buildFxCacheStatus(state, 1800, NOW_SEC)).toMatchObject({
      statusFloor: "healthy",
      cacheStatus: { healthy: true, degraded: false, degradedReason: null, sourceStatus: "fresh" },
    });
  });

  it.each([
    ["the metadata row belongs to an older publication", NOW_SEC - 1_860, undefined],
    ["the metadata row belongs to a newer publication", NOW_SEC - 30, undefined],
    // Same clock second, different run: only the content digest can tell them apart.
    ["an identical-second run published different rates", NOW_SEC - 60, { peggedEUR: 1.2 }],
  ] as const)("rejects the pair when %s", (_label, metaUpdatedAt, digestRates) => {
    const ratesValue = JSON.stringify({ peggedEUR: 1.08 });
    const state = hydrateFxRateState(
      { value: ratesValue, updatedAt: NOW_SEC - 60 },
      {
        value: JSON.stringify({
          ...liveMeta(metaUpdatedAt),
          ratesSha256: sha256Hex(digestRates ? JSON.stringify(digestRates) : ratesValue),
        }),
        updatedAt: metaUpdatedAt,
      },
    );

    expect(state?.metadataIdentity).toBe("generation-mismatch");
    expect(state?.rates).toEqual({ peggedEUR: 1.08 });
    expect(state?.usableSyncAt).toBe(NOW_SEC - 60);
    expect(state?.sourceUpdatedAtByPeg.peggedEUR).toBeNull();
    expect(getFxReferenceTypeFromState(state, "peggedEUR", 6 * 3600, NOW_SEC)).toBe("stale");
    expect(buildFxCacheStatus(state, 1800, NOW_SEC)).toMatchObject({
      statusFloor: "degraded",
      cacheStatus: {
        healthy: false,
        degraded: true,
        degradedReason: "fx-metadata-generation-mismatch",
        sourceStatus: "degraded",
      },
    });
  });

  it("rejects a legacy pre-digest metadata row whose timestamp does not match the rates row", () => {
    const state = hydrateFxRateState(
      { value: JSON.stringify({ peggedEUR: 1.08 }), updatedAt: NOW_SEC - 60 },
      { value: JSON.stringify(liveMeta(NOW_SEC - 1_860)), updatedAt: NOW_SEC - 1_860 },
    );

    expect(state?.metadataIdentity).toBe("generation-mismatch");
    expect(getFxReferenceTypeFromState(state, "peggedEUR", 6 * 3600, NOW_SEC)).toBe("stale");
  });

  it("admits a legacy pre-digest pair only when both rows share one publication clock", () => {
    const state = hydrateFxRateState(
      { value: JSON.stringify({ peggedEUR: 1.08 }), updatedAt: NOW_SEC - 60 },
      { value: JSON.stringify(liveMeta(NOW_SEC - 60)), updatedAt: NOW_SEC - 60 },
    );

    expect(state?.metadataIdentity).toBe("legacy-timestamp");
    expect(getFxReferenceTypeFromState(state, "peggedEUR", 6 * 3600, NOW_SEC)).toBe("fresh");
  });

  it("treats a corrupt digest as malformed metadata", () => {
    const state = hydrateFxRateState(
      { value: JSON.stringify({ peggedEUR: 1.08 }), updatedAt: NOW_SEC - 60 },
      { value: JSON.stringify({ ...liveMeta(NOW_SEC - 60), ratesSha256: "not-a-digest" }), updatedAt: NOW_SEC - 60 },
    );

    expect(state?.metadataIdentity).toBe("malformed");
    expect(buildFxCacheStatus(state, 1800, NOW_SEC).cacheStatus.degradedReason).toBe("fx-metadata-malformed");
  });

  it("never reports missing metadata as healthy even when the rates row is seconds old", () => {
    const state = hydrateFxRateState({ value: JSON.stringify({ peggedEUR: 1.08 }), updatedAt: NOW_SEC - 5 }, null);

    expect(state?.metadataIdentity).toBe("missing");
    expect(buildFxCacheStatus(state, 1800, NOW_SEC)).toMatchObject({
      statusFloor: "degraded",
      cacheStatus: { healthy: false, degraded: true, degradedReason: "fx-metadata-missing" },
    });
  });
});

describe("fx-rate-state shared per-peg admission", () => {
  function stateWith(meta: Partial<FxRatesMeta>, rates: Record<string, number>): FxRateState | null {
    const rows = verifiedRows(rates, {
      usableSyncAt: NOW_SEC - 60,
      mode: "live",
      sourceUpdatedAtByPeg: {},
      sourceModeByPeg: {},
      consecutiveFallbackRuns: 0,
      ...meta,
    }, NOW_SEC - 60);
    return hydrateFxRateState(rows.rates, rows.meta);
  }

  it("degrades health for a live metal without a source time, matching the pricing verdict", () => {
    const state = stateWith({
      sourceUpdatedAtByPeg: { peggedEUR: NOW_SEC - 600, peggedGOLD: null },
      sourceModeByPeg: { peggedEUR: "live", peggedGOLD: "live" },
      sourceCadenceByPeg: { peggedEUR: "intraday", peggedGOLD: "intraday" },
    }, { peggedEUR: 1.08, peggedGOLD: 2900 });

    expect(getFxReferenceTypeFromState(state, "peggedGOLD", 6 * 3600, NOW_SEC)).toBe("none");
    expect(getFxReferenceTypeFromState(state, "peggedEUR", 6 * 3600, NOW_SEC)).toBe("fresh");
    const status = buildFxCacheStatus(state, 1800, NOW_SEC);
    expect(status).toMatchObject({
      statusFloor: "degraded",
      cacheStatus: {
        healthy: false,
        degraded: true,
        degradedReason: "fx-source-provenance-unknown:peggedGOLD=source-time-missing",
        sourceStatus: "degraded",
      },
    });
    expect(status.warning).toContain("peggedGOLD (source-time-missing)");
  });

  it("names every peg without provenance and keeps a stale peg's stale verdict", () => {
    const state = stateWith({
      sourceUpdatedAtByPeg: { peggedEUR: NOW_SEC - 30 * 3600, peggedJPY: NOW_SEC - 60, peggedCHF: NOW_SEC + 3600 },
      sourceModeByPeg: { peggedEUR: "live", peggedCHF: "live" },
      sourceCadenceByPeg: { peggedEUR: "intraday", peggedJPY: "intraday", peggedCHF: "intraday" },
    }, { peggedEUR: 1.08, peggedJPY: 0.0067, peggedCHF: 1.1 });

    expect(getFxReferenceTypeFromState(state, "peggedJPY", 6 * 3600, NOW_SEC)).toBe("none");
    expect(getFxReferenceTypeFromState(state, "peggedCHF", 6 * 3600, NOW_SEC)).toBe("none");
    expect(buildFxCacheStatus(state, 1800, NOW_SEC)).toMatchObject({
      statusFloor: "stale",
      cacheStatus: {
        healthy: false,
        sourceStatus: "stale",
        degradedReason: "fx-source-provenance-unknown:peggedJPY=source-provenance-missing,peggedCHF=source-time-future",
      },
    });
  });
});

describe("fx-rate-state pair publication on real SQLite", () => {
  const fixtures = createLatestSchemaFixtureTracker();
  const RATES_A = { peggedEUR: 1.08 };
  const RATES_B = { peggedEUR: 1.09 };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
  });

  afterEach(() => {
    fixtures.closeAll();
    vi.useRealTimers();
  });

  /** "A"/"B" when the rates and their metadata are one generation, "unavailable" when explicitly unverifiable. */
  function generationOf(state: FxRateState | null, syncA: number, syncB: number): string {
    if (!state) return "absent";
    if (state.metadataIdentity !== "verified") return state.metadataIdentity === "legacy-timestamp" ? "legacy" : "unavailable";
    const ratesGeneration = state.rates.peggedEUR === RATES_A.peggedEUR ? "A" : state.rates.peggedEUR === RATES_B.peggedEUR ? "B" : "?";
    const metaGeneration = state.usableSyncAt === syncA ? "A" : state.usableSyncAt === syncB ? "B" : "?";
    return ratesGeneration === metaGeneration ? ratesGeneration : `split:${ratesGeneration}/${metaGeneration}`;
  }

  it("reads both-old while a competing publication commits between reader statements", async () => {
    const { db } = fixtures.open();
    const syncA = NOW_SEC - 1_800;
    const syncB = NOW_SEC - 60;
    await persistFxRateState(db, RATES_A, liveMeta(syncA), syncA);

    // Every cache read after the first waits for a competing publication to commit,
    // so any multi-statement reader would straddle the two generations.
    let cacheReads = 0;
    let competingPublished = false;
    const straddlingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "prepare") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
            get(stmt, stmtProp, stmtReceiver) {
              if (stmtProp === "bind") return (...args: unknown[]) => wrap(stmt.bind(...args));
              if ((stmtProp === "all" || stmtProp === "first") && sql.includes("FROM cache")) {
                return async (...args: unknown[]) => {
                  if (cacheReads++ > 0 && !competingPublished) {
                    competingPublished = true;
                    await persistFxRateState(db, RATES_B, liveMeta(syncB), syncB);
                  }
                  return (stmt[stmtProp] as (...callArgs: unknown[]) => Promise<unknown>)(...args);
                };
              }
              return Reflect.get(stmt, stmtProp, stmtReceiver);
            },
          });
          return wrap(target.prepare(sql));
        };
      },
    });

    const straddled = await loadFxRateState(straddlingDb);
    expect(cacheReads).toBe(1);
    expect(generationOf(straddled, syncA, syncB)).toBe("A");

    await persistFxRateState(db, RATES_B, liveMeta(syncB), syncB);
    expect(generationOf(await loadFxRateState(db), syncA, syncB)).toBe("B");
  });

  it("rolls the whole pair back when the metadata statement fails", async () => {
    const { db, sqlite } = fixtures.open();
    const syncA = NOW_SEC - 1_800;
    const syncB = NOW_SEC - 60;
    await persistFxRateState(db, RATES_A, liveMeta(syncA), syncA);
    sqlite.exec(`
      CREATE TEMP TRIGGER fail_fx_meta_insert BEFORE INSERT ON cache WHEN NEW.key = 'fx-rates-meta'
        BEGIN SELECT RAISE(ABORT, 'injected metadata write failure'); END;
      CREATE TEMP TRIGGER fail_fx_meta_update BEFORE UPDATE ON cache WHEN NEW.key = 'fx-rates-meta'
        BEGIN SELECT RAISE(ABORT, 'injected metadata write failure'); END;
    `);

    await expect(persistFxRateState(db, RATES_B, liveMeta(syncB), syncB)).rejects.toThrow(/injected metadata write failure/);

    expect(generationOf(await loadFxRateState(db), syncA, syncB)).toBe("A");
    expect(sqlite.prepare("SELECT updated_at FROM cache WHERE key = 'fx-rates'").get()).toEqual({ updated_at: syncA });
  });

  it("refuses to half-write into a legacy split pair and recovers with the next newer publication", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
    // Legacy split: rates from a newer run, metadata from an older one.
    insert.run("fx-rates", JSON.stringify({ peggedEUR: 1.07 }), NOW_SEC - 600);
    insert.run("fx-rates-meta", JSON.stringify(liveMeta(NOW_SEC - 3_600)), NOW_SEC - 3_600);
    expect((await loadFxRateState(db))?.metadataIdentity).toBe("generation-mismatch");

    // A run between the two clocks may not advance the older metadata row alone.
    const between = await persistFxRateState(db, RATES_A, liveMeta(NOW_SEC - 1_800), NOW_SEC - 1_800);
    expect(between).toEqual({ written: false, skippedBecauseNewer: true });
    expect(sqlite.prepare("SELECT updated_at FROM cache WHERE key = 'fx-rates-meta'").get()).toEqual({ updated_at: NOW_SEC - 3_600 });
    expect((await loadFxRateState(db))?.metadataIdentity).toBe("generation-mismatch");

    const newer = await persistFxRateState(db, RATES_B, liveMeta(NOW_SEC - 60), NOW_SEC - 60);
    expect(newer).toEqual({ written: true, skippedBecauseNewer: false });
    expect(generationOf(await loadFxRateState(db), NOW_SEC - 1_800, NOW_SEC - 60)).toBe("B");
  });

  it("keeps identical-second publications coherent and detects a same-second partial overwrite", async () => {
    const { db } = fixtures.open();
    const sameSecond = NOW_SEC - 60;
    const metaA = { ...liveMeta(sameSecond), sources: { run: "A" } };
    const metaB = { ...liveMeta(sameSecond), sources: { run: "B" } };

    await persistFxRateState(db, RATES_A, metaA, sameSecond);
    await persistFxRateState(db, RATES_B, metaB, sameSecond);
    const replaced = await loadFxRateState(db);
    expect(replaced?.metadataIdentity).toBe("verified");
    expect(replaced?.rates).toEqual(RATES_B);
    expect(replaced?.sources).toEqual({ run: "B" });

    // A writer that lands only the rates row at the same clock second cannot pass
    // as matched: the surviving metadata describes different bytes.
    await setCacheIfNewer(db, "fx-rates", JSON.stringify(RATES_A), sameSecond);
    const partial = await loadFxRateState(db);
    expect(partial?.metadataIdentity).toBe("generation-mismatch");
    expect(getFxReferenceTypeFromState(partial, "peggedEUR", 6 * 3600, NOW_SEC)).toBe("stale");
  });
});

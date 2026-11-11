import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { DAY_SECONDS, HOUR_SECONDS } from "@shared/lib/time-constants";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import {
  LEGACY_BEST_YIELD_SOURCE_KEY,
  YIELD_HISTORY_OWNERSHIP_HANDOFFS,
} from "../../lib/yield/yield-history-ownership-handoffs";
import { buildYieldHistoryEvaluationInputsCooperative } from "../yield-sync/history-evidence";
import { loadYieldHistorySnapshots } from "../yield-sync/history-repository";
import { purgeYieldHistoryOwnershipHandoffs } from "../yield-sync/history-repair";
import type { YieldHistorySnapshotRow } from "../yield-sync/history-repository";
import { evaluateYieldSourcesCooperative, type EvaluateYieldSourcesResult } from "../yield-sync/evaluation";
import { baseEvaluationInput, resolvedYield } from "./yield-evaluation.test-support";
import { cleanupFalseLinkedVariantSourceSwitches } from "../yield-sync/history-repair";
import { drainDecisionRowsBeforeCutoff, drainRowsBeforeCutoff, pruneYieldTables } from "../yield-sync/history";
import { classifyDecisionRetention } from "../yield-sync/publication-decisions";
import type { EvaluatedYieldSource } from "../yield-sync/evaluation";

function createDb(): { sqlite: DatabaseSync; db: D1Database } {
  return createLatestSchemaSqlite();
}

function insertHistory(
  sqlite: DatabaseSync,
  row: {
    stablecoinId: string;
    sourceKey: string;
    recordedAt: number;
    isBest?: number;
    apy?: number;
    sourceTvlUsd?: number | null;
    publicationState?: string | null;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO yield_history (
      stablecoin_id, source_key, recorded_at, is_best, apy, apy_base,
      source_tvl_usd, data_source, yield_source, yield_type, exchange_rate,
      publication_state
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'defillama', 'Test', 'lending', NULL, ?)`,
    )
    .run(
      row.stablecoinId,
      row.sourceKey,
      row.recordedAt,
      row.isBest ?? 0,
      row.apy ?? 1,
      row.sourceTvlUsd ?? null,
      row.publicationState === undefined ? "published" : row.publicationState,
    );
}

describe("loadYieldHistorySnapshots", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  it("keeps published and legacy anchors when newer staged rows compete", async () => {
    const fixture = createDb();
    sqlite = fixture.sqlite;
    for (const [stablecoinId, publicationState] of [["coin-a", "published"], ["coin-b", null]] as const) {
      insertHistory(sqlite, { stablecoinId, sourceKey: "source-a", recordedAt: 100, isBest: 1, apy: 4, sourceTvlUsd: 10, publicationState });
      for (const [recordedAt, state] of [[200, "staged"], [300, "failed"]] as const) {
        insertHistory(sqlite, { stablecoinId, sourceKey: "source-a", recordedAt, isBest: 1, apy: 99, sourceTvlUsd: 999, publicationState: state });
      }
    }
    insertHistory(sqlite, { stablecoinId: "staged-only", sourceKey: "source-a", recordedAt: 200, isBest: 1, publicationState: "staged" });
    expect(sqlite.prepare("SELECT publication_state FROM yield_history WHERE stablecoin_id = 'coin-b' AND recorded_at = 100").get()).toEqual({ publication_state: null });

    const sourceKeysByStablecoin = new Map<string, ReadonlySet<string>>(
      ["coin-a", "coin-b", "staged-only"].map(
        (id) => [id, new Set(["source-a"])] as const,
      ),
    );
    const snapshots = await loadYieldHistorySnapshots(
      fixture.db,
      ["coin-a", "coin-b", "staged-only"],
      1_000,
      300,
      { sourceKeysByStablecoin },
    );
    const identities = (rows: typeof snapshots.historyRows) =>
      rows.map((row) => [
        row.stablecoin_id,
        row.source_key,
        row.recorded_at,
        row.source_tvl_usd,
      ]);
    const expected = [
      ["coin-a", "source-a", 100, 10],
      ["coin-b", "source-a", 100, 10],
    ];
    expect(identities(snapshots.historyRows)).toEqual(expected);
    expect(identities(snapshots.prevTvlRows)).toEqual(expected);
    expect(identities(snapshots.prevBestRows)).toEqual(expected);
    expect(snapshots.historyRows.map((row) => row.apy)).toEqual([4, 4]);
    expect(snapshots.prevBestRows.map((row) => row.apy)).toEqual([4, 4]);
  });

  it("returns one previous TVL row per stablecoin/source bucket", async () => {
    const fixture = createDb();
    sqlite = fixture.sqlite;

    insertHistory(sqlite, { stablecoinId: "coin-a", sourceKey: "source-a", recordedAt: 100, sourceTvlUsd: 10 });
    insertHistory(sqlite, { stablecoinId: "coin-a", sourceKey: "source-a", recordedAt: 200, sourceTvlUsd: 20 });
    insertHistory(sqlite, { stablecoinId: "coin-a", sourceKey: "source-b", recordedAt: -40 * DAY_SECONDS, sourceTvlUsd: 30 });
    insertHistory(sqlite, { stablecoinId: "coin-b", sourceKey: "source-c", recordedAt: 170, sourceTvlUsd: 40 });
    insertHistory(sqlite, { stablecoinId: "coin-b", sourceKey: "source-c", recordedAt: 190, sourceTvlUsd: 50 });

    insertHistory(sqlite, { stablecoinId: "coin-a", sourceKey: "source-a", recordedAt: 300 });
    const sourceKeysByStablecoin = new Map<string, Set<string>>([
      ["coin-a", new Set(["source-a", "source-b"])],
      ["coin-b", new Set(["source-c"])],
    ]);
    const snapshots = await loadYieldHistorySnapshots(fixture.db, ["coin-a", "coin-b"], 1_000, 300, {
      sourceKeysByStablecoin,
    });

    expect(snapshots.prevTvlRows.map((row) => [row.stablecoin_id, row.source_key, row.recorded_at, row.source_tvl_usd])).toEqual([
      ["coin-a", "source-a", 200, 20],
      ["coin-a", "source-b", -40 * DAY_SECONDS, 30],
      ["coin-b", "source-c", 190, 50],
    ]);
  });

  it("breaks previous-best timestamp ties by latest rowid and excludes the cutoff", async () => {
    const fixture = createDb();
    sqlite = fixture.sqlite;

    insertHistory(sqlite, { stablecoinId: "coin-a", sourceKey: "source-z", recordedAt: 200, isBest: 1, sourceTvlUsd: 10 });
    insertHistory(sqlite, { stablecoinId: "coin-a", sourceKey: "source-a", recordedAt: 200, isBest: 1, sourceTvlUsd: 20 });
    insertHistory(sqlite, { stablecoinId: "coin-b", sourceKey: "source-b", recordedAt: 150, isBest: 1, sourceTvlUsd: 30 });

    insertHistory(sqlite, { stablecoinId: "coin-a", sourceKey: "at-cutoff", recordedAt: 1_000, isBest: 1 });
    const snapshots = await loadYieldHistorySnapshots(fixture.db, ["coin-a", "coin-b"], 1_000, 300, { sourceKeysByStablecoin: new Map() });

    expect(snapshots.prevBestRows.map((row) => [row.stablecoin_id, row.source_key, row.recorded_at])).toEqual([
      ["coin-a", "source-a", 200],
      ["coin-b", "source-b", 150],
    ]);
  });

  it("excludes ownership-handoff rows before selecting previous-best anchors", async () => {
    const fixture = createDb();
    sqlite = fixture.sqlite;

    insertHistory(sqlite, { stablecoinId: "usde-ethena", sourceKey: "valid-source", recordedAt: 100, isBest: 1, sourceTvlUsd: 10 });
    insertHistory(sqlite, { stablecoinId: "usde-ethena", sourceKey: LEGACY_BEST_YIELD_SOURCE_KEY, recordedAt: 200, isBest: 1, sourceTvlUsd: 20 });

    const snapshots = await loadYieldHistorySnapshots(fixture.db, ["usde-ethena"], 1_000, 300, {
      sourceKeysByStablecoin: new Map([["usde-ethena", new Set(["valid-source", LEGACY_BEST_YIELD_SOURCE_KEY])]]),
    });

    expect(snapshots.historyRows.map((row) => row.source_key)).toEqual(["valid-source"]);
    expect(snapshots.prevTvlRows.map((row) => row.source_key)).toEqual(["valid-source"]);
    expect(snapshots.prevBestRows).toHaveLength(1);
    expect(snapshots.prevBestRows[0]?.source_key).toBe("valid-source");
    expect(snapshots.prevBestRows[0]?.recorded_at).toBe(100);
  });

  it("keeps every read under D1's bind cap across large coin and pair chunks", async () => {
    const fixture = createLatestSchemaSqlite({ onAll: (sql) => {
      expect(sql.match(/\?/g)?.length ?? 0).toBeLessThanOrEqual(100);
    } });
    sqlite = fixture.sqlite;
    const ids = Array.from({ length: 90 }, (_, i) => `coin-${i}`);
    for (const stablecoinId of ids) {
      insertHistory(sqlite, { stablecoinId, sourceKey: "source-a", recordedAt: 100, isBest: 1, sourceTvlUsd: 10 });
      insertHistory(sqlite, { stablecoinId, sourceKey: "source-b", recordedAt: 100, isBest: 0, sourceTvlUsd: 5 });
    }
    const pacedReads: number[] = [];
    const snapshots = await loadYieldHistorySnapshots(fixture.db, ids, 1_000, 300, {
      chunkSize: 90,
      paceHistoryRead: async (readMs) => { pacedReads.push(readMs); },
      sourceKeysByStablecoin: new Map(ids.map((id) => [id, new Set(["source-a", "source-b"])])),
    });
    // One idle gap per history-window read: the selected read and four pair chunks.
    expect(pacedReads).toHaveLength(5);
    expect(snapshots.historyRows).toHaveLength(180);
    expect(snapshots.prevTvlRows).toHaveLength(180);
    expect(snapshots.prevBestRows.map((row) => row.stablecoin_id)).toEqual(ids);
    expect(snapshots.previousTvlRowsTruncated).toBe(false);
  });

  it("waits out one spent D1 window on an idempotent history read instead of failing the run", async () => {
    vi.useFakeTimers();
    try {
      let tripped = false;
      const fixture = createLatestSchemaSqlite({ onAll: (sql) => {
        if (tripped || !sql.includes("history-window")) return;
        tripped = true;
        throw new Error("D1 DB is overloaded. Too many resources consumed within a 10 second window");
      } });
      sqlite = fixture.sqlite;
      insertHistory(sqlite, { stablecoinId: "coin-a", sourceKey: "source-a", recordedAt: 100, isBest: 1 });
      let settled = false;
      const pending = loadYieldHistorySnapshots(fixture.db, ["coin-a"], 1_000, 300, {
        sourceKeysByStablecoin: new Map(), yieldToEventLoop: () => Promise.resolve(),
      }).finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(5_000);
      // Still inside the spent window: a sub-second backoff would have retried already.
      expect([tripped, settled]).toEqual([true, false]);
      await vi.advanceTimersByTimeAsync(6_001);
      expect((await pending).historyRows).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps source-key-scoped previous TVL history rows and reports truncation", async () => {
    const fixture = createDb();
    sqlite = fixture.sqlite;

    insertHistory(sqlite, { stablecoinId: "coin-a", sourceKey: "source-a", recordedAt: 100, sourceTvlUsd: 10 });
    insertHistory(sqlite, { stablecoinId: "coin-a", sourceKey: "source-b", recordedAt: 110, sourceTvlUsd: 20 });
    insertHistory(sqlite, { stablecoinId: "coin-a", sourceKey: "source-c", recordedAt: 120, sourceTvlUsd: 30 });

    const snapshots = await loadYieldHistorySnapshots(fixture.db, ["coin-a"], 1_000, 300, {
      maxPreviousTvlRows: 2,
      sourceKeysByStablecoin: new Map([["coin-a", new Set(["source-a", "source-b", "source-c"])]]),
    });

    expect(snapshots.prevTvlRows.map((row) => row.source_key)).toEqual(["source-a", "source-b"]);
    expect(snapshots.previousTvlRowsTruncated).toBe(true);
  });
});

describe("cleanupFalseLinkedVariantSourceSwitches", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  it("uses only the seven-day clean-generation window for reclassification", async () => {
    let cleanupSql = "";
    const fixture = createLatestSchemaSqlite({ onRun: (sql) => { cleanupSql = sql; } });
    sqlite = fixture.sqlite;
    const startSec = 1_800_000_000;
    const floorSec = startSec - 7 * DAY_SECONDS;
    const linkedKey = "linked-variant:child:onchain:child";
    const insertGeneration = sqlite.prepare(
      `INSERT INTO yield_publication_generations (generation_id, started_at, state, created_at)
       VALUES (?, ?, 'published', ?)`,
    );
    const insertDecision = sqlite.prepare(
      `INSERT INTO yield_source_decisions (
         generation_id, stablecoin_id, selected_source_key, selected_confidence_tier,
         selected_data_source, selected_apy_30d, selected_reason,
         previous_best_source_key, source_switch, alternatives_json, created_at, retention_reason
       ) VALUES (?, ?, ?, 'curated', 'test', 4.2, 'test', ?, ?, '[]', ?, ?)`,
    );
    const addDecision = (
      generationId: string,
      stablecoinId: string,
      previousBestSourceKey: string,
      sourceSwitch: number,
      createdAt: number,
      retentionReason: string,
    ) => {
      insertGeneration.run(generationId, createdAt, createdAt);
      insertDecision.run(
        generationId,
        stablecoinId,
        linkedKey,
        previousBestSourceKey,
        sourceSwitch,
        createdAt,
        retentionReason,
      );
    };

    addDecision("in-false", "coin-in", "onchain:coin-in", 1, floorSec + 100, "trend");
    addDecision("in-clean-1", "coin-in", linkedKey, 0, floorSec + 200, "audit");
    addDecision("in-clean-2", "coin-in", linkedKey, 0, floorSec + 300, "audit");
    addDecision("out-old-clean", "coin-out", linkedKey, 0, floorSec - 200, "audit");
    addDecision("out-false", "coin-out", "onchain:coin-out", 1, floorSec - 100, "trend");
    addDecision("out-clean-1", "coin-out", linkedKey, 0, floorSec + 400, "audit");

    expect(await cleanupFalseLinkedVariantSourceSwitches(fixture.db, startSec)).toBe(1);
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${cleanupSql}`).all(floorSec);
    expect(plan.some((row) => /SEARCH d USING INDEX idx_yield_source_decisions_created_coin \(created_at>/.test(String(row.detail)))).toBe(true);
    expect(
      sqlite
        .prepare(
          `SELECT generation_id, source_switch, retention_reason
             FROM yield_source_decisions
            WHERE generation_id IN ('in-false', 'out-false')
            ORDER BY generation_id`,
        )
        .all(),
    ).toEqual([
      { generation_id: "in-false", source_switch: 0, retention_reason: "audit" },
      { generation_id: "out-false", source_switch: 1, retention_reason: "trend" },
    ]);
  });

  it.each([
    { name: "one clean generation", sources: ["linked-variant:child:onchain:child"], repaired: 0 },
    { name: "an intervening other source", sources: ["linked-variant:child:onchain:child", "defillama:pool", "linked-variant:child:onchain:child"], repaired: 0 },
    { name: "a different child identity", sources: ["linked-variant:other:onchain:other", "linked-variant:child:onchain:child"], repaired: 0 },
    { name: "a different underlying source key", sources: ["linked-variant:child:defillama:pool", "linked-variant:child:onchain:child"], repaired: 0 },
    { name: "a latest nonlinked source", sources: ["linked-variant:child:onchain:child", "linked-variant:child:onchain:child", "defillama:pool"], repaired: 0 },
    { name: "a latest source switch", sources: ["linked-variant:child:onchain:child", "linked-variant:child:onchain:child"], latestSwitch: 1, repaired: 0 },
    { name: "two consecutive identical clean identities", sources: ["linked-variant:child:onchain:child", "linked-variant:child:onchain:child"], repaired: 1 },
    { name: "an unpublished intervening decision", sources: ["linked-variant:child:onchain:child", "linked-variant:child:onchain:child"], unpublished: true, repaired: 1 },
  ])("repairs only the verified alias with $name", async ({ sources, latestSwitch, unpublished, repaired }) => {
    const fixture = createDb();
    sqlite = fixture.sqlite;
    const startSec = 1_800_000_000;
    const floorSec = startSec - 7 * DAY_SECONDS;
    const linkedKey = "linked-variant:child:onchain:child";
    const addDecision = (
      id: string, key: string, previousKey: string, sourceSwitch: number, createdAt: number, state = "published",
    ) => {
      sqlite!.prepare(
        `INSERT INTO yield_publication_generations (generation_id, started_at, state, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(id, createdAt, state, createdAt);
      sqlite!.prepare(
        `INSERT INTO yield_source_decisions (
           generation_id, stablecoin_id, selected_source_key, selected_confidence_tier,
           selected_data_source, selected_apy_30d, selected_reason,
           previous_best_source_key, source_switch, alternatives_json, created_at, retention_reason
         ) VALUES (?, 'coin', ?, 'curated', 'test', 4.2, 'test', ?, ?, '[]', ?, ?)`,
      ).run(id, key, previousKey, sourceSwitch, createdAt, sourceSwitch ? "trend" : "audit");
    };
    addDecision("alias", linkedKey, "onchain:coin", 1, floorSec - 100);
    addDecision("other-child", "linked-variant:other:onchain:other", "onchain:coin", 1, floorSec - 100);
    addDecision("other-source", "linked-variant:child:defillama:pool", "onchain:coin", 1, floorSec - 100);
    addDecision("real-switch", linkedKey, "defillama:pool", 1, floorSec - 100);
    sources.forEach((key, index) => {
      addDecision(`clean-${index}`, key, key, index === sources.length - 1 ? latestSwitch ?? 0 : 0, floorSec + 100 + index);
    });
    if (unpublished) addDecision("staged", "defillama:pool", linkedKey, 1, floorSec + 200, "staged");
    const persistedRows = sqlite.prepare(
      "SELECT generation_id, selected_source_key, previous_best_source_key, source_switch, retention_reason FROM yield_source_decisions ORDER BY generation_id",
    );
    const before = persistedRows.all();

    expect(await cleanupFalseLinkedVariantSourceSwitches(fixture.db, startSec)).toBe(repaired);
    expect(persistedRows.all()).toEqual(before.map((row) =>
      row.generation_id === "alias" && repaired
        ? { ...row, source_switch: 0, retention_reason: "audit" }
        : row,
    ));
    expect(await cleanupFalseLinkedVariantSourceSwitches(fixture.db, startSec)).toBe(0);
  });
});

describe("purgeYieldHistoryOwnershipHandoffs", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  it("deletes handed-off keys from both the raw and the daily history tier", async () => {
    const fixture = createDb();
    sqlite = fixture.sqlite;
    const [onchainKey, handedOffKey] = YIELD_HISTORY_OWNERSHIP_HANDOFFS["usde-ethena"];
    insertHistory(sqlite, { stablecoinId: "usde-ethena", sourceKey: LEGACY_BEST_YIELD_SOURCE_KEY, recordedAt: 300 });
    insertHistory(sqlite, { stablecoinId: "usde-ethena", sourceKey: handedOffKey, recordedAt: 200 });
    insertHistory(sqlite, { stablecoinId: "usde-ethena", sourceKey: onchainKey, recordedAt: 100 });
    insertHistory(sqlite, { stablecoinId: "usde-ethena", sourceKey: "valid-source", recordedAt: 150 });
    insertHistory(sqlite, { stablecoinId: "susde-ethena", sourceKey: LEGACY_BEST_YIELD_SOURCE_KEY, recordedAt: 100 });

    const insertDaily = sqlite.prepare(
      `INSERT INTO yield_history_daily
         (stablecoin_id, source_key, snapshot_date, recorded_at, is_best, apy, data_source, publication_state)
       VALUES (?, ?, 86400, ?, 1, ?, 'defillama', 'published')`,
    );
    insertDaily.run("usde-ethena", LEGACY_BEST_YIELD_SOURCE_KEY, 300, 4.0);
    insertDaily.run("usde-ethena", handedOffKey, 200, 5.0);
    insertDaily.run("usde-ethena", "valid-source", 150, 3.0);
    insertDaily.run("susde-ethena", LEGACY_BEST_YIELD_SOURCE_KEY, 100, 6.0);

    await purgeYieldHistoryOwnershipHandoffs(fixture.db);

    // Raw tier: every suppressed key family for the handed-off coin is gone;
    // other coins and the coin's non-handoff source are untouched.
    expect(
      sqlite.prepare("SELECT stablecoin_id, source_key FROM yield_history ORDER BY stablecoin_id, source_key").all(),
    ).toEqual([
      { stablecoin_id: "susde-ethena", source_key: LEGACY_BEST_YIELD_SOURCE_KEY },
      { stablecoin_id: "usde-ethena", source_key: "valid-source" },
    ]);

    // Daily tier: the same key set is purged there too, while non-handoff
    // sources of the same coin survive. Without this pass, de-registering a
    // handoff would instantly re-expose a year of materialized daily rows.
    expect(
      sqlite
        .prepare("SELECT stablecoin_id, source_key FROM yield_history_daily ORDER BY stablecoin_id, source_key")
        .all(),
    ).toEqual([
      { stablecoin_id: "susde-ethena", source_key: LEGACY_BEST_YIELD_SOURCE_KEY },
      { stablecoin_id: "usde-ethena", source_key: "valid-source" },
    ]);
  });
});

describe("pruneYieldTables retention", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  it("prunes raw history at the 30-day raw policy while keeping the year of daily closes", async () => {
    const fixture = createDb();
    sqlite = fixture.sqlite;
    const nowSec = 1_800_000_000;

    insertHistory(sqlite, { stablecoinId: "coin-a", sourceKey: "source-a", recordedAt: nowSec - 10 * DAY_SECONDS });
    insertHistory(sqlite, { stablecoinId: "coin-a", sourceKey: "source-a", recordedAt: nowSec - 40 * DAY_SECONDS });
    sqlite
      .prepare(
        `INSERT INTO yield_history_daily
           (stablecoin_id, source_key, snapshot_date, recorded_at, is_best, apy, data_source, publication_state)
         VALUES ('coin-a', 'source-a', ?, ?, 1, 4.0, 'defillama', 'published')`,
      )
      .run(nowSec - 100 * DAY_SECONDS, nowSec - 100 * DAY_SECONDS);

    await pruneYieldTables(fixture.db, nowSec, { allowDestructiveCleanup: false });

    expect(sqlite.prepare("SELECT recorded_at FROM yield_history").all()).toEqual([
      { recorded_at: nowSec - 10 * DAY_SECONDS },
    ]);
    expect(sqlite.prepare("SELECT snapshot_date FROM yield_history_daily ORDER BY snapshot_date").all()).toEqual([
      { snapshot_date: nowSec - 100 * DAY_SECONDS },
      { snapshot_date: Math.floor((nowSec - 40 * DAY_SECONDS) / DAY_SECONDS) * DAY_SECONDS },
    ]);
  });

  it("keeps the whole trailing raw day until its daily close is materialized", async () => {
    const fixture = createDb();
    sqlite = fixture.sqlite;
    const day = Math.floor(1_800_000_000 / DAY_SECONDS) * DAY_SECONDS;
    const observation = day - 30 * DAY_SECONDS + 60;
    insertHistory(sqlite, { stablecoinId: "coin-a", sourceKey: "source-a", recordedAt: observation });
    await pruneYieldTables(fixture.db, day + 23 * 3600, { allowDestructiveCleanup: false });
    expect(sqlite.prepare("SELECT recorded_at FROM yield_history").all()).toEqual([{ recorded_at: observation }]);
    await pruneYieldTables(fixture.db, day + DAY_SECONDS, { allowDestructiveCleanup: false });
    expect(sqlite.prepare("SELECT recorded_at FROM yield_history").all()).toEqual([]);
    expect(sqlite.prepare("SELECT recorded_at FROM yield_history_daily").all()).toEqual([{ recorded_at: observation }]);
  });

  it("resumes a large retention backlog across bounded statements instead of one fatal delete", async () => {
    // Regression: v8.43 moved the raw-history cutoff from 365d to 30d, putting
    // the entire 30d-365d backlog in scope at once. One unbounded DELETE over
    // millions of rows exceeded the D1 per-query CPU limit, failing the whole
    // publication run with `D1_ERROR: D1 DB exceeded its CPU time limit` — and
    // it failed the same way every hour. The drain must be bounded and resumable.
    const fixture = createDb();
    sqlite = fixture.sqlite;
    const nowSec = 1_800_000_000;
    const cutoffSec = nowSec - 30 * DAY_SECONDS;
    for (let index = 0; index < 12_000; index += 1) {
      insertHistory(sqlite, {
        stablecoinId: `coin-${index % 20}`,
        sourceKey: "source-a",
        recordedAt: nowSec - 40 * DAY_SECONDS - index,
      });
    }
    const countRows = (): number => {
      const row = sqlite?.prepare("SELECT COUNT(*) AS n FROM yield_history").get();
      if (!row || typeof row !== "object" || !("n" in row) || typeof row.n !== "number") {
        throw new Error("unexpected sqlite count shape");
      }
      return row.n;
    };
    expect(countRows()).toBe(12_000);

    const drain = () =>
      drainRowsBeforeCutoff({
        db: fixture.db,
        table: "yield_history",
        statementTag: "history-retention-delete",
        timeColumn: "recorded_at",
        cutoffSec,
        frozenIdsList: [],
        frozenClause: "",
        maxRows: 5_000,
      });

    // Three bounded passes, each capped, and the third finds only the remainder.
    const first = await drain();
    expect(first.deleted).toBe(5_000);
    expect(first.budgetExhausted).toBe(true);
    expect(countRows()).toBe(7_000);

    const second = await drain();
    expect(second.deleted).toBe(5_000);
    expect(countRows()).toBe(2_000);

    const third = await drain();
    expect(third.deleted).toBe(2_000);
    expect(third.budgetExhausted).toBe(false);
    expect(countRows()).toBe(0);
  });
  it("bounds decision retention by eligible rows while preserving trend keepers", async () => {
    const fixture = createDb();
    sqlite = fixture.sqlite;
    const nowSec = 1_800_000_000;
    const cutoffSec = nowSec - 30 * DAY_SECONDS;
    const keeperCount = 4_280;
    const eligibleCount = 6_000;
    const insertDecision = sqlite.prepare(
      `INSERT INTO yield_source_decisions (
         generation_id, stablecoin_id, selected_source_key, selected_confidence_tier,
         selected_data_source, selected_apy_30d, selected_reason,
         source_switch, alternatives_json, created_at, retention_reason
       ) VALUES (?, 'keeper-coin', 'source', 'curated', 'test', 4.2, 'test', 0, '[]', ?, ?)`,
    );
    const firstCreatedAt = cutoffSec - keeperCount - eligibleCount - 10;
    for (let index = 0; index < keeperCount; index += 1) {
      insertDecision.run(`keeper-${index}`, firstCreatedAt + index, "trend");
    }
    for (let index = 0; index < eligibleCount; index += 1) {
      insertDecision.run(`eligible-${index}`, firstCreatedAt + keeperCount + index, "audit");
    }

    const first = await drainDecisionRowsBeforeCutoff({
      db: fixture.db,
      cutoffSec,
      maxRows: 5_000,
    });
    expect(first).toEqual({ deleted: 5_000, budgetExhausted: true });
    expect(
      sqlite
        .prepare(
          "SELECT retention_reason, COUNT(*) AS count FROM yield_source_decisions GROUP BY retention_reason ORDER BY retention_reason",
        )
        .all(),
    ).toEqual([
      { retention_reason: "audit", count: 1_000 },
      { retention_reason: "trend", count: keeperCount },
    ]);

    const second = await drainDecisionRowsBeforeCutoff({
      db: fixture.db,
      cutoffSec,
      maxRows: 5_000,
    });
    expect(second).toEqual({ deleted: 1_000, budgetExhausted: false });
    expect(
      sqlite
        .prepare("SELECT retention_reason, COUNT(*) AS count FROM yield_source_decisions GROUP BY retention_reason")
        .all(),
    ).toEqual([{ retention_reason: "trend", count: keeperCount }]);
  });
});

describe("yield history observation clock admission", () => {
  const START_SEC = 1_776_729_600;
  const PRIOR_SOURCE = "defillama:coin-a:prior";
  const CHALLENGER_SOURCE = "defillama:coin-a:challenger";

  async function publishSwitchSeries(seedFutureObservation: boolean) {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const insert = sqlite.prepare(
        `INSERT INTO yield_history (
           stablecoin_id, source_key, recorded_at, is_best, apy,
           source_tvl_usd, data_source, yield_source, yield_type,
           publication_state
         ) VALUES ('coin-a', ?, ?, 1, ?, 1000000, 'defillama', ?, 'lending-vault', 'published')`,
      );
      // Durable prior era, then one challenger publication that this run extends
      // into its second publication: the valid series publishes one switch.
      insert.run(PRIOR_SOURCE, START_SEC - 3 * DAY_SECONDS, 5, "Prior source");
      insert.run(PRIOR_SOURCE, START_SEC - 3 * DAY_SECONDS + HOUR_SECONDS, 5, "Prior source");
      insert.run(CHALLENGER_SOURCE, START_SEC - DAY_SECONDS, 6, "Challenger source");
      if (seedFutureObservation) {
        // A skewed upstream clock (e.g. Zephyr's x-last-success-at) is a future
        // observation, not an ordered sample; it must not enter the 30d window.
        insert.run(PRIOR_SOURCE, START_SEC + DAY_SECONDS, 5, "Prior source");
      }

      const snapshots = await loadYieldHistorySnapshots(
        db,
        ["coin-a"],
        START_SEC,
        START_SEC - 7 * DAY_SECONDS,
        {
          sourceKeysByStablecoin: new Map([
            ["coin-a", new Set([PRIOR_SOURCE, CHALLENGER_SOURCE])],
          ]),
        },
      );
      const historyInputs = await buildYieldHistoryEvaluationInputsCooperative(snapshots, {
        yieldToEventLoop: () => Promise.resolve(),
      });
      const result = await evaluateYieldSourcesCooperative(baseEvaluationInput({
        resolved: [
          { id: "coin-a", symbol: "A", yield: resolvedYield({ sourceKey: PRIOR_SOURCE, currentApy: 5 }) },
          { id: "coin-a", symbol: "A", yield: resolvedYield({ sourceKey: CHALLENGER_SOURCE, currentApy: 6 }) },
        ],
        ...historyInputs,
      }), { yieldToEventLoop: () => Promise.resolve() });
      return result.evaluatedSources.find((source) => source.sourceKey === CHALLENGER_SOURCE);
    } finally {
      sqlite.close();
    }
  }

  it("does not let a future-dated best row reorder the source-switch series", async () => {
    const withoutFutureObservation = await publishSwitchSeries(false);
    const withFutureObservation = await publishSwitchSeries(true);

    expect(withoutFutureObservation?.sourceSwitchCount30d).toBe(1);
    expect(withFutureObservation?.sourceSwitchCount30d)
      .toBe(withoutFutureObservation?.sourceSwitchCount30d);
  });
});

function row(overrides: Partial<YieldHistorySnapshotRow>): YieldHistorySnapshotRow {
  return {
    stablecoin_id: "coin-a",
    source_key: "source-a",
    recorded_at: 1_700_000_000,
    is_best: 0,
    apy: 4.2,
    apy_base: null,
    source_tvl_usd: 1_000_000,
    data_source: "defillama",
    yield_source: "Source A",
    yield_type: "lending",
    exchange_rate: null,
    ...overrides,
  };
}

describe("yield coordinator history", () => {
  it("reports each history phase in order before yielding at row cadence and phase completion", async () => {
    const trace: string[] = [];
    const result = await buildYieldHistoryEvaluationInputsCooperative({
      historyRows: [100, 200, 300].map((recorded_at) => row({ recorded_at, is_best: 1 })),
      prevTvlRows: [row({ source_tvl_usd: 9_000 }), row({ source_tvl_usd: 8_000 })],
      prevBestRows: [row({ is_best: 1 })],
    }, {
      yieldEveryRows: 2,
      onProgress: ({ phase, rowsDone, rowsTotal }) => { trace.push(`${phase}:${rowsDone}/${rowsTotal}`); },
      yieldToEventLoop: async () => { trace.push("yield"); },
    });
    expect(trace).toEqual([
      "history-rows:2/3", "yield", "history-rows:3/3", "yield",
      "previous-tvl:2/2", "yield", "previous-best:1/1", "yield", "source-switches:1/1", "yield",
    ]);
    expect(result.sourceHistory.get("coin-a::source-a")?.map((entry) => entry.recorded_at)).toEqual([100, 200, 300]);
    expect(result.prevTvlBySource.get("coin-a::source-a")).toBe(9_000);
    expect(result.prevBestSourceKeyByCoin.get("coin-a")).toBe("source-a");
    expect(result.sourceSwitchCount30dByCoin.get("coin-a")).toBe(0);
  });

  it("aborts after yielding without admitting the next history row or later phases", async () => {
    const controller = new AbortController();
    const trace: string[] = [];
    await expect(buildYieldHistoryEvaluationInputsCooperative({
      historyRows: [row({}), row({})],
      prevTvlRows: [row({})],
      prevBestRows: [row({})],
    }, {
      signal: controller.signal,
      yieldEveryRows: 1,
      onProgress: ({ phase, rowsDone }) => { trace.push(`${phase}:${rowsDone}`); },
      yieldToEventLoop: async () => { trace.push("yield"); controller.abort(); },
    })).rejects.toThrow();
    expect(trace).toEqual(["history-rows:1", "yield"]);
  });

  it("normalizes source, legacy, on-chain, TVL, and previous-best history inputs", async () => {
    const result = await buildYieldHistoryEvaluationInputsCooperative({
      historyRows: [
        row({}),
        row({
          source_key: null,
          data_source: "onchain",
          exchange_rate: 1.01,
        }),
        row({
          stablecoin_id: "lusd-liquity",
          source_key: "bprotocol-lqty-only",
          data_source: "onchain",
          exchange_rate: 1.02,
        }),
      ],
      prevTvlRows: [
        row({ source_tvl_usd: 9_000 }),
        row({ source_key: null, source_tvl_usd: 7_000 }),
        row({ source_tvl_usd: 8_000 }),
      ],
      prevBestRows: [
        row({ is_best: 1 }),
      ],
    }, { yieldToEventLoop: () => Promise.resolve() });

    expect(result.sourceHistory.get("coin-a::source-a")).toHaveLength(1);
    expect(result.legacyHistoryById.get("coin-a")?.[0]?.source_key).toBe("legacy-best");
    expect(result.onChainCompatibilityHistoryById.get("coin-a")).toHaveLength(1);
    expect(result.legacyDeterministicOnChainHistoryById.get("lusd-liquity")).toHaveLength(1);
    expect(result.prevTvlBySource.get("coin-a::source-a")).toBe(9_000);
    expect(result.legacyPrevTvlById.get("coin-a")).toBe(7_000);
    expect(result.prevBestSourceKeyByCoin.get("coin-a")).toBe("source-a");
  });

  it("counts selected-source switches across 30d history rows, collapsing one-publication gaps", async () => {
    const switchesFor = async (rows: YieldHistorySnapshotRow[]) =>
      (await buildYieldHistoryEvaluationInputsCooperative({ historyRows: rows, prevTvlRows: [], prevBestRows: [] }, { yieldToEventLoop: () => Promise.resolve() }))
        .sourceSwitchCount30dByCoin.get("coin-a");

    // Durable runs: A A B B A A -> two switches.
    expect(await switchesFor([
      row({ is_best: 1, recorded_at: 100 }),
      row({ is_best: 1, recorded_at: 200 }),
      row({ source_key: "source-b", is_best: 1, recorded_at: 300 }),
      row({ source_key: "source-b", is_best: 1, recorded_at: 400 }),
      row({ is_best: 1, recorded_at: 500 }),
      row({ is_best: 1, recorded_at: 600 }),
    ])).toBe(2);

    // B2: a one-publication out-and-back is a fetch gap, not two switches.
    expect(await switchesFor([
      row({ is_best: 1, recorded_at: 100 }),
      row({ is_best: 1, recorded_at: 200 }),
      row({ source_key: "source-b", is_best: 1, recorded_at: 300 }),
      row({ is_best: 1, recorded_at: 400 }),
      row({ is_best: 1, recorded_at: 500 }),
    ])).toBe(0);

    // Non-best rows never participate in the selected-source series.
    expect(await switchesFor([
      row({ is_best: 1, recorded_at: 100 }),
      row({ source_key: "source-b", recorded_at: 200 }),
      row({ is_best: 1, recorded_at: 300 }),
    ])).toBe(0);
  });

  it("skips the legacy-best sentinel in the durable selected-source series", async () => {
    const switchesFor = async (rows: YieldHistorySnapshotRow[]) =>
      (await buildYieldHistoryEvaluationInputsCooperative({ historyRows: rows, prevTvlRows: [], prevBestRows: [] }, { yieldToEventLoop: () => Promise.resolve() }))
        .sourceSwitchCount30dByCoin.get("coin-a");

    // A coin that only ever published legacy rows and then gains source-aware
    // rows has not switched sources: `isRealSourceSwitch` never charges the
    // sentinel, so the 30d count must not charge it either.
    expect(await switchesFor([
      row({ source_key: "legacy-best", is_best: 1, recorded_at: 100 }),
      row({ source_key: "legacy-best", is_best: 1, recorded_at: 200 }),
      row({ is_best: 1, recorded_at: 300 }),
      row({ is_best: 1, recorded_at: 400 }),
    ])).toBe(0);

    // A durable legacy era between two runs of one real source is an unchanged
    // source, not two switches.
    expect(await switchesFor([
      row({ is_best: 1, recorded_at: 100 }),
      row({ is_best: 1, recorded_at: 200 }),
      row({ source_key: "legacy-best", is_best: 1, recorded_at: 300 }),
      row({ source_key: "legacy-best", is_best: 1, recorded_at: 400 }),
      row({ is_best: 1, recorded_at: 500 }),
      row({ is_best: 1, recorded_at: 600 }),
    ])).toBe(0);

    // A real switch still counts once when it straddles a legacy era.
    expect(await switchesFor([
      row({ is_best: 1, recorded_at: 100 }),
      row({ is_best: 1, recorded_at: 200 }),
      row({ source_key: "legacy-best", is_best: 1, recorded_at: 300 }),
      row({ source_key: "source-b", is_best: 1, recorded_at: 400 }),
      row({ source_key: "source-b", is_best: 1, recorded_at: 500 }),
    ])).toBe(1);
  });

  it("publishes the switch series including the current run, not a transient increment", async () => {
    const priorKey = "defillama:coin-a:prior";
    const challengerKey = "defillama:coin-a:challenger";
    const run = async (bestRows: YieldHistorySnapshotRow[], sourceKeys: string[]) => {
      const inputs = await buildYieldHistoryEvaluationInputsCooperative({
        historyRows: bestRows,
        prevTvlRows: [],
        prevBestRows: [row({ source_key: priorKey, is_best: 1 })],
      }, { yieldToEventLoop: () => Promise.resolve() });
      return await evaluateYieldSourcesCooperative(baseEvaluationInput({
        resolved: sourceKeys.map((sourceKey, index) => ({
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield({ sourceKey, currentApy: index === 0 ? 5 : 6 }),
        })),
        ...inputs,
      }), { yieldToEventLoop: () => Promise.resolve() });
    };
    const published = (result: EvaluateYieldSourcesResult, sourceKey: string) =>
      result.evaluatedSources.find((source) => source.sourceKey === sourceKey);
    const priorRun = (recordedAt: number) => row({ source_key: priorKey, is_best: 1, recorded_at: recordedAt });

    // Durable switch: the challenger wins twice in a row. The first publication
    // sees one run of it, so the collapsed series still reads 0; the second run
    // is the second consecutive publication and charges exactly one switch.
    const durableFirst = published(await run([priorRun(100), priorRun(200)], [priorKey, challengerKey]), challengerKey);
    const durableSecond = published(
      await run(
        [priorRun(100), priorRun(200), row({ source_key: challengerKey, is_best: 1, recorded_at: 300 })],
        [priorKey, challengerKey],
      ),
      challengerKey,
    );
    expect(durableFirst?.sourceSwitchCount30d).toBe(0);
    expect(durableSecond?.sourceSwitchCount30d).toBe(1);
    // The published penalty is derived from that same count.
    expect((durableSecond?.sourceRiskPenalty ?? 0) - (durableFirst?.sourceRiskPenalty ?? 0)).toBeCloseTo(0.1, 6);

    // One-publication excursion: the challenger wins once and the prior source
    // returns. Both publications read 0 — the count never publishes an increment
    // the next run erases.
    const excursion = published(await run([priorRun(100), priorRun(200)], [priorKey, challengerKey]), challengerKey);
    const returned = published(
      await run(
        [priorRun(100), priorRun(200), row({ source_key: challengerKey, is_best: 1, recorded_at: 300 })],
        [priorKey],
      ),
      priorKey,
    );
    expect(excursion?.sourceSwitchCount30d).toBe(0);
    expect(returned?.sourceSwitchCount30d).toBe(0);
  });

  it("treats a resolved-but-rejected previous winner as no incumbent for both arms", async () => {
    const incumbent = "defillama:coin-a:prior";
    const challenger = "defillama:coin-a:challenger";
    // History with a positive APY against a zero current APY is the
    // `source-zero-vs-history` rejection: the incumbent is resolved this run but
    // not publishable — exactly the fact the 30d count already reads.
    const bestRows = [
      row({ source_key: incumbent, is_best: 1, recorded_at: 10, apy: 5 }),
      row({ source_key: challenger, is_best: 1, recorded_at: 100 }),
      row({ source_key: challenger, is_best: 1, recorded_at: 200 }),
    ];
    const evaluate = async (includeIncumbent: boolean) => {
      const inputs = await buildYieldHistoryEvaluationInputsCooperative({
        historyRows: bestRows,
        prevTvlRows: [],
        prevBestRows: [row({ source_key: incumbent, is_best: 1 })],
      }, { yieldToEventLoop: () => Promise.resolve() });
      const entries = [
        ...(includeIncumbent
          ? [{ sourceKey: incumbent, currentApy: 0, apyBase: 0 }]
          : []),
        { sourceKey: challenger, currentApy: 6, apyBase: 6 },
      ];
      return await evaluateYieldSourcesCooperative(baseEvaluationInput({
        resolved: entries.map((entry) => ({
          id: "coin-a",
          symbol: "A",
          yield: resolvedYield(entry),
        })),
        ...inputs,
      }), { yieldToEventLoop: () => Promise.resolve() });
    };

    const withoutIncumbent = await evaluate(false);
    const withRejectedIncumbent = await evaluate(true);
    // Same winner and same charged count: a rejected incumbent neither arms the
    // B3 arbitration margin nor blocks the switch series.
    expect(withRejectedIncumbent.bestSourceKeyByCoin.get("coin-a")).toBe(challenger);
    expect(withoutIncumbent.bestSourceKeyByCoin.get("coin-a")).toBe(challenger);
    expect(withRejectedIncumbent.sourceSwitches).toBe(withoutIncumbent.sourceSwitches);
    const rejectedRow = withRejectedIncumbent.evaluatedSources.find(
      (source) => source.sourceKey === incumbent,
    );
    expect(rejectedRow?.rejected).toBe(true);
    // The winner carries the transient-missing record: the rejected incumbent is
    // not a live candidate for either arm.
    const winnerRow = withRejectedIncumbent.evaluatedSources.find(
      (source) => source.sourceKey === challenger,
    );
    expect(winnerRow?.anomalies).toContain("previous-source-transiently-missing");
  });

  it("preserves linked on-chain identities across consecutive generations", async () => {
    const linkedSourceKey = "linked-variant:child-coin:onchain:child-coin";
    const result = await buildYieldHistoryEvaluationInputsCooperative({
      historyRows: [
        row({
          stablecoin_id: "parent-coin",
          source_key: linkedSourceKey,
          data_source: "onchain",
          exchange_rate: 1.01,
          is_best: 1,
          recorded_at: 100,
        }),
        row({
          stablecoin_id: "parent-coin",
          source_key: linkedSourceKey,
          data_source: "onchain",
          exchange_rate: 1.02,
          is_best: 1,
          recorded_at: 200,
        }),
      ],
      prevTvlRows: [],
      prevBestRows: [row({
        stablecoin_id: "parent-coin",
        source_key: linkedSourceKey,
        data_source: "onchain",
        exchange_rate: 1.02,
        is_best: 1,
      })],
    }, { yieldToEventLoop: () => Promise.resolve() });

    expect(result.prevBestSourceKeyByCoin.get("parent-coin")).toBe(linkedSourceKey);
    expect(result.sourceSwitchCount30dByCoin.get("parent-coin")).toBe(0);
  });
});

describe("yield history set loading", () => {
  it("loads previous TVL only for requested pairs while retaining selected history", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const insert = sqlite.prepare(
        `INSERT INTO yield_history (
           stablecoin_id, source_key, recorded_at, is_best, apy,
           source_tvl_usd, data_source, publication_state
         ) VALUES ('coin-a', ?, ?, ?, 4.2, ?, 'test', 'published')`,
      );
      insert.run("source-a", 100, 0, 10);
      insert.run("source-a", 200, 0, 20);
      insert.run("source-b", 150, 1, 30);
      insert.run("source-c", 175, 0, 40);

      const snapshots = await loadYieldHistorySnapshots(
        db,
        ["coin-a"],
        1_000,
        300,
        {
          sourceKeysByStablecoin: new Map([
            ["coin-a", new Set(["source-a"])],
          ]),
        },
      );

      expect(
        snapshots.historyRows.map((row) => [row.source_key, row.recorded_at]),
      ).toEqual([
        ["source-a", 100],
        ["source-b", 150],
        ["source-a", 200],
      ]);
      expect(
        snapshots.prevTvlRows.map((row) => [row.source_key, row.recorded_at]),
      ).toEqual([["source-a", 200]]);
      expect(snapshots.previousTvlRowsTruncated).toBe(false);
    } finally {
      sqlite.close();
    }
  });
});

function decisionSource(
  sourceKey: string,
  anomalies: string[] = [],
): EvaluatedYieldSource {
  return {
    sourceKey,
    confidenceTier: "curated",
    anomalies,
    rejected: false,
  } as EvaluatedYieldSource;
}

describe("yield decision retention parity", () => {
  it("drains classifier-generated audit rows and retains trend and episode rows", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const source = decisionSource("source-a");
      const classifications = [
        classifyDecisionRetention({
          sourceSwitch: false,
          source,
          candidates: [source],
        }),
        classifyDecisionRetention({
          sourceSwitch: true,
          source,
          candidates: [source],
        }),
        classifyDecisionRetention({
          sourceSwitch: false,
          source,
          candidates: [decisionSource("source-a", ["source-stale"])],
        }),
      ];
      expect(classifications.map((row) => row.retentionReason)).toEqual([
        "audit",
        "trend",
        "episode",
      ]);

      const insert = sqlite.prepare(
        `INSERT INTO yield_source_decisions (
           generation_id, stablecoin_id, selected_source_key,
           selected_confidence_tier, selected_data_source, selected_apy_30d,
           selected_reason, source_switch, alternatives_json, created_at,
           retention_reason, trend_fingerprint
         ) VALUES (?, 'coin-a', 'source-a', 'curated', 'test', 4.2,
                   'test', ?, '[]', 100, ?, ?)`,
      );
      for (const [index, classification] of classifications.entries()) {
        insert.run(
          `generation-${index}`,
          classification.retentionReason === "trend" ? 1 : 0,
          classification.retentionReason,
          classification.trendFingerprint,
        );
      }

      expect(await drainDecisionRowsBeforeCutoff({ db, cutoffSec: 200 })).toEqual({
        deleted: 1,
        budgetExhausted: false,
      });
      expect(
        sqlite
          .prepare(
            "SELECT retention_reason FROM yield_source_decisions ORDER BY retention_reason",
          )
          .all(),
      ).toEqual([
        { retention_reason: "episode" },
        { retention_reason: "trend" },
      ]);
    } finally {
      sqlite.close();
    }
  });
});

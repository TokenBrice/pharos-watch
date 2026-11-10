import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker, createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import {
  getMaxSyncAge,
  getReserveCompositionRow,
  getReserveSyncState,
  loadReserveCompositionRowMap,
  loadReserveSyncStateMap,
} from "../store-read";
import {
  loadLatestNonSkippedReserveAttempt,
  loadReserveSyncAttemptTimeline,
  loadReserveSyncReliabilityRollup,
} from "../store-history-read";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

function insertAttempt(
  sqlite: ReturnType<typeof createLatestSchemaSqlite>["sqlite"],
  args: {
    stablecoinId: string; attemptedAt: number;
    adapterKey: string; status: string;
    warnings?: string | null; lastError?: string | null;
    metadata?: string; attemptId?: string | null;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO reserve_sync_attempt_history
         (stablecoin_id, attempted_at, adapter_key, breaker_key, status, warnings, last_error, metadata, attempt_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.stablecoinId,
      args.attemptedAt,
      args.adapterKey,
      `live-reserves:${args.adapterKey}`,
      args.status,
      args.warnings ?? null,
      args.lastError ?? null,
      args.metadata ?? "{}",
      args.attemptId ?? null,
    );
}

describe("store-history-read", () => {
  it("returns the newest-N attempt timeline for one coin with parsed failure metadata", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      insertAttempt(sqlite, { stablecoinId: "usdc-circle", attemptedAt: 1000, adapterKey: "circle", status: "ok",
        metadata: JSON.stringify({ diag: { durationMs: 42 } }), attemptId: "a1" });
      insertAttempt(sqlite, { stablecoinId: "usdc-circle", attemptedAt: 1001, adapterKey: "circle", status: "error",
        warnings: JSON.stringify([{ code: "network", message: "down", severity: "warning", effect: "degraded" }]),
        lastError: "fetch failed", metadata: JSON.stringify({ failureCategory: "network", diag: { durationMs: 7 } }), attemptId: "a2" });
      insertAttempt(sqlite, { stablecoinId: "other-coin", attemptedAt: 1002, adapterKey: "other", status: "ok", attemptId: "a3" });

      const timeline = await loadReserveSyncAttemptTimeline(db, "usdc-circle");

      expect(timeline).toHaveLength(2);
      expect(timeline[0]).toEqual({
        stablecoinId: "usdc-circle", attemptedAt: 1001, adapterKey: "circle", breakerKey: "live-reserves:circle",
        attemptId: "a2", status: "error", failureCategory: "network", warningCodes: ["network"], lastError: "fetch failed", durationMs: 7,
      });
      expect(timeline[1]).toMatchObject({ attemptId: "a1", status: "ok", failureCategory: null, warningCodes: [], durationMs: 42 });
    } finally {
      sqlite.close();
    }
  });

  it("caps the timeline limit and treats malformed payloads as empty", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      for (let index = 0; index < 5; index++) {
        insertAttempt(sqlite, { stablecoinId: "usdc-circle", attemptedAt: 1000 + index, adapterKey: "circle", status: "ok",
          warnings: "{not-json", metadata: "{not-json" });
      }

      const timeline = await loadReserveSyncAttemptTimeline(db, "usdc-circle", 3);

      expect(timeline).toHaveLength(3);
      expect(timeline.map((entry) => entry.attemptedAt)).toEqual([1004, 1003, 1002]);
      expect(timeline[0]).toMatchObject({ failureCategory: null, warningCodes: [], durationMs: null });
    } finally {
      sqlite.close();
    }
  });

  it("returns the newest non-skipped attempt so circuit skips cannot inherit an older failure", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      insertAttempt(sqlite, { stablecoinId: "stbt-matrixdock", attemptedAt: 1000, adapterKey: "matrixdock-stbt", status: "error",
        warnings: JSON.stringify([{ code: "stale-source-data", message: "old", severity: "warning", effect: "degraded" }]),
        lastError: "HTTP 403", metadata: JSON.stringify({ failureCategory: "http" }) });
      insertAttempt(sqlite, { stablecoinId: "stbt-matrixdock", attemptedAt: 1001, adapterKey: "matrixdock-stbt", status: "ok",
        metadata: JSON.stringify({ diag: { durationMs: 3 } }) });
      insertAttempt(sqlite, { stablecoinId: "stbt-matrixdock", attemptedAt: 1002, adapterKey: "matrixdock-stbt", status: "skipped",
        metadata: JSON.stringify({ failureCategory: "circuit-open" }) });

      const latest = await loadLatestNonSkippedReserveAttempt(db, "stbt-matrixdock");

      expect(latest).toMatchObject({ attemptedAt: 1001, status: "ok", failureCategory: null, warningCodes: [] });
      expect(await loadLatestNonSkippedReserveAttempt(db, "unknown-coin")).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it.each([
    ["metadata", { metadata: "{not-json" }],
    ["warnings", { warnings: "{not-json" }],
    ["warning entries", { warnings: '[{"message":"no code"}]' }],
  ])("refuses a latest attempt whose %s is malformed", async (_label, overrides) => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      insertAttempt(sqlite, { stablecoinId: "usdc-circle", attemptedAt: 1000, adapterKey: "circle", status: "error", ...overrides });

      expect(await loadLatestNonSkippedReserveAttempt(db, "usdc-circle")).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("rolls up per-adapter reliability counts within the retention window", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      for (const status of ["ok", "ok", "degraded", "error"] as const) {
        insertAttempt(sqlite, {
          stablecoinId: `coin-${status}-${Math.random()}`,
          attemptedAt: 2000,
          adapterKey: "adapter-a",
          status,
        });
      }
      insertAttempt(sqlite, { stablecoinId: "coin-s1", attemptedAt: 2000, adapterKey: "adapter-b", status: "skipped" });
      insertAttempt(sqlite, { stablecoinId: "coin-s2", attemptedAt: 2000, adapterKey: "adapter-b", status: "skipped" });
      // Outside the window: excluded.
      insertAttempt(sqlite, { stablecoinId: "coin-old", attemptedAt: 999, adapterKey: "adapter-c", status: "ok" });

      const rollup = await loadReserveSyncReliabilityRollup(db, 3000, 1000);

      expect(rollup).toEqual([
        { adapterKey: "adapter-a", attempts: 4, ok: 2, degraded: 1, degradedByDesign: 0, error: 1, skipped: 0, successRate: 0.5 },
        { adapterKey: "adapter-b", attempts: 2, ok: 0, degraded: 0, degradedByDesign: 0, error: 0, skipped: 2, successRate: 0 },
      ]);

      // Corrupt or unreadable memo recomputes; a valid one serves the hour.
      sqlite.exec("UPDATE cache SET value = 'x'");
      expect(await loadReserveSyncReliabilityRollup(db, 3000, 1000)).toEqual(rollup);
      sqlite.exec("DELETE FROM reserve_sync_attempt_history");
      expect(await loadReserveSyncReliabilityRollup(db, 3001, 1000)).toEqual(rollup);
      expect(await loadReserveSyncReliabilityRollup(db, 6601, 1000)).toEqual([]);
      sqlite.exec("DROP TABLE cache");
      expect(await loadReserveSyncReliabilityRollup(db, 6602)).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("counts degraded attempts whose only degraded warnings are structural as by design", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const structural = { code: "nav-portfolio-composition-unverified", message: "m", severity: "warning", effect: "degraded" };
    const operational = { ...structural, code: "source-stale" };
    const info = { ...structural, code: "primary-fallback-used", severity: "info", effect: "info" };
    try {
      const rows: Array<[string, unknown[] | string | null]> = [
        ["ok", null],
        ["degraded", [structural]],
        ["degraded", [structural, info]],
        ["degraded", [structural, operational]],
        // Legacy rows without `effect` decode as degraded unless info severity.
        ["degraded", [structural, { code: "source-stale", message: "m", severity: "warning" }]],
        ["degraded", [structural, { code: "note", message: "m", severity: "info" }]],
        ["degraded", [structural, { code: "no-message", severity: "info", effect: "info" }]],
        ["degraded", [structural, { code: "blank", message: "\t\n", severity: "info", effect: "info" }]],
        ["degraded", [operational]],
        ["degraded", [{ ...structural, code: undefined }]],
        ["degraded", ["nav-portfolio-composition-unverified"]],
        ["degraded", "not json"],
        ["degraded", null],
        ["error", [structural]],
      ];
      rows.forEach(([status, warnings], index) => insertAttempt(sqlite, {
        stablecoinId: `coin-${index}`, attemptedAt: 2000, adapterKey: "chainlink-nav", status,
        warnings: Array.isArray(warnings) ? JSON.stringify(warnings) : warnings,
      }));

      const rollup = await loadReserveSyncReliabilityRollup(db, 3000, 1000);

      expect(rollup).toEqual([
        { adapterKey: "chainlink-nav", attempts: 14, ok: 1, degraded: 12, degradedByDesign: 3, error: 1, skipped: 0, successRate: 4 / 14 },
      ]);
    } finally {
      sqlite.close();
    }
  });
});

describe("reserve store reads", () => {
  it("selects requested identities and preserves unknown success separately from attempted sync age", async () => {
    const { sqlite, db } = fixtures.open();
    const insert = sqlite.prepare("INSERT INTO reserve_sync_state (stablecoin_id, adapter_key, breaker_key, last_attempted_at, last_success_at, last_status, warning_count, warnings, metadata, last_attempt_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run("a", "adapter-a", "breaker-a", 900, null, "error", 1, JSON.stringify([{ code: "source-unavailable", message: "offline" }]), JSON.stringify({ failureCategory: "fetch" }), "attempt-a");
    insert.run("b", "adapter-b", "breaker-b", 950, 950, "ok", 0, null, "{}", "attempt-b");
    expect(await getReserveSyncState(db, "absent")).toBeNull();
    expect(await getReserveSyncState(db, "a")).toMatchObject({
      stablecoinId: "a", lastSuccessAt: null, lastStatus: "error", lastAttemptId: "attempt-a",
      metadata: { failureCategory: "fetch" }, warnings: [{ code: "source-unavailable", message: "offline" }],
    });
    expect([...await loadReserveSyncStateMap(db, ["b", "absent"])].map(([id]) => id)).toEqual(["b"]);
    expect((await loadReserveSyncStateMap(db, [])).size).toBe(0);
    expect((await loadReserveSyncStateMap(db)).size).toBe(2);
    expect(await getMaxSyncAge(db, 1000, ["a", "b", "a"])).toBe(100);
    expect(await getMaxSyncAge(db, 1000, ["a", "absent"])).toBe(Infinity);
    expect(await getMaxSyncAge(db, 1000, [])).toBe(Infinity);
    sqlite.exec("UPDATE reserve_sync_state SET last_attempted_at = NULL WHERE stablecoin_id = 'b'");
    expect(await getMaxSyncAge(db, 1000, ["b"])).toBe(Infinity);
  });

  it("returns only stored composition identities without inventing an absent snapshot", async () => {
    const { sqlite, db } = fixtures.open();
    const insert = sqlite.prepare("INSERT INTO reserve_composition (stablecoin_id, slices, fetched_at, source, attempt_id) VALUES (?, ?, ?, ?, ?)");
    insert.run("a", '[{"name":"Cash","pct":100,"risk":"low"}]', 900, "adapter-a", "attempt-a");
    insert.run("b", "[]", 950, "adapter-b", "attempt-b");
    expect(await getReserveCompositionRow(db, "a")).toMatchObject({ stablecoin_id: "a", fetched_at: 900, source: "adapter-a", attempt_id: "attempt-a" });
    expect(await getReserveCompositionRow(db, "absent")).toBeNull();
    expect([...await loadReserveCompositionRowMap(db, ["a", "absent"])].map(([id]) => id)).toEqual(["a"]);
    expect((await loadReserveCompositionRowMap(db)).size).toBe(2);
    expect((await loadReserveCompositionRowMap(db, [])).size).toBe(0);
  });

  it("propagates unavailable required state instead of reporting a healthy empty map", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec("DROP TABLE reserve_sync_state");
    await expect(loadReserveSyncStateMap(db)).rejects.toThrow("reserve_sync_state");
    await expect(getMaxSyncAge(db, 1000, ["a"])).rejects.toThrow("reserve_sync_state");
  });
});

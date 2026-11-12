import { afterEach, describe, expect, it, vi } from "vitest";
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
  type ReserveSyncAttemptTimelineEntry as Attempt,
} from "../store-history-read";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); vi.useRealTimers(); });

async function load(db: D1Database, now: number) {
  return (await import("../store-history-read")).loadReserveSyncReliabilityRollup(db, now, 1000);
}
async function refresh(db: D1Database, now: number, remaining = 20_000) {
  const { refreshReserveSyncReliabilityRollup: renew } = await import("../store-history-read");
  const result = renew(db, Date.now() + remaining, undefined, now, 1000);
  await vi.advanceTimersByTimeAsync(12_000);
  return result;
}

function insertAttempt(
  sqlite: ReturnType<typeof createLatestSchemaSqlite>["sqlite"],
  { stablecoinId = "usdc-circle", attemptedAt = 1000, adapterKey = "circle", status = "ok",
    warnings = null, lastError = null, metadata = "{}", attemptId = null }: {
    warnings?: string | null; metadata?: string;
  } & Partial<Attempt>,
): void {
  sqlite
    .prepare(
      `INSERT INTO reserve_sync_attempt_history
         (stablecoin_id, attempted_at, adapter_key, breaker_key, status, warnings, last_error, metadata, attempt_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      stablecoinId, attemptedAt, adapterKey, `live-reserves:${adapterKey}`,
      status, warnings, lastError, metadata, attemptId,
    );
}

describe("store-history-read", () => {
  it("returns the newest-N attempt timeline for one coin with parsed failure metadata", async () => {
    const { sqlite, db } = fixtures.open();
    insertAttempt(sqlite, {
      metadata: '{"diag":{"durationMs":42}}', attemptId: "a1" });
    insertAttempt(sqlite, { attemptedAt: 1001, status: "error",
      warnings: JSON.stringify([{ code: "network", message: "down", severity: "warning", effect: "degraded" }]),
      lastError: "fetch failed", metadata: '{"failureCategory":"network","diag":{"durationMs":7}}', attemptId: "a2" });
    insertAttempt(sqlite, { stablecoinId: "other-coin", attemptedAt: 1002, adapterKey: "other", attemptId: "a3" });
    const timeline = await loadReserveSyncAttemptTimeline(db, "usdc-circle");
    expect(timeline).toHaveLength(2);
    expect(timeline[0]).toEqual({
      stablecoinId: "usdc-circle", attemptedAt: 1001, adapterKey: "circle", breakerKey: "live-reserves:circle",
      attemptId: "a2", status: "error", failureCategory: "network", warningCodes: ["network"], lastError: "fetch failed", durationMs: 7,
    });
    expect(timeline[1]).toMatchObject({ attemptId: "a1", status: "ok", failureCategory: null, warningCodes: [], durationMs: 42 });
  });

  it("caps the timeline limit and treats malformed payloads as empty", async () => {
    const { sqlite, db } = fixtures.open();
    for (let index = 0; index < 5; index++) {
      insertAttempt(sqlite, { attemptedAt: 1000 + index, status: "ok",
        warnings: "{not-json", metadata: "{not-json" });
    }
    const timeline = await loadReserveSyncAttemptTimeline(db, "usdc-circle", 3);
    expect(timeline).toHaveLength(3);
    expect(timeline.map((entry) => entry.attemptedAt)).toEqual([1004, 1003, 1002]);
    expect(timeline[0]).toMatchObject({ failureCategory: null, warningCodes: [], durationMs: null });
  });

  it("returns the newest non-skipped attempt so circuit skips cannot inherit an older failure", async () => {
    const { sqlite, db } = fixtures.open();
    insertAttempt(sqlite, { status: "error",
      warnings: JSON.stringify([{ code: "stale-source-data", message: "old", severity: "warning", effect: "degraded" }]),
      lastError: "HTTP 403", metadata: '{"failureCategory":"http"}'  });
    insertAttempt(sqlite, { attemptedAt: 1001,
      metadata: '{"diag":{"durationMs":3}}'  });
    insertAttempt(sqlite, { attemptedAt: 1002, status: "skipped",
      metadata: JSON.stringify({ failureCategory: "circuit-open" }) });
    const latest = await loadLatestNonSkippedReserveAttempt(db, "usdc-circle");
    expect(latest).toMatchObject({ attemptedAt: 1001, status: "ok", failureCategory: null, warningCodes: [] });
    expect(await loadLatestNonSkippedReserveAttempt(db, "unknown-coin")).toBeNull();
  });

  it.each([
    ["metadata", { metadata: "{not-json" }],
    ["warnings", { warnings: "{not-json" }],
    ["warning entries", { warnings: '[{"message":"no code"}]' }],
  ])("refuses a latest attempt whose %s is malformed", async (_label, overrides) => {
    const { sqlite, db } = fixtures.open();
    insertAttempt(sqlite, { status: "error", ...overrides });
    expect(await loadLatestNonSkippedReserveAttempt(db, "usdc-circle")).toBeNull();
  });

  it.each([0, 1, 4])("rolls up and guards reliability refreshes with %i memo write failures", async (failures) => {
    vi.useFakeTimers();
    vi.resetModules();
    let writes = 0, failScan = false, failMarker = false;
    const order: string[] = [];
    const scan = vi.fn(() => { expect(order.pop()).toBe("marker"); if (failScan) throw new Error("scan failed"); });
    const { sqlite, db } = createLatestSchemaSqlite({
      onAll: (sql) => { if (sql.startsWith("WITH attempts")) scan(); },
      onRun: (sql) => {
        if (sql.includes("WHERE cache.updated_at")) {
          if (failMarker) throw new Error("marker failed");
          order.push("marker");
        } else if (writes++ < failures) throw new Error("D1 DB is overloaded");
      },
    });
    try {
      const prepare = vi.spyOn(db, "prepare");
      const cacheRead = ["SELECT key, value, updated_at FROM cache WHERE key IN (?)"];
      await expect(load(db, 3000)).rejects.toThrow("unavailable");
      expect(prepare.mock.calls.map(([sql]) => sql)).toEqual(cacheRead);
      for (const [adapterKey, statuses, attemptedAt] of [
        ["adapter-a", ["ok", "ok", "degraded", "error"], 2000],
        ["adapter-b", ["skipped", "skipped"], 2000],
        ["adapter-c", ["ok"], 999],
      ] as const) statuses.forEach((status, index) => insertAttempt(sqlite, {
        stablecoinId: `${adapterKey}-${index}`, attemptedAt, adapterKey, status,
      }));
      const memo = (await refresh(db, 3000))!;
      expect(await refresh(db, 3000)).toBeNull();
      expect(scan).toHaveBeenCalledTimes(1);
      expect(await load(db, 3000)).toEqual(memo);
      expect(memo.computedAt).toBe(3000);
      expect(writes).toBe(Math.min(failures + 1, 4));
      expect(memo.rows).toEqual([
        { adapterKey: "adapter-a", attempts: 4, ok: 2, degraded: 1, degradedByDesign: 0, error: 1, skipped: 0, successRate: 0.5 },
        { adapterKey: "adapter-b", attempts: 2, ok: 0, degraded: 0, degradedByDesign: 0, error: 0, skipped: 2, successRate: 0 },
      ]);
      sqlite.exec("UPDATE cache SET value = 'x'");
      expect(await load(db, 3000)).toEqual(memo);
      sqlite.prepare("INSERT OR REPLACE INTO cache VALUES (?, ?, ?)").run("reserve-sync-reliability-rollup:v1", JSON.stringify(memo), 3000);
      sqlite.exec("DELETE FROM reserve_sync_attempt_history");
      expect(await load(db, 3001)).toEqual(memo);
      failScan = true;
      expect(await refresh(db, 6601)).toBeNull();
      expect(await load(db, 6601)).toEqual(memo);
      vi.resetModules();
      expect(await refresh(db, 6602)).toBeNull();
      prepare.mockClear();
      expect(await load(db, 6602)).toEqual(memo);
      expect(prepare.mock.calls.map(([sql]) => sql)).toEqual(cacheRead);
      expect(scan).toHaveBeenCalledTimes(2);
      failScan = false;
      failMarker = true;
      expect(await refresh(db, 10202)).toBeNull();
      expect(await load(db, 10202)).toEqual(memo);
      expect(scan).toHaveBeenCalledTimes(2);
      failMarker = false;
      expect((await refresh(db, 10202))?.rows).toEqual([]);
      sqlite.exec("DROP TABLE cache");
      expect((await load(db, 10203)).rows).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("counts degraded attempts whose only degraded warnings are structural as by design", async () => {
    const { sqlite, db } = fixtures.open();
    const structural = { code: "nav-portfolio-composition-unverified", message: "m", severity: "warning", effect: "degraded" };
    const operational = { ...structural, code: "source-stale" };
    const info = { ...structural, code: "primary-fallback-used", severity: "info", effect: "info" };
    const rows: Array<[Attempt["status"], unknown[] | string | null]> = [
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
    vi.useFakeTimers();
    const rollup = (await refresh(db, 3000))!;
    expect(rollup.rows).toEqual([
      { adapterKey: "chainlink-nav", attempts: 14, ok: 1, degraded: 12, degradedByDesign: 3, error: 1, skipped: 0, successRate: 4 / 14 },
    ]);
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

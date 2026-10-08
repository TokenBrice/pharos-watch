import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { getMaxSyncAge, getReserveCompositionRow, getReserveSyncState, loadReserveCompositionRowMap, loadReserveSyncStateMap } from "../store-read";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

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
    expect([...await loadReserveSyncStateMap(db, ["b", "absent"])] .map(([id]) => id)).toEqual(["b"]);
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

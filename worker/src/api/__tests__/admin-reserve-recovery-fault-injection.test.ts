import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { handleArmReserveRecoveryFaultInjection } from "../admin-reserve-recovery-fault-injection";

const NOW_MS = Date.UTC(2026, 6, 10, 7, 0, 0);
const SLOT_SEC = Date.UTC(2026, 6, 10, 8, 11, 0) / 1000;

function harness() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  return { sqlite, db: createSqliteD1(sqlite) };
}

function request(hostname = "stablecoin-api.preview.workers.dev", overrides: Record<string, unknown> = {}) {
  return new Request(`https://${hostname}/api/admin/reserve-recovery-fault-injection`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workerVersion: "preview-v1",
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt: SLOT_SEC,
      attemptNo: 1,
      killPoint: "after_checkpoint",
      ...overrides,
    }),
  });
}

describe("reserve recovery fault injection admin endpoint", () => {
  const databases: DatabaseSync[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const db of databases.splice(0)) db.close();
  });

  it("fails closed without upstream admin authentication", async () => {
    const { sqlite, db } = harness();
    databases.push(sqlite);
    const response = await handleArmReserveRecoveryFaultInjection(db, request(), false, "preview-v1", true);
    expect(response.status).toBe(401);
  });

  it("refuses production hosts even for an authenticated operator", async () => {
    const { sqlite, db } = harness();
    databases.push(sqlite);
    const response = await handleArmReserveRecoveryFaultInjection(
      db,
      request("ops-api.pharos.watch"),
      true,
      "preview-v1",
      true,
    );
    expect(response.status).toBe(403);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cache").get()).toEqual({ count: 0 });
  });

  it("fails closed on a preview host when fault injection is not explicitly enabled", async () => {
    const { sqlite, db } = harness();
    databases.push(sqlite);
    const response = await handleArmReserveRecoveryFaultInjection(db, request(), true, "preview-v1", false);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "Reserve recovery fault injection is disabled for this Worker environment.",
    });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cache").get()).toEqual({ count: 0 });
  });

  it("requires the exact executing Worker version", async () => {
    const { sqlite, db } = harness();
    databases.push(sqlite);
    const response = await handleArmReserveRecoveryFaultInjection(db, request(), true, "preview-v2", true);
    expect(response.status).toBe(409);
  });

  it("arms one bounded fault on an enabled preview and rejects a duplicate exact attempt", async () => {
    const { sqlite, db } = harness();
    databases.push(sqlite);
    const first = await handleArmReserveRecoveryFaultInjection(db, request(), true, "preview-v1", true);
    const second = await handleArmReserveRecoveryFaultInjection(db, request(), true, "preview-v1", true);

    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({
      ok: true,
      armed: true,
      fault: {
        workerVersion: "preview-v1",
        scheduleKey: "fourHourlyReserveSync",
        slotStartedAt: SLOT_SEC,
        attemptNo: 1,
        killPoint: "after_checkpoint",
      },
    });
    expect(second.status).toBe(409);
  });
});

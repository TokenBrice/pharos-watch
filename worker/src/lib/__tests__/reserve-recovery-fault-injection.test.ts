import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  armReserveRecoveryFaultInjection,
  loadReserveRecoveryFaultInjectionController,
  ReserveRecoveryFaultInjectionTermination,
} from "../reserve-recovery-fault-injection";

function harness() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  return { sqlite, db: createSqliteD1(sqlite) };
}

describe("reserve recovery fault injection", () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it("consumes an exact worker/schedule/slot/attempt fault only once", async () => {
    const { sqlite, db } = harness();
    databases.push(sqlite);
    const armed = await armReserveRecoveryFaultInjection(db, {
      workerVersion: "preview-v1",
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt: 1_000,
      attemptNo: 1,
      killPoint: "after_pending_begin",
      targetItemKey: "coin-a",
      nowSec: 900,
    });
    expect(armed.armed).toBe(true);

    const wrongVersion = await loadReserveRecoveryFaultInjectionController(db, {
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt: 1_000,
      attemptNo: 1,
      workerVersion: "preview-v2",
    }, 901);
    expect(wrongVersion).toBeNull();

    const controller = await loadReserveRecoveryFaultInjectionController(db, {
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt: 1_000,
      attemptNo: 1,
      workerVersion: "preview-v1",
    }, 901);
    expect(controller).not.toBeNull();
    await expect(controller!.trigger("after_pending_begin", "coin-b")).resolves.toBeUndefined();
    await expect(controller!.trigger("after_pending_begin", "coin-a"))
      .rejects.toBeInstanceOf(ReserveRecoveryFaultInjectionTermination);
    await expect(controller!.trigger("after_pending_begin", "coin-a")).resolves.toBeUndefined();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cache").get()).toEqual({ count: 0 });
  });

  it("does not overwrite another live one-shot for the same exact attempt", async () => {
    const { sqlite, db } = harness();
    databases.push(sqlite);
    const input = {
      workerVersion: "preview-v1",
      scheduleKey: "fourHourlyReserveSync" as const,
      slotStartedAt: 2_000,
      attemptNo: 2,
      killPoint: "after_checkpoint" as const,
      targetItemKey: null,
      nowSec: 1_900,
    };
    await expect(armReserveRecoveryFaultInjection(db, input)).resolves.toMatchObject({ armed: true });
    await expect(armReserveRecoveryFaultInjection(db, input)).resolves.toMatchObject({ armed: false });
  });
});

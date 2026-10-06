import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { runPendingQueueLifecycle, type PendingQueueLifecycleContext } from "../dispatch-telegram-pending-lifecycle";
import { readTelegramPendingCapacitySnapshot } from "../../lib/telegram/pending-capacity";
import { reconcilePendingQueueMaintenance } from "../telegram-pending";
import { insertPendingSqlite, insertRecapDeliveryFixture } from "./telegram-pending-queue.test-support";
import type * as TelegramModule from "../../lib/telegram";

const mocks = vi.hoisted(() => ({ send: vi.fn(), outcome: vi.fn() }));
vi.mock("../../lib/telegram", async (importOriginal) => ({
  ...(await importOriginal<typeof TelegramModule>()), sendToChat: mocks.send,
}));
vi.mock("../../lib/circuit-breaker", () => ({ recordOutcome: mocks.outcome }));
const fixtures = createLatestSchemaFixtureTracker();
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-07T00:00:00Z")); });
afterEach(() => { fixtures.closeAll(); vi.useRealTimers(); });

describe("pending lifecycle without due transport", () => {
  it.each([
    { label: "orphan-only without transport configuration", basis: "drain-attempted", policy: "attempted-only", token: false },
    { label: "eventless", basis: "queue-changed", policy: "always-crediting-idle", token: true },
    { label: "circuit-open", basis: "drain-attempted", policy: "attempted-only", token: true },
  ] as const)("repairs $label and refreshes capacity without send attempts", async ({ basis, policy, token }) => {
    const { sqlite, db } = fixtures.open();
    const nowSec = Math.floor(Date.now() / 1000);
    insertPendingSqlite(sqlite, { id: 1, chatId: "lost", html: "lost", createdAt: nowSec - 8_000, expiresAt: nowSec - 1, deliveryState: "sending", deliveryOwner: "lost", deliveryGeneration: 3, deliveryClaimExpiresAt: nowSec }, nowSec);
    const before = await readTelegramPendingCapacitySnapshot(db, nowSec);
    expect(before).toMatchObject({ due: 0, sending: 0, executionUnknown: 1 });
    const sharedState = {};
    const result = await runPendingQueueLifecycle({
      db, nowSec, pendingCapacityBefore: before, cleanupExpired: "when-snapshot-shows-expired",
      capacityRefreshBasis: basis, outcomePolicy: policy, sharedState,
      ...(token ? { drain: { botToken: "bot-token", dispatchStartedAtMs: Date.now() } } : {}),
    });
    expect(result.drainResult).toMatchObject({ attempted: 0, sent: 0, executionUnknown: 0, deferred: 0, dropped: 0 });
    expect(result.pendingCapacityAfter).toMatchObject({ sending: 0, executionUnknown: 0 });
    expect(result.pendingCapacityAfter).not.toBe(before);
    expect(sharedState).toEqual({ pendingCapacitySnapshot: result.pendingCapacityAfter });
    expect(result.expiredCount).toBe(0);
    expect(result.archivedExecutionUnknownCount).toBe(0);
    expect(sqlite.prepare("SELECT delivery_state, delivery_owner, delivery_generation FROM telegram_pending_alerts WHERE id = 1").get()).toEqual({ delivery_state: "execution_unknown", delivery_owner: "lost", delivery_generation: 3 });
    expect(mocks.send).not.toHaveBeenCalled();
    await result.recordDrainOutcome();
    expect(mocks.outcome).toHaveBeenCalledTimes(policy === "attempted-only" ? 0 : 1);
    if (policy === "always-crediting-idle") expect(mocks.outcome).toHaveBeenCalledWith(db, expect.any(String), true);
  });

  it("refreshes capacity for projection-only maintenance and reuses a supplied result", async () => {
    const { sqlite } = fixtures.open();
    const nowSec = Math.floor(Date.now() / 1000);
    insertRecapDeliveryFixture(sqlite, nowSec);
    sqlite.prepare("UPDATE telegram_pending_alerts SET delivery_state = 'sent'").run();
    let staleReads = 0;
    const db = createSqliteD1(sqlite, { onAll: (sql) => { if (sql.includes("SELECT id, delivery_owner")) staleReads++; } });
    const before = await readTelegramPendingCapacitySnapshot(db, nowSec);
    const maintenanceResult = await reconcilePendingQueueMaintenance(db, nowSec);
    expect(maintenanceResult.recapOutcomesProjected).toBe(1);
    const result = await runPendingQueueLifecycle({ db, nowSec, pendingCapacityBefore: before, maintenanceResult, cleanupExpired: "when-snapshot-shows-expired", capacityRefreshBasis: "drain-attempted", outcomePolicy: "attempted-only" });
    expect(result.pendingCapacityAfter).not.toBe(before);
    expect(staleReads).toBe(1);
    expect(result.drainResult).toMatchObject({ attempted: 0, sent: 0 });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("fails before transport and circuit credit when maintenance cannot complete", async () => {
    const { sqlite, db: cleanDb } = fixtures.open();
    const nowSec = Math.floor(Date.now() / 1000);
    insertPendingSqlite(sqlite, { id: 1, chatId: "due", html: "due", expiresAt: nowSec + 100 }, nowSec);
    const before = await readTelegramPendingCapacitySnapshot(cleanDb, nowSec);
    const db = createSqliteD1(sqlite, { onRun: (sql) => { if (sql.includes("SET delivery_state = 'sent'")) throw new Error("maintenance write failed"); } });
    const context: PendingQueueLifecycleContext = { db, nowSec, pendingCapacityBefore: before, drain: { botToken: "bot-token", dispatchStartedAtMs: Date.now() }, cleanupExpired: "always", capacityRefreshBasis: "queue-changed", outcomePolicy: "always-crediting-idle" };
    await expect(runPendingQueueLifecycle(context)).rejects.toThrow("maintenance write failed");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.outcome).not.toHaveBeenCalled();
  });
});

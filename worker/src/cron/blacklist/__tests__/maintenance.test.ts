import { describe, expect, it } from "vitest";
import { mockD1 as createMockD1, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { buildBlacklistAmountRepairQueueUpdate, refreshBlacklistAmountRepairQueue } from "../../../lib/blacklist/amount-repair-queue";

const DEFAULT_BLACKLIST_MAINTENANCE_D1_TABLES: MockTableConfig[] = [
  { match: "blacklist-amount-repair-queue-enqueue", rows: [] },
  { match: "blacklist-amount-repair-queue-reconcile-resolved", rows: [] },
  { match: "blacklist-amount-repair-queue-release-expired", rows: [] },
  { match: "blacklist-amount-repair-queue-finish", rows: [] },
];

function mockD1(tables: MockTableConfig[] = []) {
  return createMockD1([...tables, ...DEFAULT_BLACKLIST_MAINTENANCE_D1_TABLES]);
}

describe("blacklist maintenance foundations", () => {
  it("queues unresolved amounts and records bounded retry backoff", async () => {
    const db = mockD1();
    await refreshBlacklistAmountRepairQueue(db, 1_700_000_000);
    await buildBlacklistAmountRepairQueueUpdate(db, {
      eventId: "event-1",
      outcome: "retry",
      attemptedAt: 1_700_000_100,
      priorAttempts: 2,
      errorClass: "provider_timeout",
    }).run();

    const sql = db
      .getHistory()
      .map((entry) => entry.sql)
      .join("\n");
    expect(sql).toContain("blacklist-amount-repair-queue-enqueue");
    expect(sql).toContain("blacklist-amount-repair-queue-reconcile-resolved");
    expect(sql).toContain("blacklist-amount-repair-queue-release-expired");
    const finish = db.getHistory().find((entry) => entry.sql.includes("blacklist-amount-repair-queue-finish"));
    expect(finish?.binds).toEqual([
      "retry",
      1_700_001_300,
      "provider_timeout",
      1_700_000_100,
      0,
      1_700_000_100,
      "event-1",
    ]);
  });
});

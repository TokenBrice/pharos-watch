import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { readTelegramPendingCapacity } from "../../../../telegram/outbox/pending-capacity";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";

function setup(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = createLatestSchemaSqlite().sqlite;
  return { sqlite, db: createSqliteD1(sqlite) };
}

describe("Telegram delivery lifecycle capacity SQL", () => {
  it("separates claimable, deferred, sending, execution-unknown, cleanup, and expired work across v2 and the legacy shim", async () => {
    const { sqlite, db } = setup();
    const now = 2_000_000;
    try {
      const insertDelivery = sqlite.prepare(
        `INSERT INTO telegram_deliveries
           (job_id, kind, chat_id, body_hash, state, next_attempt_at, expires_at, created_at, sending_at, done_at)
         VALUES ('alert:cap', 'alert', ?, 'h', ?, ?, ?, ?, ?, ?)`,
      );
      insertDelivery.run("due", "pending", now - 300, now + 3_600, now - 300, null, null);
      insertDelivery.run("deferred", "retry", now + 600, now + 3_600, now - 200, null, null);
      insertDelivery.run("expired", "pending", now - 4_000, now - 1, now - 4_000, null, null);
      insertDelivery.run("sending-recent", "sending", now - 120, now + 3_600, now - 120, now - 60, null);
      insertDelivery.run("sending-aged", "sending", now - 1_500, now + 3_600, now - 1_500, now - 1_200, null);
      insertDelivery.run("sent-cleanup", "sent", now - 100, now + 3_600, now - 100, now - 90, now - 90);
      insertDelivery.run("unknown", "unknown", now - 180, now + 3_600, now - 180, now - 120, now - 120);
      sqlite.prepare(
        `INSERT INTO telegram_pending_alerts
           (chat_id, message_html, created_at, not_before_at, expires_at, delivery_state, delivery_started_at)
         VALUES ('legacy-due', 'test', ?, NULL, ?, 'pending', NULL)`,
      ).run(now - 60, now + 3_600);

      const result = await readTelegramPendingCapacity(db, now);

      expect(result.status).toBe("available");
      if (result.status !== "available") throw new Error("capacity unexpectedly unavailable");
      expect(result.value).toMatchObject({
        total: 4,
        active: 3,
        due: 2,
        deferred: 1,
        expired: 1,
        sending: 1,
        pendingExecutionUnknown: 2,
        freshExecutionUnknown: 0,
        executionUnknown: 2,
        sentCleanup: 1,
        oldestExecutionUnknownAgeSec: 1_200,
        executionUnknownLowerBound: false,
        oldestDuePendingAgeSec: 300,
      });
    } finally {
      sqlite.close();
    }
  });
});

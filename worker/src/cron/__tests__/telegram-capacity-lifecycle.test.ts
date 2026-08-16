import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { readTelegramPendingCapacity } from "../../lib/telegram-pending-capacity";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";

function setup(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = createLatestSchemaSqlite().sqlite;
  return { sqlite, db: createSqliteD1(sqlite) };
}

describe("Telegram delivery lifecycle capacity SQL", () => {
  it("separates claimable, deferred, sending, execution-unknown, cleanup, and expired work", async () => {
    const { sqlite, db } = setup();
    const now = 2_000_000;
    try {
      const insertPending = sqlite.prepare(
        `INSERT INTO telegram_pending_alerts
           (chat_id, message_html, created_at, not_before_at, expires_at, delivery_state, delivery_started_at)
         VALUES (?, 'test', ?, ?, ?, ?, ?)`,
      );
      insertPending.run("due", now - 300, null, now + 3_600, "pending", null);
      insertPending.run("deferred", now - 200, now + 600, now + 3_600, "pending", null);
      insertPending.run("expired", now - 4_000, null, now - 1, "pending", null);
      insertPending.run("sending-recent", now - 120, null, now + 3_600, "sending", now - 60);
      insertPending.run("sending-aged", now - 1_500, null, now + 3_600, "sending", now - 1_200);
      insertPending.run("sent-cleanup", now - 100, null, now + 3_600, "sent", now - 90);

      const insertFresh = sqlite.prepare(
        `INSERT INTO telegram_alert_job_targets
           (job_id, target_key, chat_id, alert_type,
            pending_dedupe_key, created_at, effect_state, effect_started_at)
         VALUES ('capacity-job', ?, 'capacity-chat', 'dews', ?, ?, ?, ?)`,
      );
      insertFresh.run("fresh-sending", "fresh-sending", now - 120, "sending", now - 60);
      insertFresh.run("fresh-sending-aged", "fresh-sending-aged", now - 1_300, "sending", now - 1_000);
      insertFresh.run("fresh-explicit-unknown", "fresh-explicit-unknown", now - 180, "execution_unknown", now - 120);

      const result = await readTelegramPendingCapacity(db, now);

      expect(result.status).toBe("available");
      if (result.status !== "available") throw new Error("capacity unexpectedly unavailable");
      expect(result.value).toMatchObject({
        total: 3,
        active: 2,
        due: 1,
        deferred: 1,
        expired: 1,
        sending: 2,
        pendingExecutionUnknown: 1,
        freshExecutionUnknown: 2,
        executionUnknown: 3,
        sentCleanup: 1,
        oldestExecutionUnknownAgeSec: 1_200,
        executionUnknownLowerBound: false,
      });
    } finally {
      sqlite.close();
    }
  });

  it("marks the execution-unknown count as a lower bound when the bounded sample saturates", async () => {
    const { sqlite, db } = setup();
    const now = 2_000_000;
    try {
      sqlite.exec(`
        WITH RECURSIVE sequence(value) AS (
          SELECT 1
          UNION ALL
          SELECT value + 1 FROM sequence WHERE value < 5001
        )
        INSERT INTO telegram_alert_job_targets
          (job_id, target_key, chat_id, alert_type,
           pending_dedupe_key, created_at, effect_state, effect_started_at)
        SELECT 'capacity-job', 'unknown-' || value, 'capacity-chat', 'dews',
               'unknown-' || value, ${now - 1_000}, 'execution_unknown', ${now - 1_000}
          FROM sequence;
      `);

      const result = await readTelegramPendingCapacity(db, now);

      expect(result.status).toBe("available");
      if (result.status !== "available") throw new Error("capacity unexpectedly unavailable");
      expect(result.value.executionUnknown).toBe(5_001);
      expect(result.value.executionUnknownSampleLimit).toBe(5_001);
      expect(result.value.executionUnknownLowerBound).toBe(true);
    } finally {
      sqlite.close();
    }
  });
});

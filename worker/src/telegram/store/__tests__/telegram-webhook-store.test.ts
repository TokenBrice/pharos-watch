import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { countTelegramProcessedUpdateBacklog, pruneTelegramProcessedUpdates } from "../processed-updates";
import { upsertSubscriberRow } from "../subscribers";
import { createLatestSchemaSqlite, createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

describe("upsertSubscriberRow", () => {
  it("updates only quiet-hours columns on a mute-only call", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.exec(`INSERT INTO telegram_subscribers
      (chat_id, created_at, last_active_at, alert_dews, global_alert_dews, global_alert_reserve)
      VALUES ('42', 1, 1, 1, 1, 1)`);
    await upsertSubscriberRow(db, {
      chatId: "42",
      username: "alice",
      nowSec: 1700000000,
      quietHours: { enabled: true, startHourUtc: 22, endHourUtc: 7 },
    });
    expect(sqlite.prepare(`SELECT quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc,
      alert_dews, global_alert_dews, global_alert_reserve FROM telegram_subscribers WHERE chat_id = '42'`).get()).toEqual({
      quiet_hours_enabled: 1, quiet_hours_start_utc: 22, quiet_hours_end_utc: 7,
      alert_dews: 1, global_alert_dews: 1, global_alert_reserve: 1,
    });
  });

  it("bumps requested alert flags without clearing existing flags", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.exec(`INSERT INTO telegram_subscribers
      (chat_id, created_at, last_active_at, alert_dews, alert_depeg, alert_safety)
      VALUES ('42', 1, 1, 1, 0, 1)`);
    await upsertSubscriberRow(db, {
      chatId: "42",
      username: null,
      nowSec: 1700000000,
      perCoinAlertBumps: { dews: 0, depeg: 1 },
    });
    expect(sqlite.prepare(`SELECT alert_dews, alert_depeg, alert_safety
      FROM telegram_subscribers WHERE chat_id = '42'`).get()).toEqual({
      alert_dews: 1, alert_depeg: 1, alert_safety: 1,
    });
  });
});

describe("pruneTelegramProcessedUpdates", () => {
  it("deletes at most 5000 expired processed update rows per call", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    try {
      
      const insert = sqlite.prepare(
        `INSERT INTO telegram_processed_updates (
           update_id,
           received_at,
           processed_at,
           update_type,
           chat_id,
           status,
           error_class
         )
         VALUES (?, ?, NULL, 'message', '42', 'processed', NULL)`,
      );

      sqlite.exec("BEGIN");
      try {
        for (let updateId = 1; updateId <= 5_001; updateId += 1) {
          insert.run(updateId, 1_699_999_000 - updateId);
        }
        insert.run(9_000, 1_699_999_940);
        sqlite.exec("COMMIT");
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }

      const countRows = (where = "", ...args: unknown[]): number => {
        const row = sqlite
          .prepare(`SELECT COUNT(*) AS count FROM telegram_processed_updates ${where}`)
          .get(...(args as never[])) as { count: number };
        return Number(row.count);
      };
      const db = createSqliteD1(sqlite);
      await expect(countTelegramProcessedUpdateBacklog(db, {
        nowSec: 1_700_000_000,
        retentionSec: 60,
      })).resolves.toEqual({ count: 5_001, exact: false, probeLimit: 5_001 });

      const firstPruned = await pruneTelegramProcessedUpdates(db, {
        nowSec: 1_700_000_000,
        retentionSec: 60,
      });

      expect(firstPruned).toBe(5_000);
      expect(countRows("WHERE received_at < ?", 1_699_999_940)).toBe(1);
      expect(countRows("WHERE received_at >= ?", 1_699_999_940)).toBe(1);
      await expect(countTelegramProcessedUpdateBacklog(db, {
        nowSec: 1_700_000_000,
        retentionSec: 60,
      })).resolves.toEqual({ count: 1, exact: true, probeLimit: 5_001 });

      const secondPruned = await pruneTelegramProcessedUpdates(db, {
        nowSec: 1_700_000_000,
        retentionSec: 60,
      });

      expect(secondPruned).toBe(1);
      expect(countRows("WHERE received_at < ?", 1_699_999_940)).toBe(0);
      expect(countRows()).toBe(1);
      await expect(countTelegramProcessedUpdateBacklog(db, {
        nowSec: 1_700_000_000,
        retentionSec: 60,
      })).resolves.toEqual({ count: 0, exact: true, probeLimit: 5_001 });
    } finally {
      sqlite.close();
    }
  });
});

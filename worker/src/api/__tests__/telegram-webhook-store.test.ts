import { describe, expect, it } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  countTelegramProcessedUpdateBacklog,
  loadPendingDisambiguation,
  persistPendingConfirmBulk,
  persistPendingDisambiguationRow,
  pruneTelegramProcessedUpdates,
  upsertSubscriberRow,
} from "../telegram-webhook-store";

describe("upsertSubscriberRow", () => {
  it("updates only quiet-hours columns on a mute-only call", async () => {
    const db = mockD1([]);
    await upsertSubscriberRow(db, {
      chatId: "42",
      username: "alice",
      nowSec: 1700000000,
      quietHours: { enabled: true, startHourUtc: 22, endHourUtc: 7 },
    });
    const [entry] = db.getHistory();
    expect(entry.sql).toContain("ON CONFLICT(chat_id)");
    expect(entry.sql).toContain("quiet_hours_enabled = excluded.quiet_hours_enabled");
    expect(entry.sql).not.toContain("alert_dews = excluded.alert_dews");
    expect(entry.sql).not.toContain("global_alert_dews = excluded.global_alert_dews");
  });

  it("bumps alert flags via MAX when perCoinAlertBumps is set", async () => {
    const db = mockD1([]);
    await upsertSubscriberRow(db, {
      chatId: "42",
      username: null,
      nowSec: 1700000000,
      perCoinAlertBumps: { dews: 1, depeg: 1 },
    });
    const [entry] = db.getHistory();
    expect(entry.sql).toContain(
      "alert_dews = MAX(telegram_subscribers.alert_dews, excluded.alert_dews)",
    );
    expect(entry.sql).toContain(
      "alert_depeg = MAX(telegram_subscribers.alert_depeg, excluded.alert_depeg)",
    );
    expect(entry.sql).not.toContain("alert_safety = MAX");
  });
});

describe("persistPendingDisambiguationRow", () => {
  it("returns false when a fresh pending row is owned by another user", async () => {
    const db = mockD1([
      {
        match: "INSERT INTO telegram_pending_disambiguation",
        rows: [],
        runMeta: { changes: 0 },
      },
    ]);

    const persisted = await persistPendingDisambiguationRow(db, {
      chatId: "-100",
      actionType: "setup-step",
      actionPayload: { step: "branch" },
      alertTypes: [],
      resolvedIds: [],
      ambiguousTicker: "",
      candidates: [],
      remainingTickers: [],
      initiatorUserId: "actor-2",
      expiresAt: 1_700_000_300,
    });

    expect(persisted).toBe(false);
    const [entry] = db.getHistory();
    expect(entry?.sql).toContain("telegram_pending_disambiguation.expires_at <= ?");
    expect(entry?.sql).toContain("telegram_pending_disambiguation.initiator_user_id = excluded.initiator_user_id");
    expect(entry?.binds).toEqual([
      "-100",
      "setup-step",
      JSON.stringify({ step: "branch" }),
      "[]",
      "[]",
      "",
      "[]",
      "[]",
      1_700_000_300,
      "actor-2",
      expect.any(Number),
    ]);
  });

  it("uses the same ownership guard for bulk confirmations", async () => {
    const db = mockD1([
      {
        match: "INSERT INTO telegram_pending_disambiguation",
        rows: [],
        runMeta: { changes: 0 },
      },
    ]);

    const persisted = await persistPendingConfirmBulk(db, {
      chatId: "-100",
      payload: {
        kind: "unsubscribe",
        presetIds: [],
        coinIds: [],
        unsubscribeAll: true,
      },
      initiatorUserId: "actor-2",
    });

    expect(persisted).toBe(false);
    const [entry] = db.getHistory();
    expect(entry?.binds).toContain("confirm-bulk");
    expect(entry?.sql).toContain("telegram_pending_disambiguation.initiator_user_id = excluded.initiator_user_id");
  });
});

describe("loadPendingDisambiguation", () => {
  it("loads the full pending action row by chat id", async () => {
    const row = {
      action_type: "subscribe",
      action_payload: "{}",
      alert_types: "[]",
      resolved_ids: "[]",
      ambiguous_ticker: "USD",
      candidates: "[]",
      remaining_tickers: "[]",
      expires_at: 1_700_000_300,
      initiator_user_id: "123",
    };
    const db = mockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [row],
      },
    ]);

    await expect(loadPendingDisambiguation(db, "42")).resolves.toEqual(row);

    const [entry] = db.getHistory();
    expect(entry?.sql).toContain("action_type, action_payload, alert_types");
    expect(entry?.sql).toContain("initiator_user_id FROM telegram_pending_disambiguation");
    expect(entry?.binds).toEqual(["42"]);
  });
});

describe("pruneTelegramProcessedUpdates", () => {
  it("uses a capped D1-compatible delete for rows older than the retention cutoff", async () => {
    const db = mockD1([
      {
        match: "DELETE FROM telegram_processed_updates",
        rows: [],
        runMeta: { changes: 7 },
      },
    ]);

    const pruned = await pruneTelegramProcessedUpdates(db, {
      nowSec: 1_700_000_000,
      retentionSec: 60,
    });

    expect(pruned).toBe(7);
    const [entry] = db.getHistory();
    expect(entry?.binds).toEqual([1_699_999_940, 5_000]);
    expect(entry?.sql).toContain("WHERE update_id IN");
    expect(entry?.sql).toContain("ORDER BY received_at ASC, update_id ASC");
    expect(entry?.sql).toContain("LIMIT ?");
  });

  it("deletes at most 5000 expired processed update rows per call", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(`
        CREATE TABLE telegram_processed_updates (
          update_id INTEGER PRIMARY KEY,
          received_at INTEGER NOT NULL,
          processed_at INTEGER,
          update_type TEXT,
          chat_id TEXT,
          status TEXT NOT NULL DEFAULT 'processing',
          error_class TEXT
        );
      `);

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

import { describe, expect, it } from "vitest";
import { D1_BATCH_SIZE } from "../../lib/constants";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { mockTelegramD1 as mockD1 } from "../../test-helpers/__shared/telegram";
import {
  countTelegramProcessedUpdateBacklog,
  loadPendingDisambiguation,
  persistPendingConfirmBulk,
  persistPendingDisambiguation,
  persistPendingDisambiguationRow,
  pruneTelegramProcessedUpdates,
  upsertSubscriberRow,
} from "../telegram-webhook-store";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";

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
  it("stores a versioned canonical payload while satisfying legacy NOT NULL columns", async () => {
    const candidates = [{ id: "usdf-falcon", symbol: "USDF", name: "Falcon USD" }];
    const db = mockD1([{ match: "INSERT INTO telegram_pending_disambiguation", rows: [] }]);

    await persistPendingDisambiguation(db, {
      chatId: "42",
      actionType: "subscribe",
      actionPayload: { presetIds: ["usd-top25"] },
      alertTypes: new Set(["dews"]),
      resolvedCoins: [{ id: "usdc-circle", symbol: "USDC", name: "USD Coin" }],
      ambiguousTicker: "USDF",
      candidates,
      remainingTickers: ["USDA"],
      initiatorUserId: "123",
    });
    db.assertAllMatchesUsed();

    const [entry] = db.getHistory();
    expect(JSON.parse(String(entry?.binds[2]))).toEqual({
      presetIds: ["usd-top25"],
      schemaVersion: 1,
      alertTypes: ["dews"],
      resolvedIds: ["usdc-circle"],
      ambiguousTicker: "USDF",
      candidates,
      remainingTickers: ["USDA"],
    });
    expect(entry?.binds.slice(3, 8)).toEqual([
      JSON.stringify(["dews"]),
      JSON.stringify(["usdc-circle"]),
      "USDF",
      JSON.stringify(candidates),
      JSON.stringify(["USDA"]),
    ]);
  });

  it("returns false when a fresh pending row is owned by another user", async () => {
    const db = mockD1([], { writeResults: { pendingOperation: { insert: 0 } } });

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
    db.assertAllMatchesUsed();
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
    const db = mockD1([], { writeResults: { pendingOperation: { insert: 0 } } });

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
    db.assertAllMatchesUsed();
    const [entry] = db.getHistory();
    expect(entry?.binds).toContain("confirm-bulk");
    expect(entry?.sql).toContain("telegram_pending_disambiguation.initiator_user_id = excluded.initiator_user_id");
  });

  it("rejects pending disambiguation batches above the D1 limit", async () => {
    const db = mockD1([], { allowUnmatched: true });
    const operationStatements = Array.from(
      { length: D1_BATCH_SIZE },
      () => db.prepare("UPDATE telegram_subscriptions SET alert_depeg = alert_depeg"),
    );

    await expect(
      persistPendingDisambiguationRow(db, {
        chatId: "-100",
        actionType: "setup-step",
        actionPayload: { step: "branch" },
        alertTypes: [],
        resolvedIds: [],
        ambiguousTicker: "",
        candidates: [],
        remainingTickers: [],
        initiatorUserId: "actor-2",
        operationStatements,
      }),
    ).rejects.toThrow(`Pending disambiguation requires too many atomic statements (${D1_BATCH_SIZE + 1})`);
    expect(db.getHistory()).toEqual([]);
  });
});

describe("loadPendingDisambiguation", () => {
  it("loads only the canonical pending action columns by chat id", async () => {
    const row = {
      action_type: "subscribe",
      action_payload: JSON.stringify({ schemaVersion: 1 }),
      expires_at: 1_700_000_300,
      initiator_user_id: "123",
    };
    const db = mockD1([], { pendingOperation: row });

    await expect(loadPendingDisambiguation(db, "42")).resolves.toEqual(row);
    db.assertAllMatchesUsed();

    const [entry] = db.getHistory();
    expect(entry?.sql).toContain("action_type, action_payload, expires_at");
    expect(entry?.sql).not.toContain("alert_types");
    expect(entry?.sql).not.toContain("resolved_ids");
    expect(entry?.sql).not.toContain("candidates");
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
    db.assertAllMatchesUsed();

    expect(pruned).toBe(7);
    const [entry] = db.getHistory();
    expect(entry?.binds).toEqual([1_699_999_940, 1_692_224_000, 5_000]);
    expect(entry?.sql).toContain("WHERE update_id IN");
    expect(entry?.sql).toContain("ORDER BY received_at ASC, update_id ASC");
    expect(entry?.sql).toContain("LIMIT ?");
  });

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

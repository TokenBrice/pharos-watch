import { describe, expect, it } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import {
  maybePruneTelegramProcessedUpdates,
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

describe("pruneTelegramProcessedUpdates", () => {
  it("deletes processed update rows older than the retention cutoff", async () => {
    const db = mockD1([
      {
        match: "DELETE FROM telegram_processed_updates WHERE received_at < ?",
        rows: [],
        runMeta: { changes: 7 },
      },
    ]);

    const pruned = await pruneTelegramProcessedUpdates(db, {
      nowSec: 1_700_000_000,
      retentionSec: 60,
    });

    expect(pruned).toBe(7);
    expect(db.getHistory()[0]?.binds).toEqual([1_699_999_940]);
  });

  it("runs through the guarded production pruning path when the interval elapses", async () => {
    const db = mockD1([
      {
        match: "INSERT INTO cache (key, value, updated_at)",
        rows: [],
        runMeta: { changes: 1 },
      },
      {
        match: "DELETE FROM telegram_processed_updates WHERE received_at < ?",
        rows: [],
        runMeta: { changes: 3 },
      },
    ]);

    const pruned = await maybePruneTelegramProcessedUpdates(db, {
      nowSec: 1_700_000_000,
      retentionSec: 60,
      intervalSec: 30,
    });

    expect(pruned).toBe(3);
    expect(db.getHistory()[0]?.binds).toEqual([1_700_000_000, 1_699_999_970]);
    expect(db.getHistory()[1]?.binds).toEqual([1_699_999_940]);
  });

  it("skips production pruning while the cache guard is fresh", async () => {
    const db = mockD1([
      {
        match: "INSERT INTO cache (key, value, updated_at)",
        rows: [],
        runMeta: { changes: 0 },
      },
    ]);

    const pruned = await maybePruneTelegramProcessedUpdates(db, {
      nowSec: 1_700_000_000,
      retentionSec: 60,
      intervalSec: 30,
    });

    expect(pruned).toBeNull();
    expect(db.getHistory()).toHaveLength(1);
  });
});

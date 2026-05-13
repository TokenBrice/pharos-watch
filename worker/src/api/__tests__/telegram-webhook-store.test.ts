import { describe, expect, it } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import {
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
});

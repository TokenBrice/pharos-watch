import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { describeGlobalAlertSettings } from "../../webhook/telegram-webhook-messages";
import { toggleGlobalAlert } from "../../webhook/telegram-webhook-settings-mutations";
import { loadSubscriberByChat, prepareUpsertSubscriberRow, upsertSubscriberRow } from "../subscribers";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

describe("loadSubscriberByChat", () => {
  it("loads freeze preferences and toggles an enabled global preference off", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.exec(`
      INSERT INTO telegram_subscribers (
        chat_id, alert_freeze, global_alert_freeze, created_at, last_active_at
      ) VALUES ('42', 1, 1, 1, 1)
    `);

    const loaded = await loadSubscriberByChat(db, "42");
    expect(loaded).toMatchObject({ alert_freeze: 1, global_alert_freeze: 1 });
    expect(describeGlobalAlertSettings(loaded)).toBe("Freeze");

    await toggleGlobalAlert(db, "42", "alice", "freeze");

    expect(sqlite.prepare(
      "SELECT alert_freeze, global_alert_freeze FROM telegram_subscribers WHERE chat_id = '42'",
    ).get()).toEqual({ alert_freeze: 1, global_alert_freeze: 0 });
  });

  it("evaluates a queued enable against a concurrent explicit /mute window atomically", async () => {
    const { db, sqlite } = fixtures.open();
    await upsertSubscriberRow(db, {
      chatId: "42", username: null, nowSec: 1,
      quietHours: { enabled: true, startHourUtc: 22, endHourUtc: 7 },
    });
    const toggle = prepareUpsertSubscriberRow(db, {
      chatId: "42", username: null, nowSec: 2,
      quietHours: { enabled: true, startHourUtc: 22, endHourUtc: 7, preserveSavedWindow: true },
    });
    await upsertSubscriberRow(db, {
      chatId: "42", username: null, nowSec: 2,
      quietHours: { enabled: true, startHourUtc: 1, endHourUtc: 9 },
    });
    await db.batch([toggle]);
    expect(sqlite.prepare(`SELECT quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc
      FROM telegram_subscribers WHERE chat_id = '42'`).get())
      .toEqual({ quiet_hours_enabled: 1, quiet_hours_start_utc: 1, quiet_hours_end_utc: 9 });
  });
});

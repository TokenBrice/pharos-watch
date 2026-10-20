import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { TELEGRAM_ALERT_TYPES } from "@shared/types/status";
import { describeGlobalAlertSettings } from "../../webhook/telegram-webhook-messages";
import { toggleGlobalAlert } from "../../webhook/telegram-webhook-settings-mutations";
import { buildSubscriberUpsert, loadSubscriberByChat, prepareUpsertSubscriberRow, upsertSubscriberRow, type UpsertSubscriberInput } from "../subscribers";

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

describe("subscriber SQL persisted-row parity", () => {
  const preferenceCases = [false, true].flatMap((existing) =>
    [null, "new-name"].flatMap((username) =>
      [
        { timezone: "Europe/Paris" }, { timezone: null },
        { alertSnoozeUntilTs: 1_800_001_000 }, { alertSnoozeUntilTs: null },
      ].map((preference) => ({ existing, username, preference }))));

  it.each(preferenceCases)("preserves every untouched column for preference case %#", async ({ existing, username, preference }) => {
    const { sqlite, db } = fixtures.open();
    for (const chatId of ["actual", "expected"]) {
      sqlite.prepare("INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES (?, 1, 1)").run(chatId);
      if (existing) sqlite.prepare(`UPDATE telegram_subscribers SET username = 'prior',
        alert_freeze = 1, global_alert_reserve = 1, quiet_hours_enabled = 1,
        quiet_hours_start_utc = 2, quiet_hours_end_utc = 6, timezone = 'UTC',
        alert_snooze_until_ts = 123, preference_generation = 9,
        first_follow_at = 10, first_setup_completed_at = 11 WHERE chat_id = ?`).run(chatId);
    }
    const expected = { ...sqlite.prepare("SELECT * FROM telegram_subscribers WHERE chat_id = 'expected'").get() };
    delete expected.chat_id;
    if (!existing) sqlite.prepare("DELETE FROM telegram_subscribers WHERE chat_id = 'actual'").run();
    const built = buildSubscriberUpsert({ kind: "preference", chatId: "actual", username, nowSec: 1_800_000_000, ...preference });
    await db.prepare(built.sql).bind(...built.binds).run();
    expected.username = username ?? expected.username;
    expected.last_active_at = 1_800_000_000;
    expected.preference_generation = existing ? 10 : 1;
    if (!existing) expected.created_at = 1_800_000_000;
    if (preference.timezone !== undefined) expected.timezone = preference.timezone;
    else expected.alert_snooze_until_ts = preference.alertSnoozeUntilTs ?? null;
    const actual = { ...sqlite.prepare("SELECT * FROM telegram_subscribers WHERE chat_id = 'actual'").get() };
    delete actual.chat_id;
    expect(actual).toEqual(expected);
  });

  it.each([false, true].flatMap((existing) => TELEGRAM_ALERT_TYPES.flatMap((family) =>
    (["perCoinAlertBumps", "globalAlertBumps", "globalAlertOverrides"] as const).map((mutation) => ({ existing, family, mutation })))))
  ("preserves every column for $mutation/$family existing=$existing", async ({ existing, family, mutation }) => {
    const { sqlite, db } = fixtures.open();
    sqlite.prepare("INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('42', 1, 1)").run();
    if (existing) sqlite.exec(`UPDATE telegram_subscribers SET username = 'prior',
      alert_dews = 1, alert_depeg = 1, alert_safety = 1, alert_launch = 1, alert_reserve = 1, alert_freeze = 1,
      global_alert_dews = 1, global_alert_depeg = 1, global_alert_safety = 1, global_alert_launch = 1, global_alert_reserve = 1, global_alert_freeze = 1,
      quiet_hours_enabled = 1, quiet_hours_start_utc = 2, quiet_hours_end_utc = 6,
      timezone = 'Europe/Paris', alert_snooze_until_ts = 123, preference_generation = 9`);
    const expected = { ...sqlite.prepare("SELECT * FROM telegram_subscribers").get() };
    if (!existing) sqlite.exec("DELETE FROM telegram_subscribers");
    const value = mutation === "globalAlertOverrides" ? 0 : 1;
    const input: UpsertSubscriberInput = { chatId: "42", username: null, nowSec: 20, [mutation]: { [family]: value } };
    await upsertSubscriberRow(db, input);
    expected[`${mutation === "perCoinAlertBumps" ? "alert" : "global_alert"}_${family}`] = value;
    expected.preference_generation = existing ? 10 : 1;
    expected.last_active_at = 20;
    if (mutation !== "perCoinAlertBumps") {
      if (existing) expected.watcher_ever_active = 1;
      else if (value === 1) expected.watcher_active = 1;
    }
    if (!existing) {
      expected.created_at = 20;
      if (mutation === "globalAlertBumps") expected.first_follow_at = 20;
    }
    expect({ ...sqlite.prepare("SELECT * FROM telegram_subscribers").get() }).toEqual(expected);
    expect(sqlite.prepare(`SELECT COALESCE(SUM(subscribe_events), 0) AS subscribed,
      COALESCE(SUM(unsubscribe_events), 0) AS unsubscribed,
      COALESCE(SUM(reactivate_events), 0) AS reactivated FROM telegram_watcher_lifecycle_events_daily`).get())
      .toEqual({ subscribed: existing || mutation === "globalAlertBumps" ? 1 : 0, unsubscribed: 0, reactivated: 0 });
  });

  it("retains override precedence over per-coin bumps and rejects conflicting global modes", async () => {
    const { db, sqlite } = fixtures.open();
    const common = { chatId: "42", username: null, nowSec: 20 };
    await prepareUpsertSubscriberRow(db, { ...common, perCoinAlertBumps: { dews: 1 }, globalAlertOverrides: { dews: 0 } }).run();
    expect(sqlite.prepare("SELECT alert_dews, global_alert_dews FROM telegram_subscribers").get()).toEqual({ alert_dews: 0, global_alert_dews: 0 });
    // Exercise the runtime boundary even when an untyped caller violates the exclusive union.
    const invalid = JSON.parse(JSON.stringify({ ...common, globalAlertBumps: { dews: 1 }, globalAlertOverrides: { dews: 0 } }));
    expect(() => prepareUpsertSubscriberRow(db, invalid)).toThrow("cannot be combined");
    for (const preference of [{}, { timezone: "UTC", alertSnoozeUntilTs: null }]) {
      expect(() => buildSubscriberUpsert({ ...common, kind: "preference", ...preference })).toThrow("exactly one");
    }
  });

  it.each([false, true].flatMap((existing) => [false, true].flatMap((enabled) =>
    [false, true].map((preserveSavedWindow) => ({ existing, enabled, preserveSavedWindow })))))
  ("preserves complete rows for quiet-hours case %#", async ({ existing, enabled, preserveSavedWindow }) => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec("INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('42', 1, 1)");
    if (existing) sqlite.exec(`UPDATE telegram_subscribers SET username = 'prior', timezone = 'Europe/Paris',
      alert_snooze_until_ts = 123, quiet_hours_enabled = 1, quiet_hours_start_utc = 2, quiet_hours_end_utc = 6, preference_generation = 9`);
    const expected = { ...sqlite.prepare("SELECT * FROM telegram_subscribers").get() };
    if (!existing) sqlite.exec("DELETE FROM telegram_subscribers");
    await upsertSubscriberRow(db, { chatId: "42", username: null, nowSec: 20,
      quietHours: enabled ? { enabled: true, startHourUtc: 22, endHourUtc: 7, preserveSavedWindow } : { enabled: false } });
    expected.quiet_hours_enabled = enabled ? 1 : 0;
    if (enabled && (!existing || !preserveSavedWindow)) {
      expected.quiet_hours_start_utc = 22;
      expected.quiet_hours_end_utc = 7;
    }
    expected.preference_generation = existing ? 10 : 1;
    expected.last_active_at = 20;
    if (!existing) expected.created_at = 20;
    expect({ ...sqlite.prepare("SELECT * FROM telegram_subscribers").get() }).toEqual(expected);
  });
});

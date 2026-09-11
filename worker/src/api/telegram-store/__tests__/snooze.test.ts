import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FROZEN_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { setSubscriptionSnooze } from "../snooze";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";

const NOW_SEC = 1_800_000_000;

function createSubscriptionDb(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = createLatestSchemaSqlite().sqlite;
  return { sqlite, db: createSqliteD1(sqlite) };
}

function subscriptionCount(sqlite: DatabaseSync): number {
  const row = sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_subscriptions").get() as {
    count: number;
  };
  return Number(row.count);
}

describe("setSubscriptionSnooze clear invariants", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not create an invisible row when clearing an absent snooze", async () => {
    const { sqlite, db } = createSubscriptionDb();
    try {
      await setSubscriptionSnooze(db, "42", "usdc-circle", null);
      expect(subscriptionCount(sqlite)).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it("increments the parent preference generation in the same clear batch", async () => {
    const { sqlite, db } = createSubscriptionDb();
    try {
      sqlite.prepare(
        `INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at, preference_generation)
         VALUES (?, ?, ?, ?)`,
      ).run("42", NOW_SEC - 600, NOW_SEC - 60, 7);
      sqlite.prepare(
        `INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_snooze_until_ts)
         VALUES (?, ?, ?)`,
      ).run("42", "usdc-circle", NOW_SEC + 3_600);

      await setSubscriptionSnooze(db, "42", "usdc-circle", null);

      expect(sqlite.prepare(
        "SELECT preference_generation FROM telegram_subscribers WHERE chat_id = ?",
      ).get("42")).toEqual({ preference_generation: 8 });
    } finally {
      sqlite.close();
    }
  });

  it("deletes a snooze-only row after clearing it", async () => {
    const { sqlite, db } = createSubscriptionDb();
    try {
      sqlite.prepare(
        `INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_snooze_until_ts)
         VALUES (?, ?, ?)`,
      ).run("42", "usdc-circle", NOW_SEC + 3_600);

      await setSubscriptionSnooze(db, "42", "usdc-circle", null);
      expect(subscriptionCount(sqlite)).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it("preserves marker-backed explicit-off state while clearing its snooze", async () => {
    const { sqlite, db } = createSubscriptionDb();
    try {
      sqlite.prepare(
        `INSERT INTO telegram_subscriptions (
           chat_id, stablecoin_id, alert_dews_override, alert_snooze_until_ts
         ) VALUES (?, ?, 1, ?)`,
      ).run("42", "usdc-circle", NOW_SEC + 3_600);

      await setSubscriptionSnooze(db, "42", "usdc-circle", null);

      expect(sqlite.prepare(
        `SELECT alert_dews_override, alert_snooze_until_ts
           FROM telegram_subscriptions
          WHERE chat_id = ? AND stablecoin_id = ?`,
      ).get("42", "usdc-circle")).toEqual({
        alert_dews_override: 1,
        alert_snooze_until_ts: null,
      });
    } finally {
      sqlite.close();
    }
  });

  it("preserves enabled and tuned subscription state while clearing its snooze", async () => {
    const { sqlite, db } = createSubscriptionDb();
    try {
      sqlite.prepare(
        `INSERT INTO telegram_subscriptions (
           chat_id, stablecoin_id, alert_dews, dews_min_band, safety_mode,
           depeg_worsening_bps_step, alert_snooze_until_ts
         ) VALUES (?, ?, 1, 'WARNING', 'downgrade-only', 250, ?)`,
      ).run("42", "usdc-circle", NOW_SEC + 3_600);

      await setSubscriptionSnooze(db, "42", "usdc-circle", null);

      expect(sqlite.prepare(
        `SELECT alert_dews, dews_min_band, safety_mode,
                depeg_worsening_bps_step, alert_snooze_until_ts
           FROM telegram_subscriptions
          WHERE chat_id = ? AND stablecoin_id = ?`,
      ).get("42", "usdc-circle")).toEqual({
        alert_dews: 1,
        dews_min_band: "WARNING",
        safety_mode: "downgrade-only",
        depeg_worsening_bps_step: 250,
        alert_snooze_until_ts: null,
      });
    } finally {
      sqlite.close();
    }
  });

  it("preserves each independent retention reason when clearing snoozes", async () => {
    const { sqlite, db } = createSubscriptionDb();
    try {
      const reasons = [
        ["alert_freeze", 1], ["alert_freeze_override", 1], ["safety_mode", "upgrade-only"],
        ["depeg_worsening_bps_step", 250], ["dews_min_band", "DANGER"],
      ] as const;
      for (const [column, value] of reasons) {
        sqlite.prepare(`INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, ${column}, alert_snooze_until_ts)
          VALUES (?, 'usdc-circle', ?, ?)`).run(column, value, NOW_SEC + 3600);
        await setSubscriptionSnooze(db, column, "usdc-circle", null);
        expect(sqlite.prepare(`SELECT ${column} AS reason, alert_snooze_until_ts FROM telegram_subscriptions
          WHERE chat_id = ?`).get(column)).toEqual({ reason: value, alert_snooze_until_ts: null });
      }
    } finally {
      sqlite.close();
    }
  });

  it("creates and updates snoozes without losing preferences and rolls back a failed operation", async () => {
    const { sqlite, db } = createSubscriptionDb();
    try {
      await setSubscriptionSnooze(db, "42", "usdc-circle", NOW_SEC + 3600);
      expect(sqlite.prepare("SELECT preference_generation FROM telegram_subscribers WHERE chat_id = '42'").get())
        .toEqual({ preference_generation: 1 });
      expect(sqlite.prepare("SELECT alert_snooze_until_ts FROM telegram_subscriptions WHERE chat_id = '42'").get())
        .toEqual({ alert_snooze_until_ts: NOW_SEC + 3600 });
      sqlite.exec("UPDATE telegram_subscriptions SET alert_freeze_override = 1, safety_mode = 'upgrade-only'");
      await setSubscriptionSnooze(db, "42", "usdc-circle", NOW_SEC + 7200);
      expect(sqlite.prepare("SELECT preference_generation FROM telegram_subscribers WHERE chat_id = '42'").get())
        .toEqual({ preference_generation: 2 });
      expect(sqlite.prepare("SELECT alert_snooze_until_ts, alert_freeze_override, safety_mode FROM telegram_subscriptions").get())
        .toEqual({ alert_snooze_until_ts: NOW_SEC + 7200, alert_freeze_override: 1, safety_mode: "upgrade-only" });
      const beforeParent = sqlite.prepare("SELECT * FROM telegram_subscribers").all();
      const beforeRows = sqlite.prepare("SELECT * FROM telegram_subscriptions").all();
      await expect(setSubscriptionSnooze(db, "42", "usdc-circle", NOW_SEC + 10800, {
        operationStatements: [db.prepare("INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('42', 1, 1)")],
      })).rejects.toThrow();
      expect(sqlite.prepare("SELECT * FROM telegram_subscribers").all()).toEqual(beforeParent);
      expect(sqlite.prepare("SELECT * FROM telegram_subscriptions").all()).toEqual(beforeRows);
    } finally {
      sqlite.close();
    }
  });

  it("allows cleanup of frozen rows but rejects a new frozen snooze", async () => {
    const frozen = FROZEN_STABLECOINS[0];
    if (!frozen) throw new Error("Expected a frozen stablecoin fixture");
    const { sqlite, db } = createSubscriptionDb();
    try {
      sqlite.prepare(
        `INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_snooze_until_ts)
         VALUES (?, ?, ?)`,
      ).run("42", frozen.id, NOW_SEC + 3_600);

      await setSubscriptionSnooze(db, "42", frozen.id, null);
      expect(subscriptionCount(sqlite)).toBe(0);

      await expect(
        setSubscriptionSnooze(db, "42", frozen.id, NOW_SEC + 3_600),
      ).rejects.toThrow(/not subscribable/i);
      expect(subscriptionCount(sqlite)).toBe(0);
    } finally {
      sqlite.close();
    }
  });
});

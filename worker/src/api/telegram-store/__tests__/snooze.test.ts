import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FROZEN_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { createSqliteD1 } from "../../../test-helpers/sqlite-d1";
import { setSubscriptionSnooze } from "../snooze";

const NOW_SEC = 1_800_000_000;

function createSubscriptionDb(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE telegram_subscribers (
      chat_id TEXT PRIMARY KEY,
      last_active_at INTEGER NOT NULL DEFAULT 0,
      preference_generation INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE telegram_subscriptions (
      chat_id TEXT NOT NULL,
      stablecoin_id TEXT NOT NULL,
      alert_dews INTEGER NOT NULL DEFAULT 0,
      alert_depeg INTEGER NOT NULL DEFAULT 0,
      alert_safety INTEGER NOT NULL DEFAULT 0,
      alert_launch INTEGER NOT NULL DEFAULT 0,
      alert_reserve INTEGER NOT NULL DEFAULT 0,
      alert_freeze INTEGER NOT NULL DEFAULT 0,
      alert_dews_override INTEGER NOT NULL DEFAULT 0,
      alert_depeg_override INTEGER NOT NULL DEFAULT 0,
      alert_safety_override INTEGER NOT NULL DEFAULT 0,
      alert_launch_override INTEGER NOT NULL DEFAULT 0,
      alert_reserve_override INTEGER NOT NULL DEFAULT 0,
      alert_freeze_override INTEGER NOT NULL DEFAULT 0,
      dews_min_band TEXT,
      safety_mode TEXT,
      depeg_worsening_bps_step INTEGER,
      alert_snooze_until_ts INTEGER,
      PRIMARY KEY (chat_id, stablecoin_id)
    );
  `);
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
        "INSERT INTO telegram_subscribers (chat_id, last_active_at, preference_generation) VALUES (?, ?, ?)",
      ).run("42", NOW_SEC - 60, 7);
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

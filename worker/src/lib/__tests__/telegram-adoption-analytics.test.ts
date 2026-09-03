import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  loadTelegramAdoptionWeeklyReport,
  loadTelegramFirstMutationP50,
  recordTelegramFirstFollow,
  recordTelegramMiniAppAdoptionSession,
  recordTelegramMiniAppFirstMutation,
  refreshTelegramAdoptionRetention,
} from "../telegram/adoption-analytics";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";

const NOW = Math.floor(Date.parse("2026-08-20T12:00:00Z") / 1_000);

function day(offset: number): string {
  return new Date((NOW + offset * 86_400) * 1_000).toISOString().slice(0, 10);
}

function dayStart(offset: number): number {
  return Math.floor(Date.parse(`${day(offset)}T00:00:00Z`) / 1_000);
}

function createHarness(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = createLatestSchemaSqlite().sqlite;
  return { sqlite, db: createSqliteD1(sqlite) };
}

describe("Telegram adoption analytics", () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => ({ sqlite, db } = createHarness()));

  it("claims a first follow once while keeping chat_id out of the rollup", async () => {
    sqlite.prepare(
      "INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES (?, ?, ?)",
    ).run("chat-42", NOW, NOW);
    const input = { campaign: "landing" as const, placement: "hero" as const, chatId: "chat-42", feature: "preset" as const, nowSec: NOW };
    await recordTelegramFirstFollow(db, input);
    await recordTelegramFirstFollow(db, input);

    expect(sqlite.prepare("SELECT first_follow_at FROM telegram_subscribers").get()).toEqual({ first_follow_at: NOW });
    expect(sqlite.prepare("SELECT campaign, placement, stage, feature, count FROM telegram_adoption_daily").all())
      .toEqual([{ campaign: "landing", placement: "hero", stage: "first_follow", feature: "preset", count: 1 }]);
    expect(sqlite.prepare("PRAGMA table_info(telegram_adoption_daily)").all().map((row) => (row as { name: string }).name))
      .not.toContain("chat_id");
  });

  it("consumes one short-lived session and buckets only its first mutation", async () => {
    await recordTelegramMiniAppAdoptionSession(db, {
      userId: "42",
      startParam: "pw1_landing_miniapp_home",
      canMutate: true,
      nowSec: NOW,
    });
    await recordTelegramMiniAppFirstMutation(db, { userId: "42", feature: "settings", nowSec: NOW + 45 });
    await recordTelegramMiniAppFirstMutation(db, { userId: "42", feature: "settings", nowSec: NOW + 60 });

    expect(sqlite.prepare("SELECT latency_bucket, count FROM telegram_adoption_daily WHERE stage = 'first_mutation'").all())
      .toEqual([{ latency_bucket: "30s_2m", count: 1 }]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cache").get()).toEqual({ count: 0 });
    expect(await loadTelegramFirstMutationP50(db, day(0))).toEqual({ p50Sec: 75, sampleCount: 1 });
  });

  it("catches up a bounded seven-day window and is idempotent", async () => {
    sqlite.prepare(
      `INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at, first_follow_at, global_alert_dews)
       VALUES (?, ?, ?, ?, 1)`,
    ).run("d7-survivor", dayStart(-8), dayStart(-8), dayStart(-8));
    sqlite.prepare(
      `INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at, first_follow_at)
       VALUES (?, ?, ?, ?)`,
    ).run("d30-survivor", dayStart(-31), dayStart(-31), dayStart(-31));
    sqlite.prepare(
      "INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_depeg) VALUES (?, ?, 1)",
    ).run("d30-survivor", "usdt-tether");
    const insertCohort = sqlite.prepare(`INSERT INTO telegram_adoption_daily
      (day, campaign, placement, stage, feature, latency_bucket, outcome, count, first_seen_at, last_seen_at)
      VALUES (?, 'organic', 'unknown', 'first_follow', 'direct', '', 'success', ?, ?, ?)`);
    // The second D7 member used /forget and no longer has a subscriber row.
    // Its aggregate first-follow event must remain in the denominator.
    insertCohort.run(day(-8), 2, dayStart(-8), dayStart(-8));
    insertCohort.run(day(-31), 1, dayStart(-31), dayStart(-31));
    sqlite.prepare(`INSERT INTO telegram_adoption_daily
      (day, campaign, placement, stage, feature, latency_bucket, outcome, count, first_seen_at, last_seen_at)
      VALUES (?, 'organic', 'unknown', 'bot_start', '', '', 'success', 99, ?, ?)`)
      .run(day(-8), dayStart(-8), dayStart(-8));

    expect(await refreshTelegramAdoptionRetention(db, NOW)).toEqual({ written: 56, caughtUp: 48 });
    expect(await refreshTelegramAdoptionRetention(db, NOW)).toEqual({ written: 0, caughtUp: 0 });
    expect(sqlite.prepare(
      "SELECT window_days, feature, cohort_size, retained_count, quality FROM telegram_adoption_retention_daily WHERE measurement_day = ? AND feature = 'any' ORDER BY window_days",
    ).all(day(-1))).toEqual([
      { window_days: 7, feature: "any", cohort_size: 2, retained_count: 1, quality: "on_time_snapshot" },
      { window_days: 30, feature: "any", cohort_size: 1, retained_count: 1, quality: "on_time_snapshot" },
    ]);
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM telegram_adoption_retention_daily WHERE measurement_day = ?",
    ).get(day(0))).toEqual({ count: 0 });
  });

  it("labels cohorts before aggregate first-follow collection as unavailable", async () => {
    const preRolloutNow = Math.floor(Date.parse("2026-07-11T12:00:00Z") / 1_000);
    await refreshTelegramAdoptionRetention(db, preRolloutNow);
    expect(sqlite.prepare(
      "SELECT DISTINCT quality, cohort_size, retained_count FROM telegram_adoption_retention_daily",
    ).all()).toEqual([{ quality: "pre_rollout_unavailable", cohort_size: 0, retained_count: 0 }]);
  });

  it("reports directional rates above 100 percent with an explicit warning", async () => {
    const insert = sqlite.prepare(`INSERT INTO telegram_adoption_daily
      (day, campaign, placement, stage, feature, latency_bucket, outcome, count, first_seen_at, last_seen_at)
      VALUES (?, 'landing', 'hero', ?, '', '', 'success', ?, ?, ?)`);
    insert.run(day(-1), "cta_click", 5, NOW - 10, NOW - 10);
    insert.run(day(-1), "bot_start", 7, NOW - 9, NOW - 9);
    insert.run(day(-1), "setup_complete", 5, NOW - 8, NOW - 8);

    const report = await loadTelegramAdoptionWeeklyReport(db, NOW) as {
      placements: Array<{ startPerClickPct: number }>;
      quality: { warnings: string[] };
    };
    expect(report.placements[0].startPerClickPct).toBe(140);
    expect(report.quality.warnings.join(" ")).toContain("may exceed 100%");
  });
});

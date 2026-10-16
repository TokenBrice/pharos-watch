import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  recordTelegramFirstFollow,
  refreshTelegramAdoptionRetention,
} from "../telegram/adoption-analytics";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

const NOW = Math.floor(Date.parse("2026-08-20T12:00:00Z") / 1_000);

const fixtures = createLatestSchemaFixtureTracker();

describe("Telegram adoption analytics", () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => ({ sqlite, db } = fixtures.open()));
  afterEach(fixtures.closeAll);

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
  it("labels cohorts before aggregate first-follow collection as unavailable", async () => {
    const preRolloutNow = Math.floor(Date.parse("2026-07-11T12:00:00Z") / 1_000);
    await refreshTelegramAdoptionRetention(db, preRolloutNow);
    expect(sqlite.prepare(
      "SELECT DISTINCT quality, cohort_size, retained_count FROM telegram_adoption_retention_daily",
    ).all()).toEqual([{ quality: "pre_rollout_unavailable", cohort_size: 0, retained_count: 0 }]);
  });
});

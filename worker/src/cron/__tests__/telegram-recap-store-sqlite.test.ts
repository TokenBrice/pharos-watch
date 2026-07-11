import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  getTelegramRecapPreference,
  listDueTelegramRecapPreferences,
  projectTelegramRecapTerminalOutcome,
  pruneTelegramRecapTargets,
  queueTelegramRecapTarget,
  recordTelegramRecapSkip,
  setTelegramRecapPreference,
} from "../telegram-recap-store";

const NOW = 1_800_000_000;
const dbs: DatabaseSync[] = [];

function setup(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  const dir = process.cwd().endsWith("/worker") ? join(process.cwd(), "migrations") : join(process.cwd(), "worker/migrations");
  for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, file), "utf8"));
  }
  dbs.push(sqlite);
  return { sqlite, db: createSqliteD1(sqlite) };
}

function subscriber(sqlite: DatabaseSync, chatId: string, generation = 0): void {
  sqlite.prepare(`INSERT INTO telegram_subscribers
    (chat_id, created_at, last_active_at, preference_generation)
    VALUES (?, ?, ?, ?)`).run(chatId, NOW - 100, NOW - 10, generation);
}

function preferenceInput(chatId: string, generation = 0, nextDueAt: number | null = NOW - 1) {
  return { chatId, enabled: true, deliveryHourLocal: 9, nextDueAt, nowSec: NOW, expectedPreferenceGeneration: generation };
}

function target(chatId: string, generation = 1, localDate = "2026-07-11") {
  return {
    recapKey: `recap:${chatId}:${localDate}:v1`, chatId, localDate,
    windowStartAt: NOW - 86400, windowEndAt: NOW,
    preferenceGeneration: generation, watchlistFingerprint: "watch:v1",
    payloadHash: "payload:v1", materialCoinCount: 1, materialFactCount: 1,
    pendingDedupeKey: `recap:${chatId}:${localDate}:v1`, messageHtml: "<b>USDC</b> changed",
    nextDueAtAfter: NOW + 86400,
    nowSec: NOW, expectedNextDueAt: NOW - 1,
  };
}

afterEach(() => { while (dbs.length > 0) dbs.pop()?.close(); });

describe("telegram recap store on latest SQLite schema", () => {
  it("creates guarded preferences and returns due pages", async () => {
    const { sqlite, db } = setup();
    subscriber(sqlite, "42");
    await expect(setTelegramRecapPreference(db, preferenceInput("42"))).resolves.toBe(true);
    await expect(getTelegramRecapPreference(db, "42")).resolves.toMatchObject({
      chatId: "42", enabled: true, preferenceGeneration: 1, nextDueAt: NOW - 1,
    });
    await expect(listDueTelegramRecapPreferences(db, NOW)).resolves.toHaveLength(1);
    await expect(setTelegramRecapPreference(db, preferenceInput("42", 0, NOW + 10))).resolves.toBe(false);
    expect(sqlite.prepare("SELECT next_due_at, preference_generation FROM telegram_recap_preferences p JOIN telegram_subscribers s USING (chat_id) WHERE p.chat_id = '42'").get()).toEqual({ next_due_at: NOW - 1, preference_generation: 1 });
  });

  it("hands target, pending row, identity, and schedule together", async () => {
    const { sqlite, db } = setup();
    subscriber(sqlite, "42");
    await setTelegramRecapPreference(db, preferenceInput("42"));
    await expect(queueTelegramRecapTarget(db, target("42"))).resolves.toBe("queued");
    expect(sqlite.prepare("SELECT status, pending_id FROM telegram_recap_targets").get()).toMatchObject({ status: "queued" });
    expect(sqlite.prepare("SELECT source_type, priority, source_event_id, preference_generation FROM telegram_pending_alerts").get()).toEqual({ source_type: "personalized_recap", priority: 100, source_event_id: "recap:42:2026-07-11:v1", preference_generation: 1 });
    expect(sqlite.prepare("SELECT next_due_at FROM telegram_recap_preferences WHERE chat_id = '42'").get()).toEqual({ next_due_at: NOW + 86400 });
    await expect(queueTelegramRecapTarget(db, target("42"))).resolves.toBe("stale");
  });

  it("records no-change, paused, and stale outcomes with the right window policy", async () => {
    const { sqlite, db } = setup();
    for (const [chatId, status] of [["none", "skipped_no_changes"], ["pause", "skipped_paused"], ["stale", "skipped_stale"]] as const) {
      subscriber(sqlite, chatId);
      await setTelegramRecapPreference(db, preferenceInput(chatId));
      await expect(recordTelegramRecapSkip(db, { target: target(chatId), status })).resolves.toBe(true);
    }
    const rows = sqlite.prepare("SELECT chat_id, last_window_end_at FROM telegram_recap_preferences ORDER BY chat_id").all() as { chat_id: string; last_window_end_at: number | null }[];
    expect(rows).toEqual([
      { chat_id: "none", last_window_end_at: NOW },
      { chat_id: "pause", last_window_end_at: NOW },
      { chat_id: "stale", last_window_end_at: null },
    ]);
  });

  it("projects sent and execution-unknown terminal states monotonically", async () => {
    const { sqlite, db } = setup();
    subscriber(sqlite, "42");
    await setTelegramRecapPreference(db, preferenceInput("42"));
    await queueTelegramRecapTarget(db, target("42"));
    await expect(projectTelegramRecapTerminalOutcome(db, "recap:42:2026-07-11:v1", "execution_unknown", NOW + 1, "ambiguous")).resolves.toBe(true);
    expect(sqlite.prepare("SELECT status, terminal_reason FROM telegram_recap_targets").get()).toEqual({ status: "execution_unknown", terminal_reason: "ambiguous" });
    expect(sqlite.prepare("SELECT last_window_end_at, last_delivered_local_date FROM telegram_recap_preferences").get()).toEqual({ last_window_end_at: NOW, last_delivered_local_date: "2026-07-11" });
    await expect(projectTelegramRecapTerminalOutcome(db, "recap:42:2026-07-11:v1", "accepted", NOW + 2)).resolves.toBe(false);
  });

  it("does not consume a fact window after a permanent failure and cancels queued work on disable", async () => {
    const { sqlite, db } = setup();
    subscriber(sqlite, "42");
    await setTelegramRecapPreference(db, preferenceInput("42"));
    await queueTelegramRecapTarget(db, target("42"));
    await expect(projectTelegramRecapTerminalOutcome(db, "recap:42:2026-07-11:v1", "failed_permanent", NOW + 1)).resolves.toBe(true);
    expect(sqlite.prepare("SELECT last_window_end_at FROM telegram_recap_preferences WHERE chat_id = '42'").get()).toEqual({ last_window_end_at: null });

    await setTelegramRecapPreference(db, {
      chatId: "42", enabled: true, deliveryHourLocal: 9, nextDueAt: NOW - 1, nowSec: NOW + 2,
    });
    await queueTelegramRecapTarget(db, target("42", 2, "2026-07-12"));
    await expect(setTelegramRecapPreference(db, {
      chatId: "42", enabled: false, deliveryHourLocal: 9, nextDueAt: null, nowSec: NOW + 3,
    })).resolves.toBe(true);
    expect(sqlite.prepare("SELECT status FROM telegram_recap_targets WHERE recap_key = 'recap:42:2026-07-12:v1'").get()).toEqual({ status: "cancelled" });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts WHERE source_event_id = 'recap:42:2026-07-12:v1'").get()).toEqual({ count: 0 });
  });

  it("prunes aggregate rows at 30 days and uncertain outcomes at 90 days", async () => {
    const { sqlite, db } = setup();
    sqlite.prepare(`INSERT INTO telegram_recap_targets
      (recap_key, chat_id, local_date, window_start_at, window_end_at, preference_generation, watchlist_fingerprint, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, 'x', ?, ?, ?)`).run("old-skip", "1", "2026-06-01", 1, 2, "skipped_no_changes", 1, NOW - 86400);
    sqlite.prepare(`INSERT INTO telegram_recap_targets
      (recap_key, chat_id, local_date, window_start_at, window_end_at, preference_generation, watchlist_fingerprint, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, 'x', ?, ?, ?)`).run("old-unknown", "2", "2026-06-01", 1, 2, "execution_unknown", 1, NOW - 31 * 86400);
    sqlite.prepare(`INSERT INTO telegram_recap_targets
      (recap_key, chat_id, local_date, window_start_at, window_end_at, preference_generation, watchlist_fingerprint, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, 'x', ?, ?, ?)`).run("very-old-unknown", "3", "2026-06-01", 1, 2, "execution_unknown", 1, NOW - 91 * 86400);
    await expect(pruneTelegramRecapTargets(db, NOW)).resolves.toEqual({ deletedTargets: 1 });
    expect(sqlite.prepare("SELECT recap_key FROM telegram_recap_targets ORDER BY recap_key").all()).toEqual([{ recap_key: "old-skip" }, { recap_key: "old-unknown" }]);
  });
});

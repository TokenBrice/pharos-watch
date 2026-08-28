import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { PAUSE_SENTINEL_TS } from "../../lib/telegram-constants";
import { planTelegramPersonalizedRecaps } from "../telegram-recap-planner";
import { buildTelegramRecapDedupeKey } from "../../lib/telegram-recap-store";

const NOW = 1_800_000_000;
const databases: DatabaseSync[] = [];

function setup(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  const migrationDirectory = process.cwd().endsWith("/worker")
    ? join(process.cwd(), "migrations")
    : join(process.cwd(), "worker/migrations");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- checked-in migration directory only.
  for (const file of readdirSync(migrationDirectory).filter((entry) => entry.endsWith(".sql")).sort()) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- checked-in migration replay only.
    sqlite.exec(readFileSync(join(migrationDirectory, file), "utf8"));
  }
  databases.push(sqlite);
  return { sqlite, db: createSqliteD1(sqlite) };
}

function insertSubscriber(sqlite: DatabaseSync, chatId: string, options: { globalDepeg?: boolean } = {}): void {
  sqlite.prepare(`INSERT INTO telegram_subscribers
    (chat_id, created_at, last_active_at, timezone, global_alert_depeg)
    VALUES (?, ?, ?, 'Europe/Belgrade', ?)`)
    .run(chatId, NOW - 100, NOW - 10, options.globalDepeg ? 1 : 0);
  sqlite.prepare(`INSERT INTO telegram_recap_preferences
    (chat_id, enabled, cadence, delivery_hour_local, next_due_at, created_at, updated_at)
    VALUES (?, 1, 'daily', 9, ?, ?, ?)`).run(chatId, NOW - 1, NOW - 100, NOW - 100);
}

function insertTape(
  sqlite: DatabaseSync,
  eventId: string,
  atSec: number,
  coinId = "usdc-circle",
): void {
  sqlite.prepare(`INSERT INTO tape_events
    (event_id, type, severity, ts, coin_id, title, summary, payload_json, source_table, source_row_id, transition, created_at)
    VALUES (?, 'depeg.opened', 'warning', ?, ?, 'x', 'x', ?, 'test', ?, 'opened', ?)`)
    .run(eventId, atSec * 1000, coinId, JSON.stringify({ direction: "below", absDeviationBps: 120 }), eventId, atSec);
}

function markTapeFresh(sqlite: DatabaseSync, atSec = NOW - 1): void {
  sqlite.prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status) VALUES ('project-tape', ?, 1, 'ok')").run(atSec);
}

function insertStablecoinsCache(sqlite: DatabaseSync): void {
  sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('stablecoins', ?, ?)").run(JSON.stringify({
    peggedAssets: [
      { id: "usdc-circle", symbol: "USDC", circulating: { peggedUSD: 1_000_000_000 } },
      { id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 2_000_000_000 } },
    ],
  }), NOW);
}

afterEach(() => { while (databases.length > 0) databases.pop()?.close(); });

describe("telegram personalized recap planner", () => {
  it("plans deterministic direct and explicit global recaps without network access", async () => {
    const { sqlite, db } = setup();
    insertSubscriber(sqlite, "direct");
    insertSubscriber(sqlite, "global", { globalDepeg: true });
    sqlite.prepare("INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_depeg) VALUES ('direct', 'usdc-circle', 1)").run();
    markTapeFresh(sqlite);
    insertTape(sqlite, "recap-depeg-1", NOW - 60);

    const fetchMock = mockFetch([], { requireMatch: true });
    try {
      const result = await planTelegramPersonalizedRecaps(db, undefined, { nowSec: NOW });
      expect(result.status).toBe("ok");
      expect(JSON.parse(result.metadata)).toMatchObject({
        pagesAttempted: 1,
        pagesCompleted: 1,
        queued: 2,
        factsLoaded: 1,
        factsAdmitted: 1,
        factsRejected: 0,
        aiCalls: 0,
        externalPlanningFetches: 0,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }

    expect(sqlite.prepare("SELECT chat_id, source_type, priority FROM telegram_pending_alerts ORDER BY chat_id").all()).toEqual([
      { chat_id: "direct", source_type: "personalized_recap", priority: 100 },
      { chat_id: "global", source_type: "personalized_recap", priority: 100 },
    ]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_recap_targets WHERE status = 'queued'").get()).toEqual({ count: 2 });
  });

  it("projects dark rollout material recaps without writing targets, pending rows, or schedules", async () => {
    const { sqlite, db } = setup();
    insertSubscriber(sqlite, "direct");
    sqlite.prepare("INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_depeg) VALUES ('direct', 'usdc-circle', 1)").run();
    markTapeFresh(sqlite);
    insertTape(sqlite, "recap-depeg-1", NOW - 60);

    const result = await planTelegramPersonalizedRecaps(db, undefined, {
      nowSec: NOW,
      rolloutPolicy: { mode: "dark", allowedChatIds: new Set() },
    });

    expect(JSON.parse(result.metadata)).toMatchObject({
      projected: 1,
      projectedMaterial: 1,
      queued: 0,
      rollout: { mode: "dark", pendingEffects: false },
    });
    expect(sqlite.prepare("SELECT next_due_at FROM telegram_recap_preferences WHERE chat_id = 'direct'").get())
      .toEqual({ next_due_at: NOW - 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_recap_targets").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts").get()).toEqual({ count: 0 });
  });

  it("fails closed while Tape is stale without advancing a retryable schedule", async () => {
    const { sqlite, db } = setup();
    insertSubscriber(sqlite, "direct");
    sqlite.prepare("INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_depeg) VALUES ('direct', 'usdc-circle', 1)").run();
    markTapeFresh(sqlite, NOW - 91 * 60);

    const result = await planTelegramPersonalizedRecaps(db, undefined, { nowSec: NOW });
    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata)).toMatchObject({ tapeFreshness: "stale", queued: 0, stale: 0 });
    expect(sqlite.prepare("SELECT next_due_at FROM telegram_recap_preferences WHERE chat_id = 'direct'").get())
      .toEqual({ next_due_at: NOW - 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_recap_targets").get()).toEqual({ count: 0 });
  });

  it("defers the entire due page rather than deriving a recap from truncated Tape rows", async () => {
    const { sqlite, db } = setup();
    insertSubscriber(sqlite, "direct");
    sqlite.prepare("INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_depeg) VALUES ('direct', 'usdc-circle', 1)").run();
    markTapeFresh(sqlite);
    insertTape(sqlite, "recap-depeg-1", NOW - 60);
    insertTape(sqlite, "recap-depeg-2", NOW - 30);

    const result = await planTelegramPersonalizedRecaps(db, undefined, { nowSec: NOW, tapePageLimit: 1 });
    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata)).toMatchObject({ truncatedDeferred: 1, queued: 0 });
    expect(sqlite.prepare("SELECT next_due_at FROM telegram_recap_preferences WHERE chat_id = 'direct'").get())
      .toEqual({ next_due_at: NOW - 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_recap_targets").get()).toEqual({ count: 0 });
  });

  it("skips an expired delivery window instead of bursting an overdue recap after recovery", async () => {
    const { sqlite, db } = setup();
    const scheduledAt = Math.floor(Date.parse("2027-01-14T14:00:00Z") / 1_000);
    const lateNow = Math.floor(Date.parse("2027-01-14T23:12:00Z") / 1_000);
    const nextLocalDelivery = Math.floor(Date.parse("2027-01-15T14:00:00Z") / 1_000);
    insertSubscriber(sqlite, "late-recap");
    sqlite.prepare("UPDATE telegram_subscribers SET timezone = 'Europe/Paris' WHERE chat_id = 'late-recap'").run();
    sqlite.prepare(`UPDATE telegram_recap_preferences
      SET delivery_hour_local = 15, next_due_at = ?
      WHERE chat_id = 'late-recap'`).run(scheduledAt);
    sqlite.prepare("INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_depeg) VALUES ('late-recap', 'usdc-circle', 1)").run();
    markTapeFresh(sqlite, lateNow - 1);
    insertTape(sqlite, "late-recap-1", lateNow - 60);
    insertTape(sqlite, "late-recap-2", lateNow - 30);

    const result = await planTelegramPersonalizedRecaps(db, undefined, {
      nowSec: lateNow,
      tapePageLimit: 1,
    });

    expect(result.status).toBe("ok");
    expect(JSON.parse(result.metadata)).toMatchObject({
      stale: 1,
      queued: 0,
      truncatedDeferred: 0,
      factsLoaded: 0,
    });
    expect(sqlite.prepare(`SELECT local_date, status, terminal_reason
      FROM telegram_recap_targets WHERE chat_id = 'late-recap'`).get()).toEqual({
      local_date: "2027-01-14",
      status: "skipped_stale",
      terminal_reason: "delivery-window-expired",
    });
    expect(sqlite.prepare("SELECT next_due_at FROM telegram_recap_preferences WHERE chat_id = 'late-recap'").get())
      .toEqual({ next_due_at: nextLocalDelivery });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts").get()).toEqual({ count: 0 });
  });

  it("advances past a sent local-date target instead of rereading a stale due page", async () => {
    const { sqlite, db } = setup();
    const localDate = "2027-01-15";
    const sentAt = Math.floor(Date.parse("2027-01-15T08:00:00Z") / 1_000);
    const scheduledAt = Math.floor(Date.parse("2027-01-15T09:00:00Z") / 1_000);
    const lateNow = Math.floor(Date.parse("2027-01-15T13:30:00Z") / 1_000);
    const nextLocalDelivery = Math.floor(Date.parse("2027-01-16T14:00:00Z") / 1_000);
    const recapKey = buildTelegramRecapDedupeKey("prod-deadlock", localDate);
    insertSubscriber(sqlite, "prod-deadlock");
    sqlite.prepare(`UPDATE telegram_recap_preferences
      SET delivery_hour_local = 15, next_due_at = ?, last_window_end_at = ?,
          last_delivered_local_date = ?
      WHERE chat_id = 'prod-deadlock'`).run(scheduledAt, sentAt, localDate);
    sqlite.prepare(`INSERT INTO telegram_recap_targets
      (recap_key, chat_id, local_date, window_start_at, window_end_at,
       preference_generation, watchlist_fingerprint, status,
       created_at, completed_at, updated_at)
      VALUES (?, 'prod-deadlock', ?, ?, ?, 0, 'sent:v1', 'sent', ?, ?, ?)`)
      .run(recapKey, localDate, sentAt - 3600, sentAt, sentAt, sentAt, sentAt);
    markTapeFresh(sqlite, lateNow - 1);

    const result = await planTelegramPersonalizedRecaps(db, undefined, { nowSec: lateNow });

    expect(result.status).toBe("ok");
    expect(JSON.parse(result.metadata)).toMatchObject({
      pagesAttempted: 1,
      pagesCompleted: 1,
      due: 1,
      stale: 1,
      deferred: 0,
      queued: 0,
      factsLoaded: 0,
    });
    expect(sqlite.prepare(`SELECT next_due_at, last_window_end_at, last_delivered_local_date
      FROM telegram_recap_preferences WHERE chat_id = 'prod-deadlock'`).get()).toEqual({
      next_due_at: nextLocalDelivery,
      last_window_end_at: sentAt,
      last_delivered_local_date: localDate,
    });
    expect(sqlite.prepare("SELECT recap_key, status FROM telegram_recap_targets").all()).toEqual([
      { recap_key: recapKey, status: "sent" },
    ]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts").get()).toEqual({ count: 0 });
  });

  it("plans through the observed public-launch Tape volume without permanently deferring due work", async () => {
    const { sqlite, db } = setup();
    insertSubscriber(sqlite, "global", { globalDepeg: true });
    markTapeFresh(sqlite);
    for (let index = 0; index < 1_600; index += 1) {
      insertTape(sqlite, `recap-volume-${index}`, NOW - 2_000 + index);
    }

    const result = await planTelegramPersonalizedRecaps(db, undefined, { nowSec: NOW });

    expect(result.status).toBe("ok");
    expect(JSON.parse(result.metadata)).toMatchObject({
      factsLoaded: 1_600,
      factsAdmitted: 1_600,
      truncatedDeferred: 0,
      queued: 1,
    });
    expect(sqlite.prepare("SELECT next_due_at > ? AS advanced FROM telegram_recap_preferences WHERE chat_id = 'global'")
      .get(NOW)).toEqual({ advanced: 1 });
  });

  it("does not treat snooze-only or explicit-off rows as watchlist membership", async () => {
    const { sqlite, db } = setup();
    for (const chatId of ["snooze-only", "explicit-off"]) insertSubscriber(sqlite, chatId);
    sqlite.prepare(`INSERT INTO telegram_subscriptions
      (chat_id, stablecoin_id, alert_snooze_until_ts)
      VALUES ('snooze-only', 'usdc-circle', ?)`).run(NOW + 3600);
    sqlite.prepare(`INSERT INTO telegram_subscriptions
      (chat_id, stablecoin_id, alert_depeg_override)
      VALUES ('explicit-off', 'usdc-circle', 1)`).run();
    markTapeFresh(sqlite);
    insertTape(sqlite, "recap-depeg-1", NOW - 60);

    const result = await planTelegramPersonalizedRecaps(db, undefined, { nowSec: NOW });

    expect(JSON.parse(result.metadata)).toMatchObject({ queued: 0, noChanges: 2 });
    expect(sqlite.prepare("SELECT chat_id, status FROM telegram_recap_targets ORDER BY chat_id").all()).toEqual([
      { chat_id: "explicit-off", status: "skipped_no_changes" },
      { chat_id: "snooze-only", status: "skipped_no_changes" },
    ]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts").get()).toEqual({ count: 0 });
  });

  it("collapses overlapping direct and current preset membership to one fact", async () => {
    const { sqlite, db } = setup();
    insertSubscriber(sqlite, "overlap");
    sqlite.prepare("INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_depeg) VALUES ('overlap', 'usdc-circle', 1)").run();
    sqlite.prepare(`INSERT INTO telegram_preset_subscriptions
      (chat_id, preset_id, alert_depeg, created_at, updated_at)
      VALUES ('overlap', 'usd-top25', 1, ?, ?)`).run(NOW - 100, NOW - 100);
    insertStablecoinsCache(sqlite);
    markTapeFresh(sqlite);
    insertTape(sqlite, "recap-depeg-1", NOW - 60);

    const result = await planTelegramPersonalizedRecaps(db, undefined, { nowSec: NOW });

    expect(JSON.parse(result.metadata)).toMatchObject({ queued: 1, presetDeferred: 0 });
    expect(sqlite.prepare("SELECT material_coin_count, material_fact_count FROM telegram_recap_targets").get())
      .toEqual({ material_coin_count: 1, material_fact_count: 1 });
  });

  it("defers preset recipients without advancing when dynamic membership is unavailable", async () => {
    const { sqlite, db } = setup();
    insertSubscriber(sqlite, "preset");
    sqlite.prepare(`INSERT INTO telegram_preset_subscriptions
      (chat_id, preset_id, alert_depeg, created_at, updated_at)
      VALUES ('preset', 'usd-top25', 1, ?, ?)`).run(NOW - 100, NOW - 100);
    markTapeFresh(sqlite);

    const result = await planTelegramPersonalizedRecaps(db, undefined, { nowSec: NOW });

    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata)).toMatchObject({ queued: 0, presetDeferred: 1, pagesDeferred: 1 });
    expect(sqlite.prepare("SELECT next_due_at FROM telegram_recap_preferences WHERE chat_id = 'preset'").get())
      .toEqual({ next_due_at: NOW - 1 });
  });

  it("skips only a durable pause while leaving timed snooze delivery to the queue", async () => {
    const { sqlite, db } = setup();
    for (const chatId of ["paused", "timed-snooze"]) {
      insertSubscriber(sqlite, chatId);
      sqlite.prepare("INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_depeg) VALUES (?, 'usdc-circle', 1)").run(chatId);
    }
    sqlite.prepare("UPDATE telegram_subscribers SET alert_snooze_until_ts = ? WHERE chat_id = 'paused'").run(PAUSE_SENTINEL_TS);
    sqlite.prepare("UPDATE telegram_subscribers SET alert_snooze_until_ts = ? WHERE chat_id = 'timed-snooze'").run(NOW + 3600);
    markTapeFresh(sqlite);
    insertTape(sqlite, "recap-depeg-1", NOW - 60);

    const result = await planTelegramPersonalizedRecaps(db, undefined, { nowSec: NOW });

    expect(JSON.parse(result.metadata)).toMatchObject({ paused: 1, queued: 1 });
    expect(sqlite.prepare("SELECT chat_id, status FROM telegram_recap_targets ORDER BY chat_id").all()).toEqual([
      { chat_id: "paused", status: "skipped_paused" },
      { chat_id: "timed-snooze", status: "queued" },
    ]);
  });

  it("stops cooperatively at its soft deadline without advancing due work", async () => {
    const { sqlite, db } = setup();
    insertSubscriber(sqlite, "direct");
    sqlite.prepare("INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_depeg) VALUES ('direct', 'usdc-circle', 1)").run();
    markTapeFresh(sqlite);
    insertTape(sqlite, "recap-depeg-1", NOW - 60);

    const result = await planTelegramPersonalizedRecaps(db, undefined, { nowSec: NOW, softDeadlineMs: 0 });

    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata)).toMatchObject({ queued: 0, softDeadlineDeferred: 1, pagesDeferred: 1 });
    expect(sqlite.prepare("SELECT next_due_at FROM telegram_recap_preferences WHERE chat_id = 'direct'").get())
      .toEqual({ next_due_at: NOW - 1 });
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { PAUSE_SENTINEL_TS } from "../../lib/telegram-constants";
import { planTelegramPersonalizedRecaps } from "../telegram-recap-planner";

const NOW = 1_800_000_000;
const databases: DatabaseSync[] = [];

function setup(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  const migrationDirectory = process.cwd().endsWith("/worker")
    ? join(process.cwd(), "migrations")
    : join(process.cwd(), "worker/migrations");
  for (const file of readdirSync(migrationDirectory).filter((entry) => entry.endsWith(".sql")).sort()) {
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

    const originalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: () => { throw new Error("planner must not fetch"); } });
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
    } finally {
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    }

    expect(sqlite.prepare("SELECT chat_id, source_type, priority FROM telegram_pending_alerts ORDER BY chat_id").all()).toEqual([
      { chat_id: "direct", source_type: "personalized_recap", priority: 100 },
      { chat_id: "global", source_type: "personalized_recap", priority: 100 },
    ]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_recap_targets WHERE status = 'queued'").get()).toEqual({ count: 2 });
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

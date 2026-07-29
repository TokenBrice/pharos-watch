import { describe, expect, it } from "vitest";
import { loadFreshFreezeAlerts } from "../telegram-alert-freeze";
import { dispatchFreezeAlertOutbox } from "../telegram-freeze-outbox";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";

function applyMigrations(sqlite: DatabaseSync): void {
  const migrations = join(process.cwd(), "worker/migrations");
  for (const file of readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort()) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- repo-owned migration fixture
    sqlite.exec(readFileSync(join(migrations, file), "utf8"));
  }
}

function db(rows: unknown[], latestRun: number | null): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() { return this; },
        first: async () => sql.includes("cron_runs")
          ? (latestRun == null ? null : { started_at: latestRun })
          : sql.includes("MAX(id)")
            ? ((rows[rows.length - 1] as { id?: number } | undefined)?.id == null ? null : { id: (rows[rows.length - 1] as { id: number }).id })
            : null,
        all: async () => ({ results: rows }),
      };
    },
  } as unknown as D1Database;
}

describe("freeze Telegram source gate", () => {
  it("fails closed when the tape projector is stale", async () => {
    const result = await loadFreshFreezeAlerts(db([], 100), 5, 4_000);
    expect(result).toEqual({ state: "stale", alerts: [], cursor: 5 });
  });

  it("cold-seeds before delivery and retains immutable tape/blacklist identities", async () => {
    const rows = [{
      id: 42,
      event_id: "1000-freeze.blocked-deadbeef",
      type: "freeze.blocked",
      payload_json: JSON.stringify({
        stablecoin: "USDC",
        chainName: "Ethereum",
        amountUsdAtEvent: 1_000_000,
        sourceEventId: "blacklist-row-42",
      }),
    }];
    const source = db(rows, 3_990);
    const seeded = await loadFreshFreezeAlerts(source, null, 4_000);
    expect(seeded).toEqual({ state: "unseeded", alerts: [], cursor: 42 });

    const observed = await loadFreshFreezeAlerts(source, 41, 4_000);
    expect(observed.state).toBe("ok");
    expect(observed.cursor).toBe(42);
    expect(observed.alerts[0]).toMatchObject({
      stablecoinId: "usdc-circle",
      eventType: "blacklist",
      tapeEventId: "1000-freeze.blocked-deadbeef",
      sourceEventId: "blacklist-row-42",
    });
  });

  it("cold-seeds beyond the page limit without leaking historical tape rows", async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({ id: index + 1 }));
    const seeded = await loadFreshFreezeAlerts(db(rows, 3_990), null, 4_000);
    expect(seeded).toEqual({ state: "unseeded", alerts: [], cursor: 501 });
  });
});

describe("freeze dedicated outbox", () => {
  it("advances no-audience freeze events without durable outbox work", async () => {
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(sqlite);
    try {
      const now = 2_000_000_000;
      sqlite.prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status) VALUES ('project-tape', ?, 1, 'ok')").run(now - 5);
      sqlite.prepare(
        `INSERT INTO tape_events (event_id, type, severity, ts, title, summary, payload_json, source_table, source_row_id, transition, created_at)
         VALUES ('freeze-baseline', 'freeze.blocked', 'warning', ?, 'x', 'x', ?, 'blacklist_events', 'blacklist-baseline', 'opened', ?)`,
      ).run(now * 1000, JSON.stringify({ stablecoin: 'USDC', stablecoinId: 'usdc-circle', chainName: 'Ethereum', sourceEventId: 'blacklist-baseline' }), now);
      const database = createSqliteD1(sqlite);
      await dispatchFreezeAlertOutbox(database, now);

      sqlite.prepare(
        `INSERT INTO tape_events (event_id, type, severity, ts, title, summary, payload_json, source_table, source_row_id, transition, created_at)
         VALUES ('freeze-no-audience', 'freeze.blocked', 'warning', ?, 'x', 'x', ?, 'blacklist_events', 'blacklist-no-audience', 'opened', ?)`,
      ).run((now + 1) * 1000, JSON.stringify({ stablecoin: 'USDC', stablecoinId: 'usdc-circle', chainName: 'Ethereum', sourceEventId: 'blacklist-no-audience' }), now + 1);

      const result = await dispatchFreezeAlertOutbox(database, now + 2);
      expect(result).toMatchObject({
        state: "idle",
        observed: 1,
        queued: 0,
        skippedNoAudience: 1,
      });
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_freeze_alert_events").get()).toMatchObject({ n: 0 });
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_pending_alerts WHERE alert_type = 'freeze'").get()).toMatchObject({ n: 0 });
      expect(sqlite.prepare("SELECT value FROM cache WHERE key = 'alert:freeze-tape-cursor'").get())
        .toMatchObject({ value: "2" });
    } finally {
      sqlite.close();
    }
  });

  it("captures only opted-in direct/global chats, queues canonical terminal lineage, and never inserts generic target plans", async () => {
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(sqlite);
    try {
      const now = 2_000_000_000;
      sqlite.prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status) VALUES ('project-tape', ?, 1, 'ok')").run(now - 5);
      sqlite.prepare(
        `INSERT INTO telegram_subscribers (
           chat_id, created_at, last_active_at, preference_generation, global_alert_freeze,
           quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc
         ) VALUES
           ('1', ?, ?, 4, 1, 0, NULL, NULL),
           ('2', ?, ?, 5, 0, 1, 0, 5),
           ('3', ?, ?, 6, 1, 0, NULL, NULL),
           ('4', ?, ?, 7, 1, 0, NULL, NULL),
           ('5', ?, ?, 8, 0, 0, NULL, NULL)`,
      ).run(now, now, now, now, now, now, now, now, now, now);
      sqlite.prepare(
        `INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_freeze, alert_freeze_override)
         VALUES
           ('2', 'usdc-circle', 1, 0),
           ('3', 'usdc-circle', 0, 1),
           ('5', 'usdc-circle', 1, 0)`,
      ).run();
      sqlite.prepare("UPDATE telegram_subscribers SET alert_snooze_until_ts = ? WHERE chat_id = '4'").run(now + 60);
      sqlite.prepare("UPDATE telegram_subscriptions SET alert_snooze_until_ts = ? WHERE chat_id = '5'").run(now + 60);
      sqlite.prepare(
        `INSERT INTO tape_events (event_id, type, severity, ts, title, summary, payload_json, source_table, source_row_id, transition, created_at)
         VALUES ('freeze-1', 'freeze.blocked', 'warning', ?, 'x', 'x', ?, 'blacklist_events', 'blacklist-1', 'opened', ?)`,
      ).run(now * 1000, JSON.stringify({ stablecoin: 'USDC', stablecoinId: 'usdc-circle', chainName: 'Ethereum', amountUsdAtEvent: null, sourceEventId: 'blacklist-1' }), now);
      const db = createSqliteD1(sqlite);
      // First healthy read establishes the no-historical-alert baseline.
      await dispatchFreezeAlertOutbox(db, now);
      sqlite.prepare(
        `INSERT INTO tape_events (event_id, type, severity, ts, title, summary, payload_json, source_table, source_row_id, transition, created_at)
         VALUES ('freeze-2', 'freeze.blocked', 'warning', ?, 'x', 'x', ?, 'blacklist_events', 'blacklist-2', 'opened', ?)`,
      ).run((now + 1) * 1000, JSON.stringify({ stablecoin: 'USDC', stablecoinId: 'usdc-circle', chainName: 'Ethereum', amountUsdAtEvent: null, sourceEventId: 'blacklist-2' }), now + 1);
      const result = await dispatchFreezeAlertOutbox(db, now + 2);
      expect(result.queued).toBe(2);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_freeze_alert_targets").get()).toMatchObject({ n: 2 });
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_pending_alerts WHERE alert_type = 'freeze'").get()).toMatchObject({ n: 2 });
      expect(sqlite.prepare("SELECT disable_notification FROM telegram_pending_alerts WHERE chat_id = '2'").get())
        .toMatchObject({ disable_notification: 1 });
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_alert_job_targets WHERE alert_type = 'freeze'").get()).toMatchObject({ n: 2 });
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_alert_target_plans").get()).toMatchObject({ n: 0 });
    } finally {
      sqlite.close();
    }
  });

  it("freezes cohort membership across paged resumes and preserves the original expiry", async () => {
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(sqlite);
    try {
      const now = 2_000_000_000;
      sqlite.prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status) VALUES ('project-tape', ?, 1, 'ok')").run(now - 5);
      const insertSubscriber = sqlite.prepare(
        `INSERT INTO telegram_subscribers (
           chat_id, created_at, last_active_at, preference_generation, global_alert_freeze
         ) VALUES (?, ?, ?, 1, 1)`,
      );
      for (let index = 1; index <= 91; index += 1) insertSubscriber.run(String(index), now, now);
      const insertTape = sqlite.prepare(
        `INSERT INTO tape_events (
           event_id, type, severity, ts, title, summary, payload_json,
           source_table, source_row_id, transition, created_at
         ) VALUES (?, 'freeze.blocked', 'warning', ?, 'x', 'x', ?, 'blacklist_events', ?, 'opened', ?)`,
      );
      insertTape.run(
        'freeze-baseline',
        now * 1000,
        JSON.stringify({ stablecoin: 'USDC', stablecoinId: 'usdc-circle', chainName: 'Ethereum', sourceEventId: 'blacklist-baseline' }),
        'blacklist-baseline',
        now,
      );
      const database = createSqliteD1(sqlite);
      await dispatchFreezeAlertOutbox(database, now);
      insertTape.run(
        'freeze-paged',
        (now + 1) * 1000,
        JSON.stringify({ stablecoin: 'USDC', stablecoinId: 'usdc-circle', chainName: 'Ethereum', sourceEventId: 'blacklist-paged' }),
        'blacklist-paged',
        now + 1,
      );

      const first = await dispatchFreezeAlertOutbox(database, now + 2);
      expect(first.queued).toBe(90);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_freeze_alert_targets").get()).toMatchObject({ n: 91 });
      const originalExpiry = now + 2 + 2 * 60 * 60;
      expect(sqlite.prepare("SELECT expires_at FROM telegram_freeze_alert_events WHERE tape_event_id = 'freeze-paged'").get())
        .toMatchObject({ expires_at: originalExpiry });

      insertSubscriber.run('late-subscriber', now + 3, now + 3);
      sqlite.prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status) VALUES ('project-tape', ?, 1, 'ok')")
        .run(originalExpiry - 2);
      const resumed = await dispatchFreezeAlertOutbox(database, originalExpiry - 1);
      expect(resumed.queued).toBe(1);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_freeze_alert_targets").get()).toMatchObject({ n: 91 });
      expect(sqlite.prepare("SELECT expires_at FROM telegram_alert_jobs WHERE source_event_id = 'freeze:freeze-paged'").get())
        .toMatchObject({ expires_at: originalExpiry });
      expect(sqlite.prepare("SELECT expires_at FROM telegram_pending_alerts WHERE chat_id = '91'").get())
        .toMatchObject({ expires_at: originalExpiry });
    } finally {
      sqlite.close();
    }
  });
});

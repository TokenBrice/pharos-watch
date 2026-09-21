import { describe, expect, it, vi } from "vitest";
import { loadFreshFreezeAlerts } from "../telegram-alert-freeze";
import { dispatchFreezeAlertOutbox } from "../telegram-freeze-outbox";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { makeNoopD1 } from "../../test-helpers/noop-d1";

function db(rows: unknown[], latestRun: number | null): D1Database {
  return makeNoopD1({
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
  });
}
function createPoisonFreezeTape() {
  const sqlite = createLatestSchemaSqlite().sqlite;
  const now = 2_000_000_000;
  sqlite.prepare(
    "INSERT INTO cron_runs (job, started_at, duration_ms, status) VALUES ('project-tape', ?, 1, 'ok')",
  ).run(now - 5);
  sqlite.prepare(
    `INSERT INTO tape_events (
       event_id, type, severity, ts, title, summary, payload_json,
       source_table, source_row_id, transition, created_at
     ) VALUES ('freeze-poison', 'freeze.blocked', 'warning', ?, 'x', 'x', ?,
       'blacklist_events', 'blacklist-poison', 'opened', ?)`,
  ).run(
    now * 1000,
    JSON.stringify({
      stablecoin: "NOT_TRACKED",
      chainName: "Ethereum",
      sourceEventId: "blacklist-poison",
    }),
    now,
  );
  const row = sqlite.prepare("SELECT id FROM tape_events WHERE event_id = 'freeze-poison'").get() as { id: number };
  return { sqlite, database: createSqliteD1(sqlite), now, rowId: row.id };
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
  it("holds below an unparseable row so the next run retries that row", async () => {
    const { sqlite, database, now, rowId } = createPoisonFreezeTape();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const first = await loadFreshFreezeAlerts(database, rowId - 1, now);
      const retried = await loadFreshFreezeAlerts(database, first.cursor, now + 1);

      expect(first).toMatchObject({ cursor: rowId - 1, droppedUnparsed: 1 });
      expect(retried).toMatchObject({ cursor: rowId - 1, droppedUnparsed: 1 });
      expect(JSON.parse(String(sqlite.prepare(
        "SELECT value FROM cache WHERE key = 'alert:freeze-tape-row-hold'",
      ).get()?.value))).toEqual({ rowId, attempts: 2 });
    } finally {
      warn.mockRestore();
      sqlite.close();
    }
  });

  it("dead-letters a poison row and advances after the bounded retry limit", async () => {
    const { sqlite, database, now, rowId } = createPoisonFreezeTape();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const first = await loadFreshFreezeAlerts(database, rowId - 1, now);
      const second = await loadFreshFreezeAlerts(database, first.cursor, now + 1);
      const escalated = await loadFreshFreezeAlerts(database, second.cursor, now + 2);

      expect(escalated).toMatchObject({
        cursor: rowId,
        droppedUnparsed: 1,
        deadLetteredUnparsed: 1,
      });
      expect(sqlite.prepare(
        "SELECT value FROM cache WHERE key = 'alert:freeze-tape-row-hold'",
      ).get()).toBeUndefined();
      expect(error).toHaveBeenCalledOnce();
      expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
        level: "error",
        action: "freeze-row-dead-lettered",
        failureKind: "poison-row",
        reason: "unknown-coin",
        attempts: 3,
      });
    } finally {
      error.mockRestore();
      warn.mockRestore();
      sqlite.close();
    }
  });

});

describe("freeze dedicated outbox", () => {
  it("advances no-audience freeze events without durable outbox work", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;
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
    const sqlite = createLatestSchemaSqlite().sqlite;
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
    const sqlite = createLatestSchemaSqlite().sqlite;
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

  it("records freeze job counters from the authoritative target buckets", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    try {
      const now = 2_000_000_000;
      sqlite.prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status) VALUES ('project-tape', ?, 1, 'ok')").run(now - 5);
      sqlite.prepare(
        `INSERT INTO tape_events (event_id, type, severity, ts, title, summary, payload_json, source_table, source_row_id, transition, created_at)
         VALUES ('freeze-mixed-baseline', 'freeze.blocked', 'warning', ?, 'x', 'x', ?, 'blacklist_events', 'blacklist-mixed-baseline', 'opened', ?)`,
      ).run(now * 1000, JSON.stringify({ stablecoin: 'USDC', stablecoinId: 'usdc-circle', chainName: 'Ethereum', sourceEventId: 'blacklist-mixed-baseline' }), now);
      const db = createSqliteD1(sqlite);
      await dispatchFreezeAlertOutbox(db, now);

      // Crash-resumable freeze event: the captured cohort already queued three
      // targets, delivered two, cancelled one, and left two planned — one for a
      // subscriber that has since left (never queued again) and one for a
      // remaining subscriber that this resume run queues.
      sqlite.prepare(
        `INSERT INTO telegram_freeze_alert_events (
           source_event_id, tape_event_id, blacklist_event_id, event_type,
           detected_at, expires_at, payload_json, status, created_at, updated_at, cohort_captured_at
         ) VALUES ('freeze:freeze-mixed', 'freeze-mixed', 'blacklist-mixed', 'blacklist',
                   ?, ?, ?, 'planning', ?, ?, ?)`,
      ).run(
        now,
        now + 2 * 60 * 60,
        JSON.stringify({
          stablecoinId: 'usdc-circle',
          symbol: 'USDC',
          eventType: 'blacklist',
          chainName: 'Ethereum',
          amountUsdAtEvent: null,
          tapeEventId: 'freeze-mixed',
          sourceEventId: 'blacklist-mixed',
        }),
        now,
        now,
        now,
      );
      sqlite.prepare(
        `INSERT INTO telegram_subscribers (
           chat_id, created_at, last_active_at, preference_generation, global_alert_freeze
         ) VALUES ('1', ?, ?, 1, 1)`,
      ).run(now, now);
      const insertFreezeTarget = sqlite.prepare(
        `INSERT INTO telegram_freeze_alert_targets (
           source_event_id, target_key, chat_id, preference_generation,
           pending_dedupe_key, status, created_at
         ) VALUES ('freeze:freeze-mixed', ?, ?, 1, ?, 'planned', ?)`,
      );
      insertFreezeTarget.run('freeze:freeze-mixed:1', '1', 'freeze:freeze-mixed:1', now);
      insertFreezeTarget.run('freeze:freeze-mixed:8', '8', 'freeze:freeze-mixed:8', now);
      sqlite.prepare(
        `INSERT INTO telegram_alert_jobs (
           job_id, alert_type, source_event_id, severity, created_at, expires_at, status,
           target_count, sent_count, enqueued_count, failed_count, metadata
         ) VALUES ('telegram:freeze:freeze-mixed:freeze', 'freeze', 'freeze:freeze-mixed', 'risk', ?, ?, 'discovered', 0, 0, 0, 0, ?)`,
      ).run(now, now + 2 * 60 * 60, JSON.stringify({ source: 'freeze-outbox' }));
      const insertJobTarget = sqlite.prepare(
        `INSERT INTO telegram_alert_job_targets (
           job_id, target_key, chat_id, chunk_index, alert_type, status,
           pending_dedupe_key, created_at, cancelled_at
         ) VALUES ('telegram:freeze:freeze-mixed:freeze', ?, ?, 0, 'freeze', ?, ?, ?, ?)`,
      );
      insertJobTarget.run('queued-a', '2', 'queued', 'pending-queued-a', now, null);
      insertJobTarget.run('queued-b', '3', 'queued', 'pending-queued-b', now, null);
      insertJobTarget.run('queued-c', '4', 'queued', 'pending-queued-c', now, null);
      insertJobTarget.run('sent-a', '5', 'sent', 'pending-sent-a', now, null);
      insertJobTarget.run('sent-b', '6', 'sent', 'pending-sent-b', now, null);
      insertJobTarget.run('cancelled-a', '7', 'queued', 'pending-cancelled-a', now, now);
      insertJobTarget.run('straggler-a', '8', 'planned', 'pending-straggler-a', now, null);

      const result = await dispatchFreezeAlertOutbox(db, now + 2);
      expect(result.queued).toBe(1);
      const job = sqlite
        .prepare(
          `SELECT status, target_count, planned_count, enqueued_count, accepted_count,
                  sent_count, cancelled_count, failed_count, expired_count, execution_unknown_count, metadata
             FROM telegram_alert_jobs WHERE job_id = 'telegram:freeze:freeze-mixed:freeze'`,
        )
        .get() as Record<string, number | string>;
      expect(job).toMatchObject({
        status: 'discovered',
        target_count: 8,
        planned_count: 1,
        enqueued_count: 4,
        accepted_count: 2,
        sent_count: 2,
        cancelled_count: 1,
        failed_count: 0,
        expired_count: 0,
        execution_unknown_count: 0,
      });
      expect(JSON.parse(String(job.metadata))).toMatchObject({
        source: 'freeze-outbox',
        countersSource: 'authoritative-target-rows',
      });
      expect(sqlite.prepare("SELECT status FROM telegram_freeze_alert_targets WHERE chat_id = '1'").get())
        .toMatchObject({ status: 'queued' });
      expect(sqlite.prepare("SELECT status FROM telegram_freeze_alert_targets WHERE chat_id = '8'").get())
        .toMatchObject({ status: 'planned' });
      expect(sqlite.prepare("SELECT status FROM telegram_freeze_alert_events WHERE source_event_id = 'freeze:freeze-mixed'").get())
        .toMatchObject({ status: 'queued' });
    } finally {
      sqlite.close();
    }
  });
});

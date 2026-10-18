import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { dispatchFreezeAlertOutbox } from "../telegram-freeze-outbox";

export async function createFreezeIdentityFixture() {
  const { sqlite, db } = createLatestSchemaSqlite();
  const now = 2_000_000_000;
  sqlite.prepare(
    "INSERT INTO cron_runs (job, started_at, duration_ms, status) VALUES ('project-tape', ?, 1, 'ok')",
  ).run(now - 5);
  sqlite.prepare(
    `INSERT INTO telegram_subscribers (
       chat_id, created_at, last_active_at, preference_generation, global_alert_freeze
     ) VALUES ('42', ?, ?, 4, 1)`,
  ).run(now, now);
  const insertTape = sqlite.prepare(
    `INSERT INTO tape_events (
       event_id, type, severity, ts, title, summary, payload_json,
       source_table, source_row_id, transition, created_at
     ) VALUES (?, 'freeze.blocked', 'warning', ?, 'x', 'x', ?, 'blacklist_events', ?, 'opened', ?)`,
  );
  function insertFreeze(eventId: string, timestamp: number) {
    const blacklistId = `blacklist-${eventId}`;
    insertTape.run(eventId, timestamp * 1000, JSON.stringify({
      stablecoin: "USDC",
      stablecoinId: "usdc-circle",
      chainName: "Ethereum",
      amountUsdAtEvent: null,
      sourceEventId: blacklistId,
    }), blacklistId, timestamp);
  }
  insertFreeze("baseline", now);
  await dispatchFreezeAlertOutbox(db, now);
  return { sqlite, db, now, insertFreeze };
}

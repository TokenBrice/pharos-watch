import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { cancelRetractedFreezeDeliveries, detectTelegramFreezeJobs, FREEZE_CURSOR_KEY } from "../freeze-job";
import { fanOutPlanningTelegramJobs } from "../run-jobs";

const NOW = 2_000_000_000;
const open: DatabaseSync[] = [];
afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function fixture() {
  const { sqlite } = createLatestSchemaSqlite();
  open.push(sqlite);
  const db = createSqliteD1(sqlite);
  sqlite.prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status) VALUES ('project-tape', ?, 1, 'ok')")
    .run(NOW - 5);
  const insertTape = sqlite.prepare(
    `INSERT INTO tape_events (
       event_id, type, severity, ts, title, summary, payload_json,
       source_table, source_row_id, transition, created_at
     ) VALUES (?, ?, 'warning', ?, 'x', 'x', ?, 'blacklist_events', ?, 'opened', ?)`,
  );
  function insertFreeze(eventId: string, options: { amount?: number | null; type?: string; ts?: number } = {}) {
    const ts = options.ts ?? NOW;
    insertTape.run(eventId, options.type ?? "freeze.blocked", ts * 1000, JSON.stringify({
      stablecoin: "USDC",
      stablecoinId: "usdc-circle",
      chainName: "Ethereum",
      amountUsdAtEvent: options.amount === undefined ? 2_000_000 : options.amount,
      sourceEventId: `blacklist-${eventId}`,
    }), `blacklist-${eventId}`, ts);
  }
  function addChat(chatId: string, global: boolean) {
    sqlite.prepare(
      "INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at, global_alert_freeze) VALUES (?, ?, ?, ?)",
    ).run(chatId, NOW, NOW, global ? 1 : 0);
  }
  return { sqlite, db, insertFreeze, addChat };
}

describe("freeze job detection", () => {
  it("holds a chat over the per-chat cap back as roll-up overflow instead of a live row", async () => {
    const { sqlite, db, insertFreeze, addChat } = fixture();
    addChat("1", true);
    addChat("2", true);
    const prior = sqlite.prepare(
      `INSERT INTO telegram_deliveries (job_id, kind, chat_id, body_hash, families, state, next_attempt_at, expires_at, created_at)
       VALUES (?, 'alert', '1', 'h', 'safety', 'sent', ?, ?, ?)`,
    );
    for (let index = 0; index < 6; index += 1) prior.run(`alert:prior-${index}`, NOW - 600, NOW + 600, NOW - 600);
    insertFreeze("baseline");
    await detectTelegramFreezeJobs(db, NOW);
    insertFreeze("big", { amount: 5_000_000 });
    await detectTelegramFreezeJobs(db, NOW + 1);
    const fanout = await fanOutPlanningTelegramJobs(db, NOW + 1);
    expect(fanout).toMatchObject({ cappedRows: 1, deliveriesPlanned: 1 });
    expect(sqlite.prepare("SELECT chat_id FROM telegram_deliveries WHERE job_id = 'freeze:big'").all())
      .toEqual([{ chat_id: "2" }]);
    expect(sqlite.prepare("SELECT kind, chat_id, source_key FROM telegram_change_log WHERE kind = 'overflow'").all())
      .toEqual([{ kind: "overflow", chat_id: "1", source_key: "overflow:freeze:big:1" }]);
  });


  it("seeds the shared cursor, then creates one job per real-time event atomically with the cursor", async () => {
    const { sqlite, db, insertFreeze, addChat } = fixture();
    addChat("1", true);
    insertFreeze("baseline");
    expect(await detectTelegramFreezeJobs(db, NOW)).toMatchObject({ state: "seeded", jobsCreated: 0 });

    insertFreeze("big", { amount: 5_000_000 });
    insertFreeze("small", { amount: 10 });
    insertFreeze("unknown-amount", { amount: null });
    insertFreeze("destroy", { amount: null, type: "freeze.destroyed" });
    const detected = await detectTelegramFreezeJobs(db, NOW + 1);
    expect(detected).toMatchObject({ state: "queued", observed: 4, jobsCreated: 2 });
    expect(detected.belowRealtimeThreshold.map((event) => event.tapeEventId).sort()).toEqual(["small", "unknown-amount"]);
    expect(sqlite.prepare("SELECT job_id, state FROM telegram_jobs ORDER BY job_id").all()).toEqual([
      { job_id: "freeze:big", state: "planning" },
      { job_id: "freeze:destroy", state: "planning" },
    ]);
    // Below-threshold events are logged for the hourly batch in the cursor's batch.
    expect(sqlite.prepare("SELECT kind, source_key FROM telegram_change_log ORDER BY source_key").all()).toEqual([
      { kind: "freeze", source_key: "freeze:small" },
      { kind: "freeze", source_key: "freeze:unknown-amount" },
    ]);
    const cursor = sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(FREEZE_CURSOR_KEY) as { value: string };
    expect(Number(cursor.value)).toBeGreaterThan(1);
    // Nothing new: no duplicate jobs.
    expect(await detectTelegramFreezeJobs(db, NOW + 2)).toMatchObject({ jobsCreated: 0 });
  });

  it("commits a burst beyond one D1 batch and still advances the cursor", async () => {
    const { sqlite, db, insertFreeze, addChat } = fixture();
    addChat("1", true);
    insertFreeze("baseline");
    await detectTelegramFreezeJobs(db, NOW);
    for (let index = 0; index < 150; index += 1) insertFreeze(`burst-${index}`, { amount: 5_000_000 });
    for (let index = 0; index < 50; index += 1) insertFreeze(`small-${index}`, { amount: 10 });
    const detected = await detectTelegramFreezeJobs(db, NOW + 1);
    expect(detected).toMatchObject({ jobsCreated: 150, observed: 200 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_jobs").get()).toEqual({ n: 150 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_change_log").get()).toEqual({ n: 50 });
    const maxId = sqlite.prepare("SELECT MAX(id) AS id FROM tape_events").get() as { id: number };
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(FREEZE_CURSOR_KEY))
      .toEqual({ value: String(maxId.id) });
  });

  it("advances no-audience events without a job", async () => {
    const { sqlite, db, insertFreeze } = fixture();
    insertFreeze("baseline");
    await detectTelegramFreezeJobs(db, NOW);
    insertFreeze("orphan");
    expect(await detectTelegramFreezeJobs(db, NOW + 1)).toMatchObject({ jobsCreated: 0, skippedNoAudience: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_jobs").get()).toEqual({ n: 0 });
  });

  it("fans out to direct and global opt-ins with the right footer, then cancels queued rows on retraction", async () => {
    const { sqlite, db, insertFreeze, addChat } = fixture();
    addChat("1", true);
    addChat("2", false);
    addChat("3", false);
    sqlite.prepare("INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_freeze) VALUES ('2', 'usdc-circle', 1)").run();
    insertFreeze("baseline");
    await detectTelegramFreezeJobs(db, NOW);
    insertFreeze("event-1");
    await detectTelegramFreezeJobs(db, NOW + 1);
    await fanOutPlanningTelegramJobs(db, NOW + 1);
    const deliveries = sqlite.prepare("SELECT chat_id, body, state, kind, families FROM telegram_deliveries ORDER BY chat_id")
      .all() as Array<{ chat_id: string; body: string; state: string; kind: string; families: string }>;
    expect(deliveries.map((row) => [row.chat_id, row.state, row.kind, row.families])).toEqual([
      ["1", "pending", "freeze", "freeze"],
      ["2", "pending", "freeze", "freeze"],
    ]);
    expect(deliveries[0]!.body).toContain("Via all stablecoins");
    expect(deliveries[1]!.body).toContain("Via your watchlist");

    sqlite.prepare("UPDATE tape_events SET suppressed_at = ?, suppression_reason = 'retracted' WHERE event_id = 'event-1'")
      .run(NOW + 2);
    expect(await cancelRetractedFreezeDeliveries(db, NOW + 2)).toBe(2);
    expect(sqlite.prepare("SELECT DISTINCT state, reason FROM telegram_deliveries").all())
      .toEqual([{ state: "cancelled", reason: "freeze-claim-retracted" }]);
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  inspectAndImportLegacyOverflowBacklog,
  LEGACY_OVERFLOW_MAX_BYTES,
} from "../telegram-legacy-overflow-import";
import { OVERFLOW_PLAN_CACHE_KEY } from "../dispatch-telegram-overflow";
import { loadOldestIncompleteTelegramAlertSourceEvent } from "../telegram-alert-source-events";

const NOW = 1_800_000_000;
const databases: DatabaseSync[] = [];

function setupLatestSchema(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  const migrationDir = process.cwd().endsWith("/worker")
    ? join(process.cwd(), "migrations")
    : join(process.cwd(), "worker/migrations");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- checked-in migration directory.
  for (const file of readdirSync(migrationDir).filter((entry) => entry.endsWith(".sql")).sort()) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- checked-in migration replay.
    sqlite.exec(readFileSync(join(migrationDir, file), "utf8"));
  }
  databases.push(sqlite);
  return { sqlite, db: createSqliteD1(sqlite) };
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

function legacyPlan(chatId: string) {
  return {
    chatId,
    alertType: "dews",
    estimatedChunks: 1,
    expiresAt: NOW + 3_600,
    entry: {
      lastActiveAt: NOW - 10,
      alerts: {
        dews: [{
          stablecoinId: "usdc-circle",
          symbol: "USDC",
          oldBand: "CALM",
          newBand: "WARNING",
          score: 70,
          topSignals: [],
        }],
        depegTriggered: [],
        depegResolved: [],
        depegWorsening: [],
        safety: [],
        launch: [],
        reserve: [],
      },
      quietHoursEnabled: false,
      quietHoursStartUtc: null,
      quietHoursEndUtc: null,
      timezone: null,
      preferenceGeneration: 4,
      specificCount: 1,
      globalCount: 0,
    },
  };
}

function writeCache(sqlite: DatabaseSync, value: string): void {
  sqlite.prepare(
    `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(OVERFLOW_PLAN_CACHE_KEY, value, NOW - 60);
}

describe("legacy Telegram overflow import", () => {
  it("imports a valid blob into synthetic source/target lineage and rechecks reappearance", async () => {
    const { sqlite, db } = setupLatestSchema();
    const blob = JSON.stringify({ version: 1, writtenAt: NOW - 60, plans: [legacyPlan("42")] });
    writeCache(sqlite, blob);

    const imported = await inspectAndImportLegacyOverflowBacklog(db, NOW);
    expect(imported).toMatchObject({ state: "imported", observedPlanCount: 1, importedTargetCount: 1 });
    expect(imported.sourceEventId).toMatch(/^telegram-source:legacy-overflow:v1:/);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cache WHERE key = ?")
      .get(OVERFLOW_PLAN_CACHE_KEY)).toEqual({ count: 0 });
    expect(sqlite.prepare(
      `SELECT source.status, target.status AS target_status, target.source_event_id
         FROM telegram_alert_source_events source
         JOIN telegram_alert_job_targets target ON target.source_event_id = source.source_event_id
        WHERE source.source_event_id = ?`,
    ).get(imported.sourceEventId)).toEqual({
      status: "complete",
      target_status: "queued",
      source_event_id: imported.sourceEventId,
    });
    expect(sqlite.prepare(
      "SELECT source_event_id, preference_generation FROM telegram_pending_alerts",
    ).get()).toEqual({ source_event_id: imported.sourceEventId, preference_generation: 4 });

    writeCache(sqlite, blob);
    const reappeared = await inspectAndImportLegacyOverflowBacklog(db, NOW + 1);
    expect(reappeared.state).toBe("imported");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_job_targets")
      .get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cache WHERE key = ?")
      .get(OVERFLOW_PLAN_CACHE_KEY)).toEqual({ count: 0 });
  });

  it("records corrupt and oversized blobs instead of treating them as empty", async () => {
    const { sqlite, db } = setupLatestSchema();
    writeCache(sqlite, "{broken");
    await expect(inspectAndImportLegacyOverflowBacklog(db, NOW)).resolves.toMatchObject({
      state: "corrupt",
      errorClass: "legacy_overflow_json_invalid",
    });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cache WHERE key = ?")
      .get(OVERFLOW_PLAN_CACHE_KEY)).toEqual({ count: 1 });

    writeCache(sqlite, "x".repeat(LEGACY_OVERFLOW_MAX_BYTES + 1));
    await expect(inspectAndImportLegacyOverflowBacklog(db, NOW + 1)).resolves.toMatchObject({
      state: "oversized",
      observedBytes: LEGACY_OVERFLOW_MAX_BYTES + 1,
    });
  });

  it("continues a blob larger than one materialization page without duplicate targets", async () => {
    const { sqlite, db } = setupLatestSchema();
    const plans = Array.from({ length: 91 }, (_, index) => legacyPlan(String(10_000 + index)));
    writeCache(sqlite, JSON.stringify({ version: 1, writtenAt: NOW - 60, plans }));

    const first = await inspectAndImportLegacyOverflowBacklog(db, NOW);
    expect(first).toMatchObject({ state: "importing", importCursor: 90 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_job_targets")
      .get()).toEqual({ count: 90 });
    let state = first;
    let runs = 1;
    while (state.state !== "imported" && runs < 10) {
      state = await inspectAndImportLegacyOverflowBacklog(db, NOW + runs);
      runs += 1;
    }
    expect(state).toMatchObject({ state: "imported", importCursor: 91, importedTargetCount: 91 });
    expect(runs).toBeGreaterThan(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_job_targets")
      .get()).toEqual({ count: 91 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts")
      .get()).toEqual({ count: 91 });
  });

  it("keeps active and replaced synthetic imports out of normal source planning", async () => {
    const { sqlite, db } = setupLatestSchema();
    const firstPlans = Array.from({ length: 91 }, (_, index) => legacyPlan(String(20_000 + index)));
    writeCache(sqlite, JSON.stringify({ version: 1, writtenAt: NOW - 60, plans: firstPlans }));

    const partial = await inspectAndImportLegacyOverflowBacklog(db, NOW);
    expect(partial).toMatchObject({ state: "importing", importCursor: 90 });
    expect(await loadOldestIncompleteTelegramAlertSourceEvent(db)).toBeNull();

    const replacementBlob = JSON.stringify({
      version: 1,
      writtenAt: NOW - 30,
      plans: [legacyPlan("replacement-chat")],
    });
    writeCache(sqlite, replacementBlob);
    const replacement = await inspectAndImportLegacyOverflowBacklog(db, NOW + 1);
    expect(replacement).toMatchObject({ state: "imported", importCursor: 1 });
    expect(replacement.sourceEventId).not.toBe(partial.sourceEventId);
    expect(sqlite.prepare(
      "SELECT status FROM telegram_alert_source_events WHERE source_event_id = ?",
    ).get(partial.sourceEventId)).toEqual({ status: "planned" });

    sqlite.prepare(
      `INSERT INTO telegram_alert_source_events (
         source_event_id, schema_version, status, detected_at, expires_at,
         event_payload, baseline_payload
       )
       SELECT 'normal-source', schema_version, 'planned', detected_at + 1,
              expires_at, event_payload, baseline_payload
         FROM telegram_alert_source_events
        WHERE source_event_id = ?`,
    ).run(partial.sourceEventId);

    const normalSource = await loadOldestIncompleteTelegramAlertSourceEvent(db);
    expect(normalSource?.sourceEventId).toBe("normal-source");
  });
});

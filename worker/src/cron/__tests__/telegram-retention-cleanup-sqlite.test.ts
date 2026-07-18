import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { runTelegramRetentionCleanup } from "../telegram-retention-cleanup";

const NOW_SEC = 1_800_000_000;
const DAY_SEC = 24 * 60 * 60;

function setupLatestSchema(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  const migrationDir = process.cwd().endsWith("/worker")
    ? join(process.cwd(), "migrations")
    : join(process.cwd(), "worker/migrations");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test replays checked-in migrations only.
  for (const file of readdirSync(migrationDir)
    .filter((entry) => entry.endsWith(".sql"))
    .sort()) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test replays checked-in migrations only.
    sqlite.exec(readFileSync(join(migrationDir, file), "utf8"));
  }
  return { sqlite, db: createSqliteD1(sqlite) };
}

interface SourceFixture {
  id: string;
  ageDays: number;
  terminal: boolean;
  finalDeliveryState: "accepted" | "execution_unknown";
  effectState: "complete" | "execution_unknown";
}

function insertSourceBundle(sqlite: DatabaseSync, fixture: SourceFixture): void {
  const detectedAt = NOW_SEC - fixture.ageDays * DAY_SEC;
  const completedAt = fixture.terminal ? detectedAt + 60 : null;
  const chatId = `chat-${fixture.id}`;
  const jobId = `job-${fixture.id}`;
  const targetKey = `target-${fixture.id}`;
  const planKey = `plan-${fixture.id}`;

  sqlite
    .prepare(
      `INSERT INTO telegram_alert_source_events (
         source_event_id, schema_version, status, detected_at, expires_at,
         event_payload, baseline_payload, target_plan_state, target_plan_generation,
         completed_at
       ) VALUES (?, 1, 'planned', ?, ?, '{}', '{}', 'capturing', 1, ?)`,
    )
    .run(fixture.id, detectedAt, NOW_SEC + DAY_SEC, completedAt);
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_planning_subscribers (
         source_event_id, plan_generation, chat_id, preference_generation,
         last_active_at, captured_at, planning_outcome
       ) VALUES (?, 1, ?, 1, ?, ?, 'target_planned')`,
    )
    .run(fixture.id, chatId, detectedAt, detectedAt);
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_target_plan_pages (
         source_event_id, plan_generation, page_index, status, created_at, updated_at
       ) VALUES (?, 1, 0, 'complete', ?, ?)`,
    )
    .run(fixture.id, detectedAt, detectedAt);
  sqlite
    .prepare("UPDATE telegram_alert_source_events SET target_plan_state = 'planning' WHERE source_event_id = ?")
    .run(fixture.id);
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_target_plans (
         source_event_id, plan_generation, plan_key, page_index, plan_ordinal,
         chat_id, alert_type, status, preference_generation, estimated_chunks,
         plan_payload_json, plan_payload_digest, expected_target_count,
         materialized_target_count, created_at, updated_at, materialized_at
       ) VALUES (?, 1, ?, 0, 0, ?, 'dews', 'materialized', 1, 1,
                 '{}', ?, 1, 1, ?, ?, ?)`,
    )
    .run(fixture.id, planKey, chatId, "a".repeat(64), detectedAt, detectedAt, detectedAt);
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_target_plan_items (
         source_event_id, plan_generation, plan_key, item_key, created_at
       ) VALUES (?, 1, ?, 'dews:usdc-circle', ?)`,
    )
    .run(fixture.id, planKey, detectedAt);
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_target_expiry_progress (
         source_event_id, plan_generation, state, started_at, updated_at, completed_at
       ) VALUES (?, 1, 'complete', ?, ?, ?)`,
    )
    .run(fixture.id, detectedAt, detectedAt, detectedAt);
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_source_resolution_pages (
         source_event_id, page_key, alert_type, page_index, status, created_at, updated_at
       ) VALUES (?, 'dews:0', 'dews', 0, 'complete', ?, ?)`,
    )
    .run(fixture.id, detectedAt, detectedAt);
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_source_resolution_memberships (
         source_event_id, alert_type, preset_id, stablecoin_id, created_at
       ) VALUES (?, 'dews', 'preset-depeg-risk', 'usdc-circle', ?)`,
    )
    .run(fixture.id, detectedAt);
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_source_resolution_targets (
         source_event_id, page_key, preset_id, chat_id, created_at
       ) VALUES (?, 'dews:0', 'preset-depeg-risk', ?, ?)`,
    )
    .run(fixture.id, chatId, detectedAt);
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_jobs (
         job_id, alert_type, source_event_id, severity, created_at, expires_at, status
       ) VALUES (?, 'dews', ?, 'risk', ?, ?, 'sent')`,
    )
    .run(jobId, fixture.id, detectedAt, NOW_SEC + DAY_SEC);
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_job_targets (
         job_id, target_key, chat_id, chunk_index, alert_type, status,
         pending_dedupe_key, created_at, effect_state, source_event_id,
         plan_generation, plan_key, final_delivery_state
       ) VALUES (?, ?, ?, 0, 'dews', 'sent', ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      jobId,
      targetKey,
      chatId,
      `dedupe-${fixture.id}`,
      detectedAt,
      fixture.effectState,
      fixture.id,
      planKey,
      fixture.finalDeliveryState,
    );
  sqlite
    .prepare(
      `UPDATE telegram_alert_source_events
          SET status = ?, target_plan_state = ?, completed_at = ?
        WHERE source_event_id = ?`,
    )
    .run(
      fixture.terminal ? "complete" : "planned",
      fixture.terminal ? "delivery_open" : "planning",
      completedAt,
      fixture.id,
    );
}

function countForSource(sqlite: DatabaseSync, table: string, sourceEventId: string): number {
  const allowedTables = new Set([
    "telegram_alert_source_events",
    "telegram_alert_planning_subscribers",
    "telegram_alert_target_plan_pages",
    "telegram_alert_target_plans",
    "telegram_alert_target_plan_items",
    "telegram_alert_target_expiry_progress",
    "telegram_alert_source_resolution_pages",
    "telegram_alert_source_resolution_memberships",
    "telegram_alert_source_resolution_targets",
    "telegram_alert_jobs",
    "telegram_alert_job_targets",
  ]);
  if (!allowedTables.has(table)) throw new Error(`Unsupported fixture table ${table}`);
  return Number(
    sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE source_event_id = ?`).get(sourceEventId)?.count ?? 0,
  );
}

describe("telegram authoritative retention", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prunes terminal workflow rows and settled replay bundles without deleting ambiguous or active work", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
    const { sqlite, db } = setupLatestSchema();
    insertSourceBundle(sqlite, {
      id: "stale-settled",
      ageDays: 15,
      terminal: true,
      finalDeliveryState: "accepted",
      effectState: "complete",
    });
    insertSourceBundle(sqlite, {
      id: "stale-unknown",
      ageDays: 15,
      terminal: true,
      finalDeliveryState: "execution_unknown",
      effectState: "execution_unknown",
    });
    insertSourceBundle(sqlite, {
      id: "fresh-settled",
      ageDays: 0.5,
      terminal: true,
      finalDeliveryState: "accepted",
      effectState: "complete",
    });
    insertSourceBundle(sqlite, {
      id: "old-active",
      ageDays: 15,
      terminal: false,
      finalDeliveryState: "accepted",
      effectState: "complete",
    });

    const terminalSourcePlan = sqlite
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT source_event_id
           FROM telegram_alert_source_events
          WHERE completed_at < ?
            AND status IN ('complete', 'expired')
          ORDER BY completed_at ASC, source_event_id ASC`,
      )
      .all(NOW_SEC - DAY_SEC) as Array<{ detail: string }>;
    expect(terminalSourcePlan.some((row) => row.detail.includes("idx_tase_terminal_completed"))).toBe(true);

    const result = await runTelegramRetentionCleanup(db);
    const metadata = JSON.parse(result.metadata!) as Record<string, unknown>;
    const workflowTables = [
      "telegram_alert_planning_subscribers",
      "telegram_alert_target_plan_pages",
      "telegram_alert_target_plan_items",
      "telegram_alert_target_expiry_progress",
    ];
    const replayTables = [
      "telegram_alert_source_events",
      "telegram_alert_target_plans",
      "telegram_alert_jobs",
      "telegram_alert_job_targets",
    ];

    for (const table of [...workflowTables, ...replayTables]) {
      expect(countForSource(sqlite, table, "stale-settled"), table).toBe(0);
    }
    for (const table of workflowTables) {
      expect(countForSource(sqlite, table, "stale-unknown"), table).toBe(0);
    }
    for (const table of replayTables) {
      expect(countForSource(sqlite, table, "stale-unknown"), table).toBe(1);
    }
    for (const sourceEventId of ["fresh-settled", "old-active"]) {
      for (const table of [...workflowTables, ...replayTables]) {
        expect(countForSource(sqlite, table, sourceEventId), `${sourceEventId}:${table}`).toBe(1);
      }
    }
    expect(metadata).toMatchObject({
      planningSubscribersPruned: 2,
      targetPlanPagesPruned: 2,
      targetPlanItemsPruned: 2,
      targetExpiryProgressPruned: 2,
      replayJobTargetsPruned: 1,
      targetPlansPruned: 1,
      replayJobsPruned: 1,
      replaySourceEventsPruned: 1,
      retentionDays: {
        alertAudit: 90,
        authoritativeWorkflow: 1,
        authoritativeReplay: 14,
      },
    });
    sqlite.close();
  });
});

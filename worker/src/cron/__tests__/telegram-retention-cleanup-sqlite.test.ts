import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import { runTelegramRetentionCleanup } from "../telegram-retention-cleanup";

const NOW_SEC = 1_800_000_000;
const DAY_SEC = 24 * 60 * 60;

function setupLatestSchema(): { sqlite: DatabaseSync; db: D1Database } {
  return createLatestSchemaSqlite();
}

interface SourceFixture {
  id: string;
  ageDays: number;
  terminal: boolean;
  finalDeliveryState: "accepted" | "execution_unknown";
  effectState: "complete" | "execution_unknown";
}

interface LegacyTargetFixture {
  id: string;
  ageSec: number;
  targetStatus?: "sent" | "failed" | "expired";
  jobStatus?: "discovered" | "queued" | "sent" | "degraded" | "expired";
  effectState?: "unstarted" | "claimed" | "sending" | "complete" | "execution_unknown";
  finalDeliveryState?: "accepted" | "failed" | "cancelled" | "expired" | "execution_unknown" | null;
  activePendingState?: "pending" | "sending" | "execution_unknown";
  withItem?: boolean;
}

function insertLegacyTargetBundle(sqlite: DatabaseSync, fixture: LegacyTargetFixture): void {
  const createdAt = NOW_SEC - fixture.ageSec;
  const jobId = `legacy-job-${fixture.id}`;
  const targetKey = `legacy-target-${fixture.id}`;
  const dedupeKey = `legacy-dedupe-${fixture.id}`;
  const sourceEventId = `missing-source-${fixture.id}`;

  sqlite
    .prepare(
      `INSERT INTO telegram_alert_jobs (
         job_id, alert_type, source_event_id, severity, created_at, expires_at, status
       ) VALUES (?, 'dews', ?, 'risk', ?, ?, ?)`,
    )
    .run(
      jobId,
      sourceEventId,
      createdAt,
      NOW_SEC + DAY_SEC,
      fixture.jobStatus ?? "sent",
    );
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_job_targets (
         job_id, target_key, chat_id, chunk_index, alert_type, status,
         pending_dedupe_key, created_at, effect_state, final_delivery_state
       ) VALUES (?, ?, ?, 0, 'dews', ?, ?, ?, ?, ?)`,
    )
    .run(
      jobId,
      targetKey,
      `legacy-chat-${fixture.id}`,
      fixture.targetStatus ?? "sent",
      dedupeKey,
      createdAt,
      fixture.effectState ?? "unstarted",
      fixture.finalDeliveryState === undefined ? null : fixture.finalDeliveryState,
    );
  if (fixture.withItem) {
    sqlite
      .prepare(
        `INSERT INTO telegram_alert_job_target_items (
           job_id, target_key, source_event_id, item_key, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(jobId, targetKey, sourceEventId, `item-${fixture.id}`, createdAt);
  }
  if (fixture.activePendingState) {
    sqlite
      .prepare(
        `INSERT INTO telegram_pending_alerts (
           chat_id, message_html, created_at, dedupe_key, delivery_state
         ) VALUES (?, '<b>pending</b>', ?, ?, ?)`,
      )
      .run(`legacy-chat-${fixture.id}`, createdAt, dedupeKey, fixture.activePendingState);
  }
}

function insertUnresolvedSource(
  sqlite: DatabaseSync,
  id: string,
  ageSec: number,
  options: {
    referencedByJob?: boolean;
    referencedByPending?: boolean;
    referencedByDeadLetter?: boolean;
    referencedByFreeze?: boolean;
    expiresAt?: number;
  } = {},
): void {
  const detectedAt = NOW_SEC - ageSec;
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_source_events (
         source_event_id, schema_version, status, detected_at, expires_at,
         event_payload, baseline_payload, target_plan_state
       ) VALUES (?, 1, 'resolving', ?, ?, '{}', '{}', 'unstarted')`,
    )
    .run(id, detectedAt, options.expiresAt ?? NOW_SEC - 1);
  if (options.referencedByJob) {
    sqlite
      .prepare(
        `INSERT INTO telegram_alert_jobs (
           job_id, alert_type, source_event_id, severity, created_at, expires_at, status
         ) VALUES (?, 'dews', ?, 'risk', ?, ?, 'discovered')`,
      )
      .run(`source-job-${id}`, id, detectedAt, NOW_SEC + DAY_SEC);
  }
  if (options.referencedByPending) {
    sqlite
      .prepare(
        `INSERT INTO telegram_pending_alerts (
           chat_id, message_html, created_at, source_event_id
         ) VALUES (?, '<b>pending</b>', ?, ?)`,
      )
      .run(`source-chat-${id}`, NOW_SEC, id);
  }
  if (options.referencedByDeadLetter) {
    sqlite
      .prepare(
        `INSERT INTO telegram_alert_dead_letters (
           chat_id, message_html, created_at, expired_at, reason, source_event_id
         ) VALUES (?, '<b>dead letter</b>', ?, ?, 'expired', ?)`,
      )
      .run(`source-chat-${id}`, NOW_SEC, NOW_SEC, id);
  }
  if (options.referencedByFreeze) {
    sqlite
      .prepare(
        `INSERT INTO telegram_freeze_alert_events (
           source_event_id, tape_event_id, blacklist_event_id, event_type,
           detected_at, expires_at, payload_json, status, created_at, updated_at
         ) VALUES (?, ?, ?, 'blacklist', ?, ?, '{}', 'planning', ?, ?)`,
      )
      .run(id, `tape-${id}`, `blacklist-${id}`, NOW_SEC, NOW_SEC + DAY_SEC, NOW_SEC, NOW_SEC);
  }
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

  it("preserves the complete empty-run metadata contract", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
    const { sqlite, db } = setupLatestSchema();

    const result = await runTelegramRetentionCleanup(db);

    expect(JSON.parse(result.metadata!)).toMatchSnapshot();
    sqlite.close();
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
    expect(metadata).toMatchSnapshot();
    sqlite.close();
  });

  it("prunes legacy terminal targets at 14 days while protecting boundary and active delivery states", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
    const { sqlite, db } = setupLatestSchema();
    insertLegacyTargetBundle(sqlite, {
      id: "eligible-child",
      ageSec: 14 * DAY_SEC + 1,
      withItem: true,
    });
    insertLegacyTargetBundle(sqlite, {
      id: "eligible-degraded",
      ageSec: 15 * DAY_SEC,
      targetStatus: "failed",
      jobStatus: "degraded",
      finalDeliveryState: "failed",
    });
    insertLegacyTargetBundle(sqlite, {
      id: "boundary",
      ageSec: 14 * DAY_SEC,
    });
    insertLegacyTargetBundle(sqlite, {
      id: "fresh",
      ageSec: 13 * DAY_SEC,
    });
    insertLegacyTargetBundle(sqlite, {
      id: "pending",
      ageSec: 15 * DAY_SEC,
      activePendingState: "pending",
    });
    insertLegacyTargetBundle(sqlite, {
      id: "pending-sending",
      ageSec: 15 * DAY_SEC,
      activePendingState: "sending",
    });
    insertLegacyTargetBundle(sqlite, {
      id: "pending-unknown",
      ageSec: 15 * DAY_SEC,
      activePendingState: "execution_unknown",
    });
    insertLegacyTargetBundle(sqlite, {
      id: "effect-claimed",
      ageSec: 15 * DAY_SEC,
      effectState: "claimed",
    });
    insertLegacyTargetBundle(sqlite, {
      id: "effect-sending",
      ageSec: 15 * DAY_SEC,
      effectState: "sending",
    });
    insertLegacyTargetBundle(sqlite, {
      id: "effect-unknown",
      ageSec: 15 * DAY_SEC,
      effectState: "execution_unknown",
    });
    insertLegacyTargetBundle(sqlite, {
      id: "delivery-unknown",
      ageSec: 15 * DAY_SEC,
      effectState: "complete",
      finalDeliveryState: "execution_unknown",
    });

    const result = await runTelegramRetentionCleanup(db);
    const metadata = JSON.parse(result.metadata!) as {
      legacyTargetItemsPruned: number;
      legacyTargetsPruned: number;
      legacyTerminalJobsPruned: number;
      highGrowthRetention: {
        terminalCutoff: number;
        unresolvedCutoff: number;
        rowLimit: number;
        oldestLegacyTargetRemainingAt: number | null;
        oldestLegacyTargetEligibleAt: number | null;
        error: string | null;
      };
      retentionDays: { staleUnresolved: number };
    };

    expect(result.status).toBe("ok");
    expect(metadata.legacyTargetItemsPruned).toBe(1);
    expect(metadata.legacyTargetsPruned).toBe(2);
    expect(metadata.legacyTerminalJobsPruned).toBe(1);
    expect(
      sqlite
        .prepare("SELECT job_id FROM telegram_alert_job_target_items WHERE job_id = 'legacy-job-eligible-child'")
        .get(),
    ).toBeUndefined();
    expect(
      sqlite
        .prepare("SELECT job_id FROM telegram_alert_job_targets WHERE job_id = 'legacy-job-eligible-child'")
        .get(),
    ).toBeUndefined();
    expect(
      sqlite
        .prepare("SELECT job_id FROM telegram_alert_jobs WHERE job_id = 'legacy-job-eligible-child'")
        .get(),
    ).toBeUndefined();
    expect(
      sqlite
        .prepare("SELECT job_id FROM telegram_alert_jobs WHERE job_id = 'legacy-job-eligible-degraded'")
        .get(),
    ).toBeDefined();
    for (const id of [
      "boundary",
      "fresh",
      "pending",
      "pending-sending",
      "pending-unknown",
      "effect-claimed",
      "effect-sending",
      "effect-unknown",
      "delivery-unknown",
    ]) {
      expect(
        sqlite
          .prepare("SELECT job_id FROM telegram_alert_job_targets WHERE job_id = ?")
          .get(`legacy-job-${id}`),
        id,
      ).toBeDefined();
    }
    expect(metadata.highGrowthRetention).toMatchObject({
      terminalCutoff: NOW_SEC - 14 * DAY_SEC,
      unresolvedCutoff: NOW_SEC - 30 * DAY_SEC,
      rowLimit: 100_000,
      oldestLegacyTargetRemainingAt: NOW_SEC - 15 * DAY_SEC,
      oldestLegacyTargetEligibleAt: null,
      error: null,
    });
    expect(metadata.retentionDays.staleUnresolved).toBe(30);
    sqlite.close();
  });

  it("continues bounded legacy-target cleanup across runs without orphaning child items", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
    const { sqlite, db } = setupLatestSchema();
    for (const id of ["one", "two", "three"]) {
      insertLegacyTargetBundle(sqlite, {
        id,
        ageSec: 15 * DAY_SEC,
        withItem: true,
      });
    }

    const first = await runTelegramRetentionCleanup(db, undefined, { highGrowthDeleteLimit: 2 });
    const firstMetadata = JSON.parse(first.metadata!) as {
      legacyTargetItemsPruned: number;
      legacyTargetsPruned: number;
      highGrowthRetention: { cappedAtLimit: boolean; oldestLegacyTargetEligibleAt: number | null };
      runBudgetTruncated: boolean;
    };
    expect(firstMetadata).toMatchObject({
      legacyTargetItemsPruned: 2,
      legacyTargetsPruned: 2,
      highGrowthRetention: {
        cappedAtLimit: true,
        oldestLegacyTargetEligibleAt: NOW_SEC - 15 * DAY_SEC,
      },
      runBudgetTruncated: true,
    });
    expect(
      Number(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_job_target_items").get()?.count),
    ).toBe(1);
    expect(
      Number(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_job_targets").get()?.count),
    ).toBe(1);

    const second = await runTelegramRetentionCleanup(db, undefined, { highGrowthDeleteLimit: 2 });
    const secondMetadata = JSON.parse(second.metadata!) as {
      legacyTargetItemsPruned: number;
      legacyTargetsPruned: number;
      highGrowthRetention: { cappedAtLimit: boolean; oldestLegacyTargetEligibleAt: number | null };
    };
    expect(secondMetadata).toMatchObject({
      legacyTargetItemsPruned: 1,
      legacyTargetsPruned: 1,
      highGrowthRetention: {
        cappedAtLimit: false,
        oldestLegacyTargetEligibleAt: null,
      },
    });
    expect(
      Number(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_job_target_items").get()?.count),
    ).toBe(0);
    expect(
      Number(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_job_targets").get()?.count),
    ).toBe(0);
    sqlite.close();
  });

  it("prunes only unreferenced stale unresolved sources and source-less unresolved jobs after 30 days", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
    const { sqlite, db } = setupLatestSchema();
    insertUnresolvedSource(sqlite, "stale-orphan", 30 * DAY_SEC + 1);
    insertUnresolvedSource(sqlite, "boundary", 30 * DAY_SEC);
    insertUnresolvedSource(sqlite, "referenced", 31 * DAY_SEC, { referencedByJob: true });
    insertUnresolvedSource(sqlite, "pending-reference", 31 * DAY_SEC, { referencedByPending: true });
    insertUnresolvedSource(sqlite, "dead-letter-reference", 31 * DAY_SEC, { referencedByDeadLetter: true });
    insertUnresolvedSource(sqlite, "freeze-reference", 31 * DAY_SEC, { referencedByFreeze: true });
    insertUnresolvedSource(sqlite, "not-expired", 31 * DAY_SEC, { expiresAt: NOW_SEC + DAY_SEC });
    insertLegacyTargetBundle(sqlite, {
      id: "stale-queued",
      ageSec: 31 * DAY_SEC,
      jobStatus: "queued",
    });
    insertLegacyTargetBundle(sqlite, {
      id: "fresh-queued",
      ageSec: 29 * DAY_SEC,
      jobStatus: "queued",
    });

    const result = await runTelegramRetentionCleanup(db);
    const metadata = JSON.parse(result.metadata!) as {
      staleUnresolvedJobsPruned: number;
      staleUnresolvedSourcesPruned: number;
      highGrowthRetention: { oldestUnresolvedSourceRemainingAt: number | null; error: string | null };
    };

    expect(result.status).toBe("ok");
    expect(metadata.staleUnresolvedJobsPruned).toBe(1);
    expect(metadata.staleUnresolvedSourcesPruned).toBe(1);
    expect(
      sqlite.prepare("SELECT source_event_id FROM telegram_alert_source_events WHERE source_event_id = 'stale-orphan'").get(),
    ).toBeUndefined();
    for (const id of [
      "boundary",
      "referenced",
      "pending-reference",
      "dead-letter-reference",
      "freeze-reference",
      "not-expired",
    ]) {
      expect(
        sqlite.prepare("SELECT source_event_id FROM telegram_alert_source_events WHERE source_event_id = ?").get(id),
        id,
      ).toBeDefined();
    }
    expect(
      sqlite.prepare("SELECT job_id FROM telegram_alert_jobs WHERE job_id = 'legacy-job-stale-queued'").get(),
    ).toBeUndefined();
    expect(
      sqlite.prepare("SELECT job_id FROM telegram_alert_jobs WHERE job_id = 'legacy-job-fresh-queued'").get(),
    ).toBeDefined();
    expect(metadata.highGrowthRetention).toMatchObject({
      oldestUnresolvedSourceRemainingAt: NOW_SEC - 31 * DAY_SEC,
      error: null,
    });
    sqlite.close();
  });

  it("applies the configured high-growth limit to job and unresolved-source residue", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
    const { sqlite, db } = setupLatestSchema();
    const insertJob = sqlite.prepare(
      `INSERT INTO telegram_alert_jobs (
         job_id, alert_type, source_event_id, severity, created_at, expires_at, status
       ) VALUES (?, 'dews', ?, 'risk', ?, ?, ?)`,
    );
    for (const index of [1, 2, 3]) {
      insertJob.run(
        `terminal-${index}`,
        `missing-terminal-source-${index}`,
        NOW_SEC - 15 * DAY_SEC,
        NOW_SEC + DAY_SEC,
        "sent",
      );
      insertJob.run(
        `unresolved-${index}`,
        `missing-unresolved-source-${index}`,
        NOW_SEC - 31 * DAY_SEC,
        NOW_SEC + DAY_SEC,
        "queued",
      );
      insertUnresolvedSource(sqlite, `unresolved-source-${index}`, 31 * DAY_SEC);
    }

    const result = await runTelegramRetentionCleanup(db, undefined, { highGrowthDeleteLimit: 2 });
    const metadata = JSON.parse(result.metadata!) as {
      legacyTerminalJobsPruned: number;
      staleUnresolvedJobsPruned: number;
      staleUnresolvedSourcesPruned: number;
      highGrowthRetention: { rowLimit: number; cappedAtLimit: boolean };
    };

    expect(metadata).toMatchObject({
      legacyTerminalJobsPruned: 2,
      staleUnresolvedJobsPruned: 2,
      staleUnresolvedSourcesPruned: 2,
      highGrowthRetention: { rowLimit: 2, cappedAtLimit: true },
    });
    expect(metadata).toMatchSnapshot();
    expect(Number(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_jobs").get()?.count)).toBe(2);
    expect(
      Number(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_source_events").get()?.count),
    ).toBe(1);
    sqlite.close();
  });

  it("degrades only the high-growth family when its cleanup query fails", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
    const { sqlite, db } = setupLatestSchema();
    const isolatedDb = {
      ...db,
      prepare: (sql: string) => {
        if (sql.includes("pharos:telegram:legacy-terminal-target-items-retention")) {
          throw new Error("injected Telegram high-growth cleanup failure");
        }
        return db.prepare(sql);
      },
    } as D1Database;

    const result = await runTelegramRetentionCleanup(isolatedDb);
    const metadata = JSON.parse(result.metadata!) as {
      highGrowthRetention: { error: string | null; durationMs: number };
      usageDailyPruned: number;
    };

    expect(result.status).toBe("degraded");
    expect(metadata.highGrowthRetention.error).toContain("injected Telegram high-growth cleanup failure");
    expect(metadata.highGrowthRetention.durationMs).toBeGreaterThanOrEqual(0);
    expect(metadata.usageDailyPruned).toBe(0);
    expect(metadata).toMatchSnapshot();
    sqlite.close();
  });
});

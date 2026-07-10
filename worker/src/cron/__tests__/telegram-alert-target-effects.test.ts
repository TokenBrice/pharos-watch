import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  TELEGRAM_FRESH_TARGET_CLAIM_TTL_SEC,
  claimFreshTelegramAlertTargets,
  finalizeFreshTelegramAlertTargetEffects,
  handoffFreshTelegramAlertTargetsToPending,
  markFreshTelegramAlertTargetsSending,
  reconcileUnknownFreshTelegramAlertTargets,
} from "../telegram-alert-target-effects";

interface TargetRow {
  status: string;
  effect_state: string;
  effect_owner: string | null;
  effect_generation: number;
  effect_claimed_at: number | null;
  effect_started_at: number | null;
  effect_completed_at: number | null;
  effect_claim_expires_at: number | null;
  sent_at: number | null;
  enqueued_at: number | null;
  failed_at: number | null;
  error_class: string | null;
  final_delivery_state: string | null;
  final_delivery_at: number | null;
  final_delivery_error: string | null;
}

function createHarness(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE telegram_alert_job_targets (
      job_id TEXT NOT NULL,
      target_key TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      alert_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned',
      pending_dedupe_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      sent_at INTEGER,
      enqueued_at INTEGER,
      failed_at INTEGER,
      error_class TEXT,
      effect_state TEXT NOT NULL DEFAULT 'unstarted',
      effect_owner TEXT,
      effect_generation INTEGER NOT NULL DEFAULT 0,
      effect_claimed_at INTEGER,
      effect_started_at INTEGER,
      effect_completed_at INTEGER,
      effect_claim_expires_at INTEGER,
      final_delivery_state TEXT,
      final_delivery_at INTEGER,
      final_delivery_error TEXT,
      PRIMARY KEY (job_id, target_key)
    );
    CREATE TABLE telegram_pending_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      message_html TEXT NOT NULL,
      disable_notification INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      not_before_at INTEGER,
      last_error_class TEXT,
      retry_after_sec INTEGER,
      updated_at INTEGER,
      dedupe_key TEXT UNIQUE,
      chunk_index INTEGER DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 50,
      source_type TEXT NOT NULL DEFAULT 'risk_alert',
      alert_type TEXT,
      expires_at INTEGER,
      processing_owner TEXT,
      processing_started_at INTEGER,
      processing_expires_at INTEGER,
      delivery_state TEXT NOT NULL DEFAULT 'pending',
      delivery_owner TEXT,
      delivery_generation INTEGER NOT NULL DEFAULT 0,
      delivery_started_at INTEGER,
      delivery_completed_at INTEGER,
      delivery_claim_expires_at INTEGER,
      source_event_id TEXT,
      alert_scope_json TEXT,
      preference_generation INTEGER,
      markup_policy_json TEXT
    );
  `);
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_job_targets (
         job_id, target_key, chat_id, alert_type, pending_dedupe_key, created_at
       ) VALUES ('job-1', 'target-1', '42', 'depeg', 'target-1', 100)`,
    )
    .run();
  return { sqlite, db: createSqliteD1(sqlite) };
}

function loadTarget(sqlite: DatabaseSync): TargetRow {
  return sqlite
    .prepare(
      `SELECT status, effect_state, effect_owner, effect_generation,
              effect_claimed_at, effect_started_at, effect_completed_at,
              effect_claim_expires_at, sent_at, enqueued_at, failed_at, error_class,
              final_delivery_state, final_delivery_at, final_delivery_error
         FROM telegram_alert_job_targets
        WHERE job_id = 'job-1' AND target_key = 'target-1'`,
    )
    .get() as unknown as TargetRow;
}

const identity = { jobId: "job-1", targetKey: "target-1" };
const openDatabases: DatabaseSync[] = [];

function harness(): { sqlite: DatabaseSync; db: D1Database } {
  const value = createHarness();
  openDatabases.push(value.sqlite);
  return value;
}

afterEach(() => {
  for (const sqlite of openDatabases.splice(0)) sqlite.close();
});

describe("fresh Telegram alert target effect fencing", () => {
  it("does not claim a target when the run is already aborted before send", async () => {
    const { sqlite, db } = harness();
    const controller = new AbortController();
    controller.abort(new Error("fault before send"));

    await expect(
      claimFreshTelegramAlertTargets(db, [identity], "owner-1", 200, controller.signal),
    ).rejects.toThrow("fault before send");

    expect(loadTarget(sqlite)).toMatchObject({
      status: "planned",
      effect_state: "unstarted",
      effect_owner: null,
      effect_generation: 0,
    });
  });

  it("permits owner takeover only while the external effect is still unstarted", async () => {
    const { sqlite, db } = harness();
    const first = await claimFreshTelegramAlertTargets(db, [identity], "owner-1", 200);
    expect(first.claims.get("target-1")?.generation).toBe(1);

    await expect(
      claimFreshTelegramAlertTargets(db, [identity], "owner-2", 201),
    ).rejects.toThrow("active owner");

    const second = await claimFreshTelegramAlertTargets(
      db,
      [identity],
      "owner-2",
      200 + TELEGRAM_FRESH_TARGET_CLAIM_TTL_SEC,
    );
    expect(second.claims.get("target-1")?.generation).toBe(2);
    expect(loadTarget(sqlite)).toMatchObject({
      effect_state: "claimed",
      effect_owner: "owner-2",
      effect_generation: 2,
    });

    await expect(
      markFreshTelegramAlertTargetsSending(db, [...first.claims.values()], 400),
    ).rejects.toThrow("ownership changed");
    await markFreshTelegramAlertTargetsSending(db, [...second.claims.values()], 400);
    expect(loadTarget(sqlite)).toMatchObject({
      effect_state: "sending",
      effect_owner: "owner-2",
      effect_generation: 2,
    });
  });

  it("keeps an accepted send queryable and non-replayable after completion aborts", async () => {
    const { sqlite, db } = harness();
    const { claims } = await claimFreshTelegramAlertTargets(db, [identity], "owner-1", 200);
    await markFreshTelegramAlertTargetsSending(db, [...claims.values()], 200);

    expect(await reconcileUnknownFreshTelegramAlertTargets(db, 201)).toBe(0);
    expect(
      await reconcileUnknownFreshTelegramAlertTargets(
        db,
        200 + TELEGRAM_FRESH_TARGET_CLAIM_TTL_SEC,
      ),
    ).toBe(1);
    expect(loadTarget(sqlite)).toMatchObject({
      status: "planned",
      effect_state: "execution_unknown",
      error_class: "fresh_effect_owner_lost",
      final_delivery_state: "execution_unknown",
    });
  });

  it("records an ambiguous timeout explicitly instead of returning it to retry", async () => {
    const { sqlite, db } = harness();
    const { claims } = await claimFreshTelegramAlertTargets(db, [identity], "owner-1", 200);
    await markFreshTelegramAlertTargetsSending(db, [...claims.values()], 200);
    const claim = claims.get("target-1");
    expect(claim).toBeDefined();

    await finalizeFreshTelegramAlertTargetEffects(db, [{
      ...claim!,
      status: "failed",
      at: 205,
      errorClass: "timeout",
      executionUnknown: true,
    }]);

    expect(loadTarget(sqlite)).toMatchObject({
      status: "planned",
      effect_state: "execution_unknown",
      effect_completed_at: 205,
      failed_at: null,
      error_class: "timeout",
      final_delivery_state: "execution_unknown",
      final_delivery_at: 205,
    });
  });

  it("hands a known retryable failure to the pending lifecycle without losing lineage", async () => {
    const { sqlite, db } = harness();
    const { claims } = await claimFreshTelegramAlertTargets(db, [identity], "owner-1", 200);
    await markFreshTelegramAlertTargetsSending(db, [...claims.values()], 200);
    const claim = claims.get("target-1");
    expect(claim).toBeDefined();

    await finalizeFreshTelegramAlertTargetEffects(db, [{
      ...claim!,
      status: "queued",
      at: 205,
      errorClass: "rate_limit",
    }]);

    expect(loadTarget(sqlite)).toMatchObject({
      status: "queued",
      effect_state: "complete",
      effect_completed_at: 205,
      enqueued_at: 205,
      error_class: "rate_limit",
    });
  });

  it("rolls back both sides when the retry handoff fails before commit", async () => {
    const { sqlite, db } = harness();
    const { claims } = await claimFreshTelegramAlertTargets(db, [identity], "owner-1", 200);
    await markFreshTelegramAlertTargetsSending(db, [...claims.values()], 200);
    const claim = claims.get("target-1");
    expect(claim).toBeDefined();
    const failingDb = {
      ...db,
      batch: vi.fn(async () => {
        throw new Error("fault before retry handoff commit");
      }),
    } as unknown as D1Database;

    await expect(
      handoffFreshTelegramAlertTargetsToPending(failingDb, [{
        ...claim!,
        message: { chatId: "42", html: "retry", canonicalHtml: "retry", disableNotification: false },
        options: { lastErrorClass: "rate_limit", retryAfterSec: 3, notBeforeAt: 203 },
        at: 200,
        errorClass: "rate_limit",
      }]),
    ).rejects.toThrow("fault before retry handoff commit");

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts").get()).toEqual({ count: 0 });
    expect(loadTarget(sqlite)).toMatchObject({ status: "planned", effect_state: "sending" });
  });

  it("keeps both sides committed when the run aborts immediately after retry handoff", async () => {
    const { sqlite, db } = harness();
    const { claims } = await claimFreshTelegramAlertTargets(db, [identity], "owner-1", 200);
    await markFreshTelegramAlertTargetsSending(db, [...claims.values()], 200);
    const claim = claims.get("target-1");
    expect(claim).toBeDefined();
    const abortAfterCommitDb = {
      ...db,
      batch: vi.fn(async (statements: D1PreparedStatement[]) => {
        await db.batch(statements);
        throw new Error("fault after retry handoff commit");
      }),
    } as unknown as D1Database;

    await expect(
      handoffFreshTelegramAlertTargetsToPending(abortAfterCommitDb, [{
        ...claim!,
        message: { chatId: "42", html: "retry", canonicalHtml: "retry", disableNotification: false },
        options: { lastErrorClass: "rate_limit", retryAfterSec: 3, notBeforeAt: 203 },
        at: 200,
        errorClass: "rate_limit",
      }]),
    ).rejects.toThrow("fault after retry handoff commit");

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts").get()).toEqual({ count: 1 });
    expect(loadTarget(sqlite)).toMatchObject({
      status: "queued",
      effect_state: "complete",
      error_class: "rate_limit",
    });
  });
});

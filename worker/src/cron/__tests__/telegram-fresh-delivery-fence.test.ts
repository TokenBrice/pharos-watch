import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { buildDedupeKey, emptyDrainResult } from "../telegram-pending";
import {
  deliverFreshAlerts,
  expandSubscriberChunks,
  type RoutedSubscriberAlert,
} from "../dispatch-telegram-routing";
import { pruneAlreadyTerminalSubscribers } from "../dispatch-telegram-terminal-targets";
import { TELEGRAM_FRESH_TARGET_CLAIM_TTL_SEC } from "../telegram-alert-target-effects";
import { deliverTelegramSubscriberQueue } from "../dispatch-telegram-delivery";
import { applyTelegramTransportControlSchema } from "../../test-helpers/telegram-transport-control-schema";

interface StoredTarget {
  status: string;
  effect_state: string;
  effect_owner: string | null;
  effect_generation: number;
  effect_started_at: number | null;
  effect_completed_at: number | null;
  error_class: string | null;
  final_delivery_state: string | null;
  final_delivery_at: number | null;
  failed_at: number | null;
}

function subscriber(): RoutedSubscriberAlert {
  return {
    chatId: "42",
    lastActiveAt: 1_800_000_000,
    alerts: {
      dews: [],
      depegTriggered: [],
      depegResolved: [],
      depegWorsening: [],
      safety: [],
      launch: [],
      reserve: [],
    },
    canonicalHtml: "<b>USDC depeg</b>",
    chunks: ["<b>USDC depeg</b>"],
    disableNotification: false,
    alertType: "depeg",
  };
}

function createHarness(): {
  sqlite: DatabaseSync;
  db: D1Database;
  routed: RoutedSubscriberAlert;
  targetKey: string;
} {
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
    CREATE TABLE telegram_subscribers (
      chat_id TEXT PRIMARY KEY,
      consecutive_block_count INTEGER NOT NULL DEFAULT 0,
      consecutive_block_first_at INTEGER
    );
    CREATE TABLE telegram_chat_delivery_diagnostics (
      chat_id TEXT PRIMARY KEY,
      last_successful_delivery_at INTEGER,
      last_successful_reply_at INTEGER,
      last_delivery_attempt_at INTEGER,
      recent_failure_class TEXT,
      updated_at INTEGER NOT NULL
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
    INSERT INTO telegram_subscribers (chat_id) VALUES ('42');
  `);
  applyTelegramTransportControlSchema(sqlite);
  const routed = subscriber();
  const [message] = expandSubscriberChunks([routed]);
  const targetKey = buildDedupeKey(message);
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_job_targets (
         job_id, target_key, chat_id, alert_type, pending_dedupe_key, created_at
       ) VALUES ('job-1', ?, '42', 'depeg', ?, 1800000000)`,
    )
    .run(targetKey, targetKey);
  return { sqlite, db: createSqliteD1(sqlite), routed, targetKey };
}

function loadTarget(sqlite: DatabaseSync): StoredTarget {
  return sqlite
    .prepare(
      `SELECT status, effect_state, effect_owner, effect_generation,
              effect_started_at, effect_completed_at, error_class,
              final_delivery_state, final_delivery_at, failed_at
         FROM telegram_alert_job_targets
        WHERE job_id = 'job-1'`,
    )
    .get() as unknown as StoredTarget;
}

const openDatabases: DatabaseSync[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2027-01-15T08:00:00Z"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const sqlite of openDatabases.splice(0)) sqlite.close();
});

function harness(): ReturnType<typeof createHarness> {
  const value = createHarness();
  openDatabases.push(value.sqlite);
  return value;
}

describe("fresh Telegram delivery effect fence", () => {
  it("does not cross the effect boundary when the run aborts before send", async () => {
    const { sqlite, db, routed, targetKey } = harness();
    const controller = new AbortController();
    controller.abort(new Error("fault before fresh send"));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      deliverFreshAlerts(
        db,
        expandSubscriberChunks([routed]),
        [routed],
        "token",
        0,
        0,
        Date.now(),
        new Map([[targetKey, "job-1"]]),
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow("fault before fresh send");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(loadTarget(sqlite)).toMatchObject({
      status: "planned",
      effect_state: "unstarted",
      effect_owner: null,
      effect_generation: 0,
    });
  });

  it("persists sending before fetch and sent/complete after Telegram confirms", async () => {
    const { sqlite, db, routed, targetKey } = harness();
    const fetchStates: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      fetchStates.push(loadTarget(sqlite).effect_state);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));

    const outcome = await deliverFreshAlerts(
      db,
      expandSubscriberChunks([routed]),
      [routed],
      "token",
      0,
      0,
      Date.now(),
      new Map([[targetKey, "job-1"]]),
    );

    expect(fetchStates).toEqual(["sending"]);
    expect(outcome).toMatchObject({ freshAttempted: 1, freshSent: 1 });
    expect(loadTarget(sqlite)).toMatchObject({
      status: "sent",
      effect_state: "complete",
      effect_generation: 1,
      effect_completed_at: Math.floor(Date.now() / 1000),
    });
  });

  it("leaves an accepted effect fenced when the run aborts before completion", async () => {
    const { sqlite, db, routed, targetKey } = harness();
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => {
      expect(loadTarget(sqlite).effect_state).toBe("sending");
      controller.abort(new Error("fault after Telegram acceptance"));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));

    await expect(
      deliverFreshAlerts(
        db,
        expandSubscriberChunks([routed]),
        [routed],
        "token",
        0,
        0,
        Date.now(),
        new Map([[targetKey, "job-1"]]),
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow("fault after Telegram acceptance");

    expect(loadTarget(sqlite)).toMatchObject({ status: "planned", effect_state: "sending" });

    vi.setSystemTime(Date.now() + (TELEGRAM_FRESH_TARGET_CLAIM_TTL_SEC + 1) * 1_000);
    const replayQueue = [routed];
    const terminal = await pruneAlreadyTerminalSubscribers(db, replayQueue);
    expect(terminal).toEqual(new Set([targetKey]));
    expect(replayQueue).toEqual([]);
    expect(loadTarget(sqlite)).toMatchObject({
      status: "planned",
      effect_state: "execution_unknown",
      error_class: "fresh_effect_owner_lost",
      final_delivery_state: "execution_unknown",
      failed_at: null,
    });
  });

  it("classifies an attempted timeout as execution-unknown without retry enqueue", async () => {
    const { sqlite, db, routed, targetKey } = harness();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    }));

    const outcome = await deliverFreshAlerts(
      db,
      expandSubscriberChunks([routed]),
      [routed],
      "token",
      0,
      0,
      Date.now(),
      new Map([[targetKey, "job-1"]]),
    );

    expect(outcome.retryableFreshMessages).toEqual([]);
    expect(outcome).toMatchObject({ freshAttempted: 1, freshPermanentFailures: 1 });
    expect(loadTarget(sqlite)).toMatchObject({
      status: "planned",
      effect_state: "execution_unknown",
      error_class: "timeout",
      final_delivery_state: "execution_unknown",
      failed_at: null,
    });
  });

  it("hands a confirmed HTTP retry to pending before completing the fresh effect", async () => {
    const { sqlite, db, routed, targetKey } = harness();
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(
        JSON.stringify({ ok: false, description: "chat flood control", parameters: { retry_after: 3 } }),
        { status: 429, headers: { "Retry-After": "3" } },
      )
    ));

    const outcome = await deliverTelegramSubscriberQueue({
      db,
      subscriberQueue: [routed],
      botToken: "token",
      drainResult: emptyDrainResult(),
      maxMessagesPerRun: 1,
      nowSec: Math.floor(Date.now() / 1000),
      chatsInBackoff: new Map(),
      globalBackoffUntil: null,
      dispatchStartedAtMs: Date.now(),
      freshTargetJobIds: new Map([[targetKey, "job-1"]]),
    });

    expect(outcome).toMatchObject({ freshAttempted: 1, freshRetryQueued: 1, pendingEnqueued: 1 });
    expect(
      sqlite
        .prepare(
          `SELECT dedupe_key, last_error_class, retry_after_sec, delivery_state
             FROM telegram_pending_alerts`,
        )
        .get(),
    ).toMatchObject({
      dedupe_key: targetKey,
      last_error_class: "rate_limit",
      retry_after_sec: 3,
      delivery_state: "pending",
    });
    expect(loadTarget(sqlite)).toMatchObject({
      status: "queued",
      effect_state: "complete",
      error_class: "rate_limit",
    });
  });

  it("hands off only the attempted chunk while queueing an unstarted same-chat tail", async () => {
    const { sqlite, db } = harness();
    sqlite.exec("DELETE FROM telegram_alert_job_targets");
    const routed: RoutedSubscriberAlert = {
      ...subscriber(),
      canonicalHtml: "first-second",
      chunks: ["first", "second"],
    };
    const messages = expandSubscriberChunks([routed]);
    const targetKeys = messages.map((message) => buildDedupeKey(message));
    const insert = sqlite.prepare(
      `INSERT INTO telegram_alert_job_targets (
         job_id, target_key, chat_id, chunk_index, alert_type, pending_dedupe_key, created_at
       ) VALUES ('job-1', ?, '42', ?, 'depeg', ?, 1800000000)`,
    );
    targetKeys.forEach((targetKey, chunkIndex) => insert.run(targetKey, chunkIndex, targetKey));
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({ ok: false, description: "chat flood control", parameters: { retry_after: 3 } }),
        { status: 429, headers: { "Retry-After": "3" } },
      )
    );
    vi.stubGlobal("fetch", fetchSpy);

    const outcome = await deliverTelegramSubscriberQueue({
      db,
      subscriberQueue: [routed],
      botToken: "token",
      drainResult: emptyDrainResult(),
      maxMessagesPerRun: 2,
      nowSec: Math.floor(Date.now() / 1000),
      chatsInBackoff: new Map(),
      globalBackoffUntil: null,
      dispatchStartedAtMs: Date.now(),
      freshTargetJobIds: new Map(targetKeys.map((targetKey) => [targetKey, "job-1"])),
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ freshAttempted: 1, freshRetryQueued: 2, pendingEnqueued: 2 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts").get()).toEqual({ count: 2 });
    expect(
      sqlite
        .prepare(
          `SELECT target_key, status, effect_state, effect_generation
             FROM telegram_alert_job_targets
            ORDER BY chunk_index`,
        )
        .all(),
    ).toEqual([
      { target_key: targetKeys[0], status: "queued", effect_state: "complete", effect_generation: 1 },
      { target_key: targetKeys[1], status: "queued", effect_state: "unstarted", effect_generation: 0 },
    ]);
  });
});

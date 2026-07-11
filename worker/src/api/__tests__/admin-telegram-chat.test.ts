import { afterEach, describe, expect, it } from "vitest";
import { handleAdminTelegramChat } from "../admin-telegram-chat";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";

const openSqlite: Array<import("node:sqlite").DatabaseSync> = [];

interface AdminTelegramChatBody {
  contractVersion: number;
  subscriber: unknown;
  subscriptions: unknown[];
  pendingAlerts: { lifecycle: unknown };
  deadLetters: { count: number; recent: unknown[] };
  deliveryDiagnostics: { recent_failure_class: string | null };
  targetHistory: unknown[];
}

function latestDb() {
  const fixture = createLatestSchemaSqlite();
  openSqlite.push(fixture.sqlite);
  return fixture;
}

function request(chatId = "12345") {
  return new Request(`https://ops-api.pharos.watch/api/admin-telegram-chat/${chatId}`);
}

afterEach(() => {
  while (openSqlite.length > 0) openSqlite.pop()?.close();
});

describe("handleAdminTelegramChat v2", () => {
  it("requires admin auth", async () => {
    const { db } = latestDb();
    expect((await handleAdminTelegramChat(db, "12345", false, request())).status).toBe(401);
  });

  it("returns 404 when neither live state nor retained history exists", async () => {
    const { db } = latestDb();
    const response = await handleAdminTelegramChat(db, "404", true, request("404"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found", chatId: "404" });
  });

  it("returns complete redacted state and mutually exclusive pending lifecycle buckets", async () => {
    const { sqlite, db } = latestDb();
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare(
      `INSERT INTO telegram_subscribers (
         chat_id, username, alert_dews, alert_depeg, alert_safety, alert_launch, alert_reserve,
         global_alert_dews, global_alert_depeg, global_alert_safety, global_alert_launch,
         global_alert_reserve, alert_freeze, global_alert_freeze, timezone, quiet_hours_enabled, quiet_hours_start_utc,
         quiet_hours_end_utc, alert_snooze_until_ts, consecutive_block_count,
         consecutive_block_first_at, preference_generation, created_at, last_active_at
       ) VALUES (?, ?, 1, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 0, ?, 1, 22, 7, ?, 2, ?, 9, ?, ?)`,
    ).run("12345", "secret-user", "Europe/Belgrade", now + 600, now - 100, now - 1_000, now - 10);
    sqlite.prepare(
      `INSERT INTO telegram_subscriptions (
         chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_launch,
         alert_reserve, alert_freeze, alert_dews_override, alert_depeg_override,
         alert_safety_override, alert_launch_override, alert_reserve_override, alert_freeze_override,
         alert_snooze_until_ts
       ) VALUES (?, ?, 1, 0, 1, 0, 1, 0, 1, 1, 1, 1, 1, 1, ?)`,
    ).run("12345", "usdc-circle", now + 300);

    const insertPending = sqlite.prepare(
      `INSERT INTO telegram_pending_alerts (
         chat_id, message_html, disable_notification, created_at, attempts,
         not_before_at, updated_at, expires_at, delivery_state, delivery_started_at,
         delivery_owner, dedupe_key
       ) VALUES (?, ?, 0, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertPending.run("12345", "SECRET CLAIMABLE", now - 60, null, now, now + 600, "pending", null, null, "secret-dedupe-1");
    insertPending.run("12345", "SECRET DEFERRED", now - 50, now + 300, now, now + 600, "pending", null, null, "secret-dedupe-2");
    insertPending.run("12345", "SECRET SENDING", now - 40, null, now, now + 600, "sending", now - 30, "secret-owner", "secret-dedupe-3");
    insertPending.run("12345", "SECRET UNKNOWN", now - 30, null, now, now + 600, "execution_unknown", now - 20, "secret-owner", "secret-dedupe-4");
    insertPending.run("12345", "SECRET SENT", now - 20, null, now, now + 600, "sent", now - 15, "secret-owner", "secret-dedupe-5");
    insertPending.run("12345", "SECRET EXPIRED", now - 700, null, now, now - 1, "pending", null, null, "secret-dedupe-6");

    sqlite.prepare(
      `INSERT INTO telegram_chat_delivery_diagnostics (
         chat_id, last_successful_delivery_at, last_successful_reply_at,
         last_delivery_attempt_at, recent_failure_class, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("12345", now - 50, now - 20, now - 10, "rate_limit", now);
    sqlite.prepare(
      `INSERT INTO telegram_alert_dead_letters (
         chat_id, message_html, source_type, alert_type, priority, created_at,
         expired_at, attempts, reason, dedupe_key, chunk_index
       ) VALUES (?, ?, 'risk_alert', 'dews', 20, ?, ?, 2, 'ttl_expired', ?, 0)`,
    ).run("12345", "SECRET DEAD LETTER", now - 500, now - 100, "secret-dead-dedupe");
    sqlite.prepare(
      `INSERT INTO telegram_alert_jobs (
         job_id, alert_type, source_event_id, severity, created_at, expires_at,
         status, target_count
       ) VALUES ('job-1', 'dews', 'event-1', 'warning', ?, ?, 'degraded', 1)`,
    ).run(now - 200, now + 500);
    sqlite.prepare(
      `INSERT INTO telegram_alert_job_targets (
         job_id, target_key, chat_id, chunk_index, alert_type, status,
         pending_dedupe_key, created_at, message_html, effect_owner
       ) VALUES ('job-1', 'target-1', ?, 0, 'dews', 'failed', ?, ?, ?, ?)`,
    ).run("12345", "secret-target-dedupe", now - 190, "SECRET TARGET", "secret-effect-owner");

    const response = await handleAdminTelegramChat(db, "12345", true, request());
    expect(response.status).toBe(200);
    const body = await response.json() as AdminTelegramChatBody;
    expect(body.contractVersion).toBe(2);
    expect(body.subscriber).toMatchObject({
      usernamePresent: true,
      preferenceGeneration: 9,
      globalAlerts: { reserve: true, freeze: false },
      directAlertDefaults: { reserve: true, freeze: false },
      deliveryControls: {
        timezone: "Europe/Belgrade",
        blockStrikes: { count: 2, firstAt: now - 100 },
      },
    });
    expect(body.subscriptions[0]).toMatchObject({
      stablecoinId: "usdc-circle",
      alerts: { reserve: true, freeze: false },
      explicitOverrides: { dews: true, depeg: true, safety: true, launch: true, reserve: true, freeze: true },
    });
    expect(body.pendingAlerts.lifecycle).toMatchObject({
      totalRows: 6,
      claimable: 1,
      deferred: 1,
      sending: 1,
      executionUnknown: 1,
      sentCleanup: 1,
      expired: 1,
    });
    expect(body.deadLetters.count).toBe(1);
    expect(body.deliveryDiagnostics.recent_failure_class).toBe("rate_limit");
    expect(body.targetHistory[0]).toMatchObject({ job_id: "job-1", target_key: "target-1" });
    const serialized = JSON.stringify(body);
    for (const secret of [
      "secret-user", "SECRET CLAIMABLE", "SECRET DEAD LETTER", "SECRET TARGET",
      "secret-dedupe", "secret-owner", "secret-effect-owner",
    ]) expect(serialized).not.toContain(secret);
  });

  it("returns retained bounded history with subscriber null after registration deletion", async () => {
    const { sqlite, db } = latestDb();
    const now = Math.floor(Date.now() / 1000);
    const insert = sqlite.prepare(
      `INSERT INTO telegram_alert_dead_letters (
         chat_id, message_html, created_at, expired_at, reason
       ) VALUES ('999', ?, ?, ?, 'ttl_expired')`,
    );
    for (let index = 0; index < 25; index += 1) {
      insert.run(`payload-${index}`, now - index - 10, now - index);
    }
    const response = await handleAdminTelegramChat(db, "999", true, request("999"));
    expect(response.status).toBe(200);
    const body = await response.json() as AdminTelegramChatBody;
    expect(body.contractVersion).toBe(2);
    expect(body.subscriber).toBeNull();
    expect(body.deadLetters.count).toBe(25);
    expect(body.deadLetters.recent).toHaveLength(20);
  });
});

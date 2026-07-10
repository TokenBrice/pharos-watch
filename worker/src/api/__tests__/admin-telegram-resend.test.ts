import { afterEach, describe, expect, it } from "vitest";
import { handleAdminTelegramResend } from "../admin-telegram-resend";
import { buildDedupeKey } from "../../cron/telegram-pending";
import { sha256Hex } from "../../lib/hash";
import {
  serializePendingAlertScope,
  serializePendingMarkupPolicy,
} from "../../lib/telegram-pending-provenance";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";

const openSqlite: Array<import("node:sqlite").DatabaseSync> = [];

interface AdminTelegramResendBody {
  mode: string;
  dryRun: boolean;
  enqueued: number;
  historicalOutcome: unknown;
  payload: { messageLength: number };
}

interface PendingReplayRow {
  message_html: string;
  source_type: string;
  markup_policy_json: string;
  dedupe_key: string;
}

function latestDb() {
  const fixture = createLatestSchemaSqlite();
  openSqlite.push(fixture.sqlite);
  return fixture;
}

function request(body: unknown, idempotencyKey?: string) {
  const headers = new Headers({ "Content-Type": "application/json", "X-Pharos-Admin": "1" });
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  return new Request("https://ops-api.pharos.watch/api/admin-telegram-resend", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function seedTarget(
  sqlite: import("node:sqlite").DatabaseSync,
  options: {
    chatId?: string;
    finalState?: "failed" | "accepted" | "execution_unknown";
    corruptDigest?: boolean;
  } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const chatId = options.chatId ?? "12345";
  const sourceEventId = "source-event-1";
  const canonicalHtml = "<b>Historical DEWS alert</b>";
  const messageHtml = "<b>Historical DEWS alert</b>";
  const targetKey = buildDedupeKey({
    chatId,
    html: messageHtml,
    canonicalHtml,
    disableNotification: false,
    chunkIndex: 0,
  });
  const alertScopeJson = serializePendingAlertScope([{ stablecoinId: "usdc-circle", family: "dews" }]);
  const markupPolicyJson = serializePendingMarkupPolicy({
    replyMarkup: { inline_keyboard: [[{ text: "Status", callback_data: "status:usdc-circle" }]] },
  });
  const targetExpiresAt = now + 3_600;
  const payloadJson = JSON.stringify({
    schemaVersion: 1,
    sourceEventId,
    chatId,
    alertType: "dews",
    preferenceGeneration: 3,
    canonicalHtml,
    disableNotification: false,
    alertScopeJson,
    targetExpiresAt,
    itemKeys: ["dews:usdc-circle:event-1"],
    messages: [{ targetKey, chunkIndex: 0, html: messageHtml, markupPolicyJson }],
  });
  const payloadDigest = options.corruptDigest ? "0".repeat(64) : await sha256Hex(payloadJson);
  sqlite.prepare(
    `INSERT INTO telegram_alert_source_events (
       source_event_id, status, detected_at, expires_at, event_payload,
       baseline_payload, target_plan_state, target_plan_generation
     ) VALUES (?, 'planned', ?, ?, '{}', '{}', 'materializing', 1)`,
  ).run(sourceEventId, now - 60, targetExpiresAt);
  sqlite.prepare(
    `INSERT INTO telegram_alert_target_plans (
       source_event_id, plan_generation, plan_key, page_index, plan_ordinal,
       chat_id, alert_type, status, preference_generation, estimated_chunks,
       plan_payload_json, plan_payload_digest, expected_target_count,
       materialized_target_count, created_at, updated_at
     ) VALUES (?, 1, 'plan-1', 0, 0, ?, 'dews', 'materialized', 3, 1,
               ?, ?, 1, 1, ?, ?)`,
  ).run(sourceEventId, chatId, payloadJson, payloadDigest, now - 50, now - 50);
  sqlite.prepare(
    `INSERT INTO telegram_alert_jobs (
       job_id, alert_type, source_event_id, severity, created_at, expires_at, status,
       target_count, planned_count
     ) VALUES ('job-1', 'dews', ?, 'warning', ?, ?, 'degraded', 1, 1)`,
  ).run(sourceEventId, now - 50, targetExpiresAt);
  const finalState = options.finalState ?? "failed";
  sqlite.prepare(
    `INSERT INTO telegram_alert_job_targets (
       job_id, target_key, chat_id, chunk_index, alert_type, status,
       pending_dedupe_key, created_at, effect_state, source_event_id,
       plan_generation, plan_key, plan_ordinal, target_ordinal,
       target_schema_version, message_html, disable_notification,
       alert_scope_json, preference_generation, markup_policy_json,
       target_expires_at, final_delivery_state, final_delivery_at,
       final_delivery_error
     ) VALUES ('job-1', ?, ?, 0, 'dews', ?, ?, ?, ?, ?, 1, 'plan-1', 0, 0, 1,
               ?, 0, ?, 3, ?, ?, ?, ?, ?)`,
  ).run(
    targetKey,
    chatId,
    finalState === "accepted" ? "sent" : "failed",
    targetKey,
    now - 40,
    finalState === "execution_unknown" ? "execution_unknown" : "complete",
    sourceEventId,
    messageHtml,
    alertScopeJson,
    markupPolicyJson,
    targetExpiresAt,
    finalState,
    now - 30,
    finalState === "failed" ? "rate_limit" : null,
  );
  return { chatId, sourceEventId, targetKey, messageHtml, markupPolicyJson, now };
}

afterEach(() => {
  while (openSqlite.length > 0) openSqlite.pop()?.close();
});

describe("handleAdminTelegramResend exact replay", () => {
  it("defaults to a non-effecting dry-run and reports exact historical outcome", async () => {
    const { sqlite, db } = latestDb();
    const seeded = await seedTarget(sqlite);
    const response = await handleAdminTelegramResend({
      db,
      request: request({ source: { kind: "target", jobId: "job-1", targetKey: seeded.targetKey } }),
      trustedAdmin: true,
    });
    expect(response.status).toBe(200);
    const body = await response.json() as AdminTelegramResendBody;
    expect(body).toMatchObject({
      mode: "exact_historical_outbox_replay",
      dryRun: true,
      enqueued: 0,
      historicalOutcome: { finalDeliveryState: "failed", finalDeliveryError: "rate_limit" },
    });
    expect(body.payload.messageLength).toBe(seeded.messageHtml.length);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_pending_alerts").get()).toMatchObject({ n: 0 });
  });

  it("enqueues an exact, independently deduped replay and leaves the original target unchanged", async () => {
    const { sqlite, db } = latestDb();
    const seeded = await seedTarget(sqlite);
    sqlite.prepare(
      "INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES (?, ?, ?)",
    ).run(seeded.chatId, seeded.now, seeded.now);
    const response = await handleAdminTelegramResend({
      db,
      request: request({
        source: { kind: "target", jobId: "job-1", targetKey: seeded.targetKey },
        dryRun: false,
        operatorReason: "Retry after confirmed rate-limit recovery",
      }, "replay-target-0001"),
      trustedAdmin: true,
    });
    expect(response.status).toBe(202);
    const replay = sqlite.prepare(
      `SELECT message_html, source_type, markup_policy_json, dedupe_key
         FROM telegram_pending_alerts`,
    ).get() as unknown as PendingReplayRow;
    expect(replay).toMatchObject({
      message_html: seeded.messageHtml,
      source_type: "admin_replay",
      markup_policy_json: seeded.markupPolicyJson,
    });
    expect(replay.dedupe_key).not.toBe(seeded.targetKey);
    expect(sqlite.prepare(
      "SELECT final_delivery_state, final_delivery_error FROM telegram_alert_job_targets WHERE job_id = 'job-1'",
    ).get()).toMatchObject({ final_delivery_state: "failed", final_delivery_error: "rate_limit" });
  });

  it("requires a reason, idempotency key, and live subscriber before enqueue", async () => {
    const { sqlite, db } = latestDb();
    const seeded = await seedTarget(sqlite);
    const source = { kind: "target" as const, jobId: "job-1", targetKey: seeded.targetKey };

    const missingReason = await handleAdminTelegramResend({
      db,
      request: request({ source, dryRun: false }, "guarded-replay-1"),
      trustedAdmin: true,
    });
    expect(missingReason.status).toBe(400);

    const missingKey = await handleAdminTelegramResend({
      db,
      request: request({ source, dryRun: false, operatorReason: "Confirmed delivery recovery" }),
      trustedAdmin: true,
    });
    expect(missingKey.status).toBe(400);

    const missingSubscriber = await handleAdminTelegramResend({
      db,
      request: request(
        { source, dryRun: false, operatorReason: "Confirmed delivery recovery" },
        "guarded-replay-2",
      ),
      trustedAdmin: true,
    });
    expect(missingSubscriber.status).toBe(409);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_pending_alerts").get()).toMatchObject({ n: 0 });
  });

  it.each(["accepted", "execution_unknown"] as const)(
    "refuses live replay of %s targets pending effect reconciliation",
    async (finalState) => {
      const { sqlite, db } = latestDb();
      const seeded = await seedTarget(sqlite, { finalState });
      const response = await handleAdminTelegramResend({
        db,
        request: request({
          source: { kind: "target", jobId: "job-1", targetKey: seeded.targetKey },
          dryRun: false,
          operatorReason: "Operator requested unsafe replay",
        }, `refuse-${finalState}`),
        trustedAdmin: true,
      });
      expect(response.status).toBe(409);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_pending_alerts").get()).toMatchObject({ n: 0 });
    },
  );

  it("rejects a target whose persisted plan digest no longer validates", async () => {
    const { sqlite, db } = latestDb();
    const seeded = await seedTarget(sqlite, { corruptDigest: true });
    const response = await handleAdminTelegramResend({
      db,
      request: request({ source: { kind: "target", jobId: "job-1", targetKey: seeded.targetKey } }),
      trustedAdmin: true,
    });
    expect(response.status).toBe(422);
  });

  it("resolves a dead letter only through its authoritative source-event target", async () => {
    const { sqlite, db } = latestDb();
    const seeded = await seedTarget(sqlite);
    const result = sqlite.prepare(
      `INSERT INTO telegram_alert_dead_letters (
         chat_id, message_html, source_type, alert_type, created_at, expired_at,
         reason, dedupe_key, source_event_id
       ) VALUES (?, ?, 'risk_alert', 'dews', ?, ?, 'ttl_expired', ?, ?)`,
    ).run(seeded.chatId, seeded.messageHtml, seeded.now - 40, seeded.now - 20, seeded.targetKey, seeded.sourceEventId);
    const response = await handleAdminTelegramResend({
      db,
      request: request({ source: { kind: "dead-letter", deadLetterId: Number(result.lastInsertRowid) } }),
      trustedAdmin: true,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      dryRun: true,
      historicalOutcome: { deadLetterReason: "ttl_expired" },
    });
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { handleAdminTelegramDeliveryControl } from "../admin-telegram-delivery-control";

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

function request(method: "GET" | "POST", body?: unknown): Request {
  const headers = new Headers({
    "Cf-Access-Authenticated-User-Email": "operator@example.com",
  });
  if (method === "POST") {
    headers.set("X-Pharos-Admin", "1");
    headers.set("Content-Type", "application/json");
  }
  return new Request("https://ops-api.pharos.watch/api/admin-telegram-delivery-control", {
    method,
    headers,
    ...(body == null ? {} : { body: JSON.stringify(body) }),
  });
}

afterEach(() => {
  vi.useRealTimers();
  while (databases.length > 0) databases.pop()?.close();
});

describe("admin Telegram delivery control", () => {
  it("returns the authoritative circuit and all pause rows", async () => {
    const { db } = setupLatestSchema();
    const response = await handleAdminTelegramDeliveryControl({
      db,
      request: request("GET"),
      trustedAdmin: true,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      circuit: { state: "closed", generation: 0 },
      pauses: [],
    });
  });

  it("audits a fenced pause and resume while preserving expired state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1_000);
    const { sqlite, db } = setupLatestSchema();
    const pauseResponse = await handleAdminTelegramDeliveryControl({
      db,
      request: request("POST", {
        action: "pause",
        mode: "pending",
        expectedGeneration: 0,
        durationSec: 300,
        reason: "Telegram incident",
      }),
      trustedAdmin: true,
    });
    expect(pauseResponse.status).toBe(200);
    await expect(pauseResponse.json()).resolves.toMatchObject({
      pauses: [{ mode: "pending", generation: 1, active: true, expiresAt: NOW + 300 }],
    });

    const resumeResponse = await handleAdminTelegramDeliveryControl({
      db,
      request: request("POST", {
        action: "resume",
        mode: "pending",
        expectedGeneration: 1,
      }),
      trustedAdmin: true,
    });
    expect(resumeResponse.status).toBe(200);
    await expect(resumeResponse.json()).resolves.toMatchObject({
      pauses: [{ mode: "pending", generation: 2, active: false, expiresAt: NOW }],
    });

    expect(sqlite.prepare(
      "SELECT action, target, result FROM admin_action_audit WHERE action LIKE 'telegram-delivery-%' ORDER BY id",
    ).all()).toEqual([
      { action: "telegram-delivery-pause", target: "pending", result: "ok" },
      { action: "telegram-delivery-resume", target: "pending", result: "ok" },
    ]);
  });

  it("rejects a stale generation and audits the conflict", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1_000);
    const { sqlite, db } = setupLatestSchema();
    sqlite.prepare(
      `INSERT INTO telegram_delivery_pauses
         (mode, generation, expires_at, reason, actor, created_at, updated_at)
       VALUES ('fresh', 2, ?, 'existing', 'first@example.com', ?, ?)`,
    ).run(NOW + 300, NOW, NOW);

    const response = await handleAdminTelegramDeliveryControl({
      db,
      request: request("POST", {
        action: "pause",
        mode: "fresh",
        expectedGeneration: 1,
        durationSec: 600,
        reason: "stale update",
      }),
      trustedAdmin: true,
    });
    expect(response.status).toBe(409);
    expect(sqlite.prepare(
      "SELECT action, result, http_status FROM admin_action_audit WHERE action = 'telegram-delivery-pause'",
    ).get()).toEqual({ action: "telegram-delivery-pause", result: "error", http_status: 409 });
  });

  it("archives explicitly acknowledged execution-unknown effects without making them replayable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1_000);
    const { sqlite, db } = setupLatestSchema();
    const inserted = sqlite.prepare(
      `INSERT INTO telegram_pending_alerts (
         chat_id, message_html, created_at, updated_at, dedupe_key, source_type,
         delivery_state, delivery_owner, delivery_generation, delivery_started_at,
         delivery_completed_at, last_error_class
       ) VALUES (?, ?, ?, ?, ?, 'risk_alert', 'execution_unknown', ?, 1, ?, ?, ?)`
    ).run(
      "42",
      "<b>Ambiguous alert</b>",
      NOW - 600,
      NOW - 300,
      "42:v1:0:ambiguous",
      "pending-owner",
      NOW - 500,
      NOW - 300,
      "pending_effect_owner_lost",
    );
    const pendingId = Number(inserted.lastInsertRowid);

    const response = await handleAdminTelegramDeliveryControl({
      db,
      request: request("POST", {
        action: "acknowledge_execution_unknown",
        pendingIds: [pendingId],
        operatorReason: "Confirmed for archival after incident review",
      }),
      trustedAdmin: true,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      acknowledgement: {
        pendingIds: [pendingId],
        disposition: "execution_unknown_archived",
      },
    });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts").get()).toEqual({ count: 0 });
    expect(sqlite.prepare(
      "SELECT pending_id, delivery_state, reason FROM telegram_alert_dead_letters",
    ).get()).toEqual({
      pending_id: pendingId,
      delivery_state: "execution_unknown",
      reason: "execution_unknown_archived",
    });
    const audit = sqlite.prepare(
      "SELECT result, details_json FROM admin_action_audit WHERE action = 'telegram-execution-unknown-acknowledge'",
    ).get() as { result: string; details_json: string };
    expect(audit.result).toBe("ok");
    expect(JSON.parse(audit.details_json)).toMatchObject({
      pendingIds: [pendingId],
      operatorReason: "Confirmed for archival after incident review",
      disposition: "execution_unknown_archived",
    });
  });

  it("refuses a partial execution-unknown acknowledgement before mutating", async () => {
    const { sqlite, db } = setupLatestSchema();
    const inserted = sqlite.prepare(
      `INSERT INTO telegram_pending_alerts (
         chat_id, message_html, created_at, source_type, delivery_state,
         delivery_owner, delivery_generation, delivery_started_at
       ) VALUES ('42', '<b>Ambiguous alert</b>', ?, 'risk_alert',
                 'execution_unknown', 'pending-owner', 1, ?)`
    ).run(NOW - 600, NOW - 500);
    const pendingId = Number(inserted.lastInsertRowid);

    const response = await handleAdminTelegramDeliveryControl({
      db,
      request: request("POST", {
        action: "acknowledge_execution_unknown",
        pendingIds: [pendingId, pendingId + 1],
        operatorReason: "Review requires exact row identity",
      }),
      trustedAdmin: true,
    });
    expect(response.status).toBe(409);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts").get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_dead_letters").get()).toEqual({ count: 0 });
  });

  it("refuses a stale execution-unknown acknowledgement without partial archival side effects", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1_000);
    const { sqlite, db } = setupLatestSchema();
    const insert = sqlite.prepare(
      `INSERT INTO telegram_pending_alerts (
         chat_id, message_html, created_at, updated_at, dedupe_key, source_type,
         delivery_state, delivery_owner, delivery_generation, delivery_started_at,
         delivery_completed_at, last_error_class
       ) VALUES (?, ?, ?, ?, ?, 'risk_alert', 'execution_unknown', ?, 1, ?, ?, ?)`
    );
    const firstId = Number(insert.run(
      "42",
      "<b>First ambiguous alert</b>",
      NOW - 600,
      NOW - 300,
      "42:v1:0:ambiguous:first",
      "pending-owner",
      NOW - 500,
      NOW - 300,
      "pending_effect_owner_lost",
    ).lastInsertRowid);
    const secondId = Number(insert.run(
      "43",
      "<b>Second ambiguous alert</b>",
      NOW - 600,
      NOW - 300,
      "43:v1:0:ambiguous:second",
      "pending-owner",
      NOW - 500,
      NOW - 300,
      "pending_effect_owner_lost",
    ).lastInsertRowid);
    let raced = false;
    const racingDb = {
      ...db,
      prepare(sql: string) {
        const statement = db.prepare(sql);
        if (!sql.includes("DELETE FROM telegram_pending_alerts") || !sql.includes("SELECT COUNT(*)")) {
          return statement;
        }
        return {
          ...statement,
          bind: (...args: unknown[]) => {
            const bound = statement.bind(...args);
            return {
              ...bound,
              run: async () => {
                if (!raced) {
                  raced = true;
                  sqlite.prepare(
                    `UPDATE telegram_pending_alerts
                        SET delivery_state = 'sent', delivery_generation = 2
                      WHERE id = ?`,
                  ).run(secondId);
                }
                return await bound.run();
              },
            } as D1PreparedStatement;
          },
        } as D1PreparedStatement;
      },
    } as D1Database;

    const response = await handleAdminTelegramDeliveryControl({
      db: racingDb,
      request: request("POST", {
        action: "acknowledge_execution_unknown",
        pendingIds: [firstId, secondId],
        operatorReason: "Concurrent change should not partially archive",
      }),
      trustedAdmin: true,
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ missingIds: [secondId] });
    expect(sqlite.prepare(
      "SELECT id, delivery_state, delivery_generation FROM telegram_pending_alerts ORDER BY id",
    ).all()).toEqual([
      { id: firstId, delivery_state: "execution_unknown", delivery_generation: 1 },
      { id: secondId, delivery_state: "sent", delivery_generation: 2 },
    ]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_dead_letters").get()).toEqual({ count: 0 });
    const audit = sqlite.prepare(
      "SELECT result, http_status, details_json FROM admin_action_audit WHERE action = 'telegram-execution-unknown-acknowledge'",
    ).get() as { result: string; http_status: number; details_json: string };
    expect(audit.result).toBe("error");
    expect(audit.http_status).toBe(409);
    expect(JSON.parse(audit.details_json)).toMatchObject({
      pendingIds: [firstId, secondId],
      missingIds: [secondId],
      operatorReason: "Concurrent change should not partially archive",
    });
  });

});

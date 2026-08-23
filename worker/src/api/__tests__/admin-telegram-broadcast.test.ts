import { makeJsonRequest, readJsonResponse } from "./api-request-response.test-support";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAdminTelegramBroadcast } from "../admin-telegram-broadcast";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { mockFetch } from "../../test-helpers/__shared/mock-fetch";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";

let fetchSpy: ReturnType<typeof mockFetch>;
let telegramOutcomes: Response[];
const openSqlite: Array<import("node:sqlite").DatabaseSync> = [];

function latestDb() {
  const fixture = createLatestSchemaSqlite();
  openSqlite.push(fixture.sqlite);
  return fixture;
}

function request(body: unknown, idempotencyKey?: string) {
  const headers: Record<string, string> = { "X-Pharos-Admin": "1" };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  return makeJsonRequest("https://ops-api.pharos.watch/api/admin-telegram-broadcast", body, { headers });
}

function capacityRow(active: number) {
  return {
    match: "SUM(CASE WHEN delivery_state = 'pending' THEN 1 ELSE 0 END) AS total",
    rows: [],
    first: {
      total: active,
      expired: 0,
      due: active,
      deferred: 0,
      near_ttl: 0,
      oldest_pending_created_at: null,
      oldest_due_created_at: null,
      pending_sending: 0,
      pending_execution_unknown: 0,
      sent_cleanup: 0,
      oldest_pending_execution_unknown_at: null,
      fresh_sending: 0,
      fresh_execution_unknown: 0,
      oldest_fresh_execution_unknown_at: null,
      fresh_uncertain_sample_count: 0,
    },
  };
}

beforeEach(() => {
  telegramOutcomes = [new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })];
  fetchSpy = mockFetch([{
    match: "https://api.telegram.org/bottoken/sendMessage",
    respond: () => telegramOutcomes.shift() ?? new Error("unexpected Telegram request"),
  }], { requireMatch: true });
});

afterEach(() => {
  while (openSqlite.length > 0) openSqlite.pop()?.close();
  vi.unstubAllGlobals();
});

describe("handleAdminTelegramBroadcast canary gate", () => {
  it("rejects stray raw < before targeting", async () => {
    const db = mockD1([{ match: "INSERT INTO admin_action_audit", rows: [], runMeta: { changes: 1 } }]);
    const response = await handleAdminTelegramBroadcast({
      db,
      request: request({ messageHtml: "loss < 1%", scope: "all", dryRun: true }),
      trustedAdmin: true,
    });
    expect(await readJsonResponse(response, 422)).toMatchObject({ error: expect.stringContaining("Raw <") });
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM telegram_subscribers"))).toBe(false);
  });

  it.each([
    ["<div>unsupported</div>", "Unsupported Telegram HTML tag"],
    ["<b>bad &copy;</b>", "Malformed or unsupported HTML entity"],
    ["<b>unclosed", "Unclosed Telegram HTML tag"],
  ])("rejects invalid preflight markup %s", async (messageHtml, error) => {
    const db = mockD1([{ match: "INSERT INTO admin_action_audit", rows: [], runMeta: { changes: 1 } }]);
    const response = await handleAdminTelegramBroadcast({
      db,
      request: request({ messageHtml, scope: "all", dryRun: true }),
      trustedAdmin: true,
    });
    expect(await readJsonResponse(response, 422)).toMatchObject({ error: expect.stringContaining(error) });
  });

  it("preserves global and deliverable-watcher scope semantics", async () => {
    const { sqlite, db } = latestDb();
    sqlite.prepare(
      `INSERT INTO telegram_subscribers (chat_id, global_alert_dews, created_at, last_active_at)
       VALUES ('10', 1, 1, 1), ('20', 0, 1, 1), ('30', 0, 1, 1)`,
    ).run();
    sqlite.prepare(
      `INSERT INTO telegram_preset_subscriptions (chat_id, preset_id, alert_dews, created_at, updated_at)
       VALUES ('20', 'usd-top25', 1, 1, 1)`,
    ).run();
    const global = await handleAdminTelegramBroadcast({
      db,
      request: request({ messageHtml: "ok", scope: "global-subscribers", dryRun: true }),
      trustedAdmin: true,
    });
    const deliverable = await handleAdminTelegramBroadcast({
      db,
      request: request({ messageHtml: "ok", scope: "deliverable-watchers", dryRun: true }),
      trustedAdmin: true,
    });
    expect(await global.json()).toMatchObject({ targetChatCount: 1, sample: ["10"] });
    expect(await deliverable.json()).toMatchObject({ targetChatCount: 2, sample: ["10", "20"] });
  });

  it("dry-run reports the mandatory private canary and material TTL reserve", async () => {
    const { sqlite, db } = latestDb();
    sqlite.prepare(
      "INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('10', 1, 1), ('20', 1, 1)",
    ).run();
    const response = await handleAdminTelegramBroadcast({
      db,
      request: request({ messageHtml: "<b>Maintenance</b>", scope: "all", dryRun: true, canaryChatId: "10" }),
      trustedAdmin: true,
    });
    expect(await readJsonResponse(response, 200)).toMatchObject({
      targetChatCount: 2,
      targetMessageCount: 1,
      canary: { requiredForLive: true, chatId: "10", wouldSendChunkCount: 1 },
      deliveryEstimate: { hasMaterialTtlReserve: true, minimumTtlReserveSec: 900 },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a live fanout that cannot retain the non-overridable TTL reserve", async () => {
    const db = mockD1([
      { match: "FROM telegram_subscribers ORDER BY chat_id", rows: [{ chat_id: "20" }] },
      capacityRow(10_801),
      { match: "INSERT INTO admin_action_audit", rows: [], runMeta: { changes: 1 } },
    ]);
    const response = await handleAdminTelegramBroadcast({
      db,
      request: request({
        messageHtml: "<b>Maintenance</b>",
        scope: "all",
        dryRun: false,
        canaryChatId: "10",
        acknowledgeBacklogRisk: true,
      }),
      trustedAdmin: true,
      telegramBotToken: "token",
    });
    expect(await readJsonResponse(response, 409)).toMatchObject({
      deliveryEstimate: { hasMaterialTtlReserve: false },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not enqueue fleet work when Telegram rejects the private parse canary", async () => {
    telegramOutcomes = [new Response(JSON.stringify({
      ok: false,
      error_code: 400,
      description: "Bad Request: can't parse entities",
    }), { status: 400 })];
    const { sqlite, db } = latestDb();
    sqlite.prepare(
      "INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('20', 1, 1)",
    ).run();
    const response = await handleAdminTelegramBroadcast({
      db,
      request: request({ messageHtml: "<b>Maintenance</b>", scope: "all", dryRun: false, canaryChatId: "10" }),
      trustedAdmin: true,
      telegramBotToken: "token",
    });
    expect(await readJsonResponse(response, 422)).toMatchObject({ fleetEnqueued: 0, errorClass: "formatting_error" });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_pending_alerts").get()).toMatchObject({ n: 0 });
  });

  it("requires both a private canary and bot token for live fanout", async () => {
    const { sqlite, db } = latestDb();
    sqlite.prepare(
      "INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('20', 1, 1)",
    ).run();
    const missingCanary = await handleAdminTelegramBroadcast({
      db,
      request: request({ messageHtml: "ok", scope: "all", dryRun: false }),
      trustedAdmin: true,
      telegramBotToken: "token",
    });
    const missingToken = await handleAdminTelegramBroadcast({
      db,
      request: request({ messageHtml: "ok", scope: "all", dryRun: false, canaryChatId: "10" }),
      trustedAdmin: true,
    });
    expect(missingCanary.status).toBe(400);
    expect(missingToken.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["pause", "circuit"] as const)("honors the admin %s transport gate before canary send", async (gate) => {
    const { sqlite, db } = latestDb();
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare(
      "INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('20', 1, 1)",
    ).run();
    if (gate === "pause") {
      sqlite.prepare(
        `INSERT INTO telegram_delivery_pauses (mode, generation, expires_at, reason, actor, created_at, updated_at)
         VALUES ('admin', 1, ?, 'incident', 'operator', ?, ?)`,
      ).run(now + 300, now, now);
    } else {
      sqlite.prepare(
        `UPDATE telegram_transport_circuit
            SET state = 'open', generation = 1, cause_class = 'auth_error',
                cause_scope = 'fatal', opened_at = ?, next_probe_at = ?, updated_at = ?
          WHERE singleton_id = 1`,
      ).run(now, now + 300, now);
    }
    const response = await handleAdminTelegramBroadcast({
      db,
      request: request({ messageHtml: "ok", scope: "all", dryRun: false, canaryChatId: "10" }),
      trustedAdmin: true,
      telegramBotToken: "token",
    });
    expect(response.status).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the exact silent canary before enqueuing the remaining fleet", async () => {
    const { sqlite, db } = latestDb();
    sqlite.prepare(
      "INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('10', 1, 1), ('20', 1, 1), ('30', 1, 1)",
    ).run();
    const response = await handleAdminTelegramBroadcast({
      db,
      request: request({ messageHtml: "<b>Maintenance</b>", scope: "all", dryRun: false, canaryChatId: "10" }),
      trustedAdmin: true,
      telegramBotToken: "token",
    });
    expect(await readJsonResponse(response, 200)).toMatchObject({
      enqueued: 2,
      canary: { chatId: "10", chunksSent: 1 },
    });
    const sent = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(sent).toMatchObject({ chat_id: "10", text: "<b>Maintenance</b>", disable_notification: true });
    const fleet = sqlite.prepare(
      "SELECT chat_id, source_type FROM telegram_pending_alerts ORDER BY chat_id",
    ).all();
    expect(fleet).toEqual([
      expect.objectContaining({ chat_id: "20", source_type: "admin_broadcast" }),
      expect.objectContaining({ chat_id: "30", source_type: "admin_broadcast" }),
    ]);
  });

  it("replays an idempotent live response without a second canary or duplicate fanout", async () => {
    const { sqlite, db } = latestDb();
    sqlite.prepare(
      "INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('20', 1, 1)",
    ).run();
    const body = { messageHtml: "<b>Maintenance</b>", scope: "all", dryRun: false, canaryChatId: "10" };
    const first = await handleAdminTelegramBroadcast({
      db,
      request: request(body, "broadcast-replay-0001"),
      trustedAdmin: true,
      telegramBotToken: "token",
    });
    const second = await handleAdminTelegramBroadcast({
      db,
      request: request(body, "broadcast-replay-0001"),
      trustedAdmin: true,
      telegramBotToken: "token",
    });
    expect(first.status).toBe(200);
    expect(second.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_pending_alerts").get()).toMatchObject({ n: 1 });
  });
});

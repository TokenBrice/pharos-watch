import { makeJsonRequest, readJsonResponse } from "../../../test-helpers/__shared/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAdminTelegramBroadcast } from "../admin-telegram-broadcast";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { TELEGRAM_ALERT_TYPES } from "@shared/types/status";
import { shouldAttemptFetch } from "../../../lib/circuit-breaker";
import { fanOutPlanningTelegramJobs } from "../../../cron/telegram/jobs/run-jobs";

vi.mock("../../../lib/circuit-breaker", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/circuit-breaker")>(),
  shouldAttemptFetch: vi.fn(async () => true),
}));

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
    match: "SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS total",
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
  it.each(TELEGRAM_ALERT_TYPES)("includes %s direct and global follows without inactive watchers", async (family) => {
    const { sqlite, db } = latestDb();
    sqlite.prepare(`INSERT INTO telegram_subscribers (chat_id, global_alert_${family}, created_at, last_active_at)
      VALUES ('10', 1, 1, 1), ('20', 0, 1, 1), ('30', 0, 1, 1)`).run();
    sqlite.prepare(`INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_${family})
      VALUES ('20', 'usdc-circle', 1), ('30', 'usdc-circle', 0)`).run();
    for (const scope of ["global-subscribers", "deliverable-watchers"] as const) {
      const response = await handleAdminTelegramBroadcast({
        db, request: request({ messageHtml: "ok", scope, dryRun: true }), trustedAdmin: true,
      });
      expect(await readJsonResponse(response, 200)).toMatchObject(scope === "global-subscribers"
        ? { targetChatCount: 1, sample: ["10"] }
        : { targetChatCount: 2, sample: ["10", "20"] });
    }
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

  it("refuses a fleet too large to fan out within the broadcast TTL", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_subscribers ORDER BY chat_id",
        rows: Array.from({ length: 30_000 }, (_, index) => ({ chat_id: String(100_000 + index) })),
      },
      capacityRow(0),
      { match: "INSERT INTO admin_action_audit", rows: [], runMeta: { changes: 1 } },
    ]);
    const response = await handleAdminTelegramBroadcast({
      db,
      request: request({ messageHtml: "<b>Maintenance</b>", scope: "all", dryRun: false, canaryChatId: "10" }),
      trustedAdmin: true,
      telegramBotToken: "token",
    });
    // 29,999 rows drain in 17 runs (1,800/run) after the first-run wait (fan-out needs 13): 90 min > 45 min TTL.
    expect(await readJsonResponse(response, 409)).toMatchObject({
      deliveryEstimate: { fanoutRuns: 13, estimatedDrainTimeSec: 5_400, hasMaterialTtlReserve: false },
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
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_jobs").get()).toMatchObject({ n: 0 });
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

  it("honors the Telegram API circuit before canary send", async () => {
    const { sqlite, db } = latestDb();
    sqlite.prepare(
      "INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('20', 1, 1)",
    ).run();
    vi.mocked(shouldAttemptFetch).mockResolvedValueOnce(false);
    const response = await handleAdminTelegramBroadcast({
      db,
      request: request({ messageHtml: "ok", scope: "all", dryRun: false, canaryChatId: "10" }),
      trustedAdmin: true,
      telegramBotToken: "token",
    });
    expect(await readJsonResponse(response, 409)).toMatchObject({ reason: "transport-outage" });
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
    // One durable job; the dispatcher fans it out (the canary chat is excluded).
    expect(sqlite.prepare("SELECT kind, state FROM telegram_jobs").all()).toEqual([{ kind: "broadcast", state: "planning" }]);
    await fanOutPlanningTelegramJobs(db, Math.floor(Date.now() / 1000));
    const fleet = sqlite.prepare(
      "SELECT chat_id, kind, audience, priority FROM telegram_deliveries ORDER BY chat_id",
    ).all();
    expect(fleet).toEqual([
      { chat_id: "20", kind: "broadcast", audience: "notice", priority: 90 },
      { chat_id: "30", kind: "broadcast", audience: "notice", priority: 90 },
    ]);
  });

  it("canaries independently valid long multiline HTML before queueing identical versioned fleet chunks", async () => {
    const { sqlite, db } = latestDb();
    sqlite.prepare(
      "INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('20', 1, 1)",
    ).run();
    const open = '<blockquote expandable><u><a href="https://pharos.watch/?a=1&amp;b=2">';
    const close = "</a></u></blockquote>";
    const line = "Maintenance &amp; recovery \u{1F680}\n\n";
    const messageHtml = `${open}${line.repeat(240)}${close}`;
    const canaryChunks: string[] = [];
    fetchSpy.mockImplementation(async (_input, init) => {
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_jobs").get()).toMatchObject({ n: 0 });
      const sent = JSON.parse(String(init?.body)) as { text: string; chat_id: string; disable_notification: boolean };
      expect(sent).toMatchObject({ chat_id: "10", disable_notification: true });
      expect(sent.text.length).toBeLessThanOrEqual(4000);
      expect(sent.text.startsWith(open)).toBe(true);
      expect(sent.text.endsWith(close)).toBe(true);
      const stack: string[] = [];
      for (const tag of sent.text.matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
        if (tag[1]) expect(stack.pop()).toBe(tag[2]);
        else stack.push(tag[2]);
      }
      expect(stack).toEqual([]);
      canaryChunks.push(sent.text);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const response = await handleAdminTelegramBroadcast({
      db, request: request({ messageHtml, scope: "all", dryRun: false, canaryChatId: "10" }),
      trustedAdmin: true, telegramBotToken: "token",
    });
    expect(await readJsonResponse(response, 200)).toMatchObject({
      enqueued: canaryChunks.length, canary: { chunksSent: canaryChunks.length },
    });
    expect(canaryChunks.length).toBeGreaterThan(1);
    expect(canaryChunks.map((chunk) => chunk.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&")).join(""))
      .toBe("Maintenance & recovery \u{1F680}\n\n".repeat(240));
    await fanOutPlanningTelegramJobs(db, Math.floor(Date.now() / 1000));
    const queued = sqlite.prepare(
      "SELECT body, body_hash FROM telegram_deliveries WHERE chat_id = '20' ORDER BY seq",
    ).all();
    expect(queued.map((row) => row.body)).toEqual(canaryChunks);
    expect(queued.every((row) => String(row.body_hash).startsWith("v4:"))).toBe(true);
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
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_jobs").get()).toMatchObject({ n: 1 });
  });
});

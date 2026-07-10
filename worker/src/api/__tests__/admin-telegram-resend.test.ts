import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleAdminTelegramResend } from "../admin-telegram-resend";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { buildDewsStablecoinIdsDigest } from "../../lib/dews-publication-pointer";

const fetchSpy = vi.fn();
vi.stubGlobal("fetch", fetchSpy);

const BOT_TOKEN = "test-bot-token";

function adminRequest(body: unknown): Request {
  const headers = new Headers();
  headers.set("X-Pharos-Admin", "1");
  headers.set("Content-Type", "application/json");
  return new Request("https://ops-api.pharos.watch/api/admin-telegram-resend", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function subscriberRows() {
  return { match: "FROM telegram_subscribers", rows: [{ chat_id: "12345" }] };
}

function noSubscriberRows() {
  return { match: "FROM telegram_subscribers", rows: [] };
}

function dewsRow(stablecoinId: string) {
  return {
    match: "FROM stress_signals",
    rows: [
      {
        stablecoin_id: stablecoinId,
        score: 72,
        band: "WARNING",
        signals_json: null,
      },
    ],
  };
}

function depegRow(stablecoinId: string) {
  return {
    match: "FROM depeg_events",
    rows: [
      {
        stablecoin_id: stablecoinId,
        symbol: "USDC",
        direction: "below" as const,
        peak_deviation_bps: 350,
        start_price: 0.965,
        peg_reference: 1.0,
      },
    ],
  };
}

function safetyRow() {
  return {
    match: "FROM safety_grade_history",
    rows: [
      {
        grade: "B",
        score: 70,
        prev_grade: "A",
        prev_score: 80,
      },
    ],
  };
}

function auditRow() {
  return {
    match: "INSERT INTO admin_action_audit",
    rows: [],
    runMeta: { changes: 1 },
  };
}

function deliveryDiagnosticsRow() {
  return {
    match: "INSERT INTO telegram_chat_delivery_diagnostics",
    rows: [],
    runMeta: { changes: 1 },
  };
}

function transportControlRows() {
  return [
    { match: "FROM telegram_delivery_pauses", rows: [] },
    {
      match: "FROM telegram_transport_circuit",
      first: {
        state: "closed",
        generation: 0,
        cause_class: null,
        cause_scope: null,
        distinct_failure_count: 0,
        first_failure_at: null,
        last_failure_at: null,
        last_success_at: null,
        opened_at: null,
        next_probe_at: null,
        probe_owner: null,
        probe_generation: null,
        probe_expires_at: null,
        probe_limit: null,
        probe_attempted: 0,
        updated_at: 0,
      },
      rows: [],
    },
  ];
}

beforeEach(() => {
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue(
    new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }),
  );
});

describe("handleAdminTelegramResend", () => {
  it("rejects requests without admin auth", async () => {
    const db = mockD1();
    const res = await handleAdminTelegramResend({
      db,
      request: adminRequest({ chatId: "12345", alertType: "dews", stablecoinId: "usdc-circle" }),
      trustedAdmin: false,
      telegramBotToken: BOT_TOKEN,
    });
    expect(res.status).toBe(401);
  });

  it("rejects invalid JSON bodies with 400", async () => {
    const db = mockD1();
    const res = await handleAdminTelegramResend({
      db,
      request: adminRequest("not-json"),
      trustedAdmin: true,
      telegramBotToken: BOT_TOKEN,
    });
    expect(res.status).toBe(400);
  });

  it("rejects bodies missing chatId with 400", async () => {
    const db = mockD1();
    const res = await handleAdminTelegramResend({
      db,
      request: adminRequest({ alertType: "dews", stablecoinId: "usdc-circle" }),
      trustedAdmin: true,
      telegramBotToken: BOT_TOKEN,
    });
    expect(res.status).toBe(400);
  });

  it("rejects unknown alertType with 400", async () => {
    const db = mockD1();
    const res = await handleAdminTelegramResend({
      db,
      request: adminRequest({ chatId: "12345", alertType: "yield", stablecoinId: "usdc-circle" }),
      trustedAdmin: true,
      telegramBotToken: BOT_TOKEN,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "alertType must be one of: dews, depeg, safety, launch, reserve",
    });
  });

  it("rejects unknown stablecoinId with 400", async () => {
    const db = mockD1();
    const res = await handleAdminTelegramResend({
      db,
      request: adminRequest({
        chatId: "12345",
        alertType: "dews",
        stablecoinId: "this-coin-does-not-exist",
      }),
      trustedAdmin: true,
      telegramBotToken: BOT_TOKEN,
    });
    expect(res.status).toBe(400);
  });

  it("returns 500 when TELEGRAM_BOT_TOKEN is missing", async () => {
    const db = mockD1();
    const res = await handleAdminTelegramResend({
      db,
      request: adminRequest({ chatId: "12345", alertType: "dews", stablecoinId: "usdc-circle" }),
      trustedAdmin: true,
      telegramBotToken: undefined,
    });
    expect(res.status).toBe(500);
  });

  it("returns 404 when the subscriber row is missing", async () => {
    const db = mockD1([noSubscriberRows(), auditRow()]);
    const res = await handleAdminTelegramResend({
      db,
      request: adminRequest({ chatId: "99999", alertType: "dews", stablecoinId: "usdc-circle" }),
      trustedAdmin: true,
      telegramBotToken: BOT_TOKEN,
    });
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 422 when there is no source data for the requested alert", async () => {
    const db = mockD1([
      subscriberRows(),
      { match: "FROM stress_signals", rows: [] },
      auditRow(),
    ]);
    const res = await handleAdminTelegramResend({
      db,
      request: adminRequest({ chatId: "12345", alertType: "dews", stablecoinId: "usdc-circle" }),
      trustedAdmin: true,
      telegramBotToken: BOT_TOKEN,
    });
    expect(res.status).toBe(422);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 422 rather than reviving an older DEWS row under an exact publication pointer", async () => {
    const publishedAt = Math.floor(Date.now() / 1000) - 60;
    const pointer = {
      key: "dews:published-generation",
      value: JSON.stringify({
        updatedAt: publishedAt,
        source: "compute-dews",
        publishStatus: "published",
        coverageVersion: 2,
        expectedRowCount: 2,
        stablecoinIdsDigest: buildDewsStablecoinIdsDigest(["usdc-circle", "usdt-tether"]),
      }),
      updated_at: publishedAt,
    };
    const db = mockD1([
      subscriberRows(),
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["dews:published-generation"],
        rows: [pointer],
        first: pointer,
      },
      {
        match: "pharos:stress-signals:latest-one",
        matchBinds: ["usdc-circle", publishedAt],
        rows: [{ score: 25, band: "WATCH", signals_json: "{}", computed_at: publishedAt - 60 }],
      },
      {
        match: "pharos:stress-signals:published-exact-one",
        matchBinds: ["usdc-circle", publishedAt],
        rows: [],
        first: null,
      },
      auditRow(),
    ]);

    const res = await handleAdminTelegramResend({
      db,
      request: adminRequest({ chatId: "12345", alertType: "dews", stablecoinId: "usdc-circle" }),
      trustedAdmin: true,
      telegramBotToken: BOT_TOKEN,
    });

    expect(res.status).toBe(422);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.getHistory().some((entry) => entry.sql.includes("legacy-latest-one"))).toBe(false);
  });

  it("sends a synthetic dews alert and audits the action", async () => {
    const db = mockD1([subscriberRows(), dewsRow("usdc-circle"), ...transportControlRows(), deliveryDiagnosticsRow(), auditRow()]);
    const res = await handleAdminTelegramResend({
      db,
      request: adminRequest({ chatId: "12345", alertType: "dews", stablecoinId: "usdc-circle" }),
      trustedAdmin: true,
      telegramBotToken: BOT_TOKEN,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as {
      ok: boolean;
      mode: string;
      chunkCount: number;
      chunksAttempted: number;
      statusCode: number | null;
      errorClass: string | null;
      retryAfterSec: number | null;
    };
    expect(body).toEqual({
      ok: true,
      mode: "synthetic_current_state",
      chunkCount: 1,
      chunksAttempted: 1,
      statusCode: 200,
      errorClass: null,
      retryAfterSec: null,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    const sentBody = JSON.parse(init.body as string) as { chat_id: string; text: string };
    expect(sentBody.chat_id).toBe("12345");
    expect(sentBody.text).toContain("DEWS");

    const history = db.getHistory();
    const audit = history.find((entry) => entry.sql.includes("INSERT INTO admin_action_audit"));
    expect(audit).toBeDefined();
    expect(audit?.binds).toContain("admin-telegram-resend");
    expect(audit?.binds).toContain("12345");
    const diagnostics = history.find((entry) => entry.sql.includes("INSERT INTO telegram_chat_delivery_diagnostics"));
    expect(diagnostics?.binds).toEqual(["12345", expect.any(Number), expect.any(Number), null, expect.any(Number)]);
  });

  it("sends a depeg alert from depeg_events", async () => {
    const db = mockD1([subscriberRows(), depegRow("usdc-circle"), ...transportControlRows(), deliveryDiagnosticsRow(), auditRow()]);
    const res = await handleAdminTelegramResend({
      db,
      request: adminRequest({ chatId: "12345", alertType: "depeg", stablecoinId: "usdc-circle" }),
      trustedAdmin: true,
      telegramBotToken: BOT_TOKEN,
    });
    expect(res.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as { text: string };
    expect(sentBody.text).toContain("Depeg Detected");
  });

  it("sends a safety alert from safety_grade_history", async () => {
    const db = mockD1([subscriberRows(), safetyRow(), ...transportControlRows(), deliveryDiagnosticsRow(), auditRow()]);
    const res = await handleAdminTelegramResend({
      db,
      request: adminRequest({ chatId: "12345", alertType: "safety", stablecoinId: "usdc-circle" }),
      trustedAdmin: true,
      telegramBotToken: BOT_TOKEN,
    });
    expect(res.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as { text: string };
    expect(sentBody.text).toContain("Safety Grade Change");
  });

  it("sends a launch alert built from tracked stablecoin metadata", async () => {
    const db = mockD1([subscriberRows(), ...transportControlRows(), deliveryDiagnosticsRow(), auditRow()]);
    const res = await handleAdminTelegramResend({
      db,
      request: adminRequest({ chatId: "12345", alertType: "launch", stablecoinId: "usdc-circle" }),
      trustedAdmin: true,
      telegramBotToken: BOT_TOKEN,
    });
    expect(res.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as { text: string };
    expect(sentBody.text).toContain("Stablecoin Launched");
  });

  it("sends a reserve alert built from tracked stablecoin metadata", async () => {
    const db = mockD1([subscriberRows(), ...transportControlRows(), deliveryDiagnosticsRow(), auditRow()]);
    const res = await handleAdminTelegramResend({
      db,
      request: adminRequest({ chatId: "12345", alertType: "reserve", stablecoinId: "usdc-circle" }),
      trustedAdmin: true,
      telegramBotToken: BOT_TOKEN,
    });
    expect(res.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as {
      text: string;
      reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    };
    expect(sentBody.text).toContain("Reserve Drift");
    expect(sentBody.text).toContain("<b>USDC</b>");
    expect(sentBody.text).toContain("USD Coin");
    expect(sentBody.text).toContain("https://pharos.watch/stablecoin/usdc-circle");
    expect(sentBody.reply_markup?.inline_keyboard?.flat().some((button) =>
      button.callback_data === "status:usdc-circle"
    )).toBe(true);
  });

  it("returns 502 and audits http_status 502 when Telegram delivery fails", async () => {
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error_code: 429 }), {
        status: 429,
        headers: { "Retry-After": "30" },
      }),
    );
    const db = mockD1([subscriberRows(), dewsRow("usdc-circle"), ...transportControlRows(), deliveryDiagnosticsRow(), auditRow()]);
    const res = await handleAdminTelegramResend({
      db,
      request: adminRequest({ chatId: "12345", alertType: "dews", stablecoinId: "usdc-circle" }),
      trustedAdmin: true,
      telegramBotToken: BOT_TOKEN,
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      ok: boolean;
      statusCode: number | null;
      errorClass: string | null;
      retryAfterSec: number | null;
    };
    expect(body.ok).toBe(false);
    expect(body.statusCode).toBe(429);
    expect(body.errorClass).toBe("rate_limit");
    expect(body.retryAfterSec).toBe(30);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const diagnostics = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO telegram_chat_delivery_diagnostics"));
    expect(diagnostics?.binds).toEqual(["12345", null, expect.any(Number), "rate_limit", expect.any(Number)]);
    const audit = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO admin_action_audit"));
    expect(audit?.binds).toContain(502);
  });

  it("does not cross the send boundary while admin delivery is paused", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      subscriberRows(),
      dewsRow("usdc-circle"),
      {
        match: "FROM telegram_delivery_pauses",
        first: {
          mode: "admin",
          generation: 1,
          expires_at: now + 300,
          reason: "incident",
          actor: "operator",
          created_at: now,
          updated_at: now,
        },
        rows: [],
      },
      transportControlRows()[1],
      auditRow(),
    ]);

    const response = await handleAdminTelegramResend({
      db,
      request: adminRequest({ chatId: "12345", alertType: "dews", stablecoinId: "usdc-circle" }),
      trustedAdmin: true,
      telegramBotToken: BOT_TOKEN,
    });

    expect(response.status).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

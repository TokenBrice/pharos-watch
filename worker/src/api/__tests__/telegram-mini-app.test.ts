import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockD1 as baseMockD1,
  type MockD1Database,
  type MockTableConfig,
} from "../../test-helpers/__shared/mock-d1";



import {
  TELEGRAM_MINI_APP_CATALOG_VERSION,
  TELEGRAM_MINI_APP_CATALOG_VERSION_PARAM,
  TELEGRAM_MINI_APP_CONTRACT_VERSION,
  TELEGRAM_MINI_APP_CONTRACT_VERSION_PARAM,
  TelegramMiniAppSnapshotSchema,
} from "@shared/lib/telegram-mini-app-contract";

const { handleTelegramMiniAppMutation, handleTelegramMiniAppSession } = await import("../telegram-mini-app");
const { mutationActionDetail } = await import("../telegram-mini-app-mutations");

const BOT_TOKEN = "123456:test-token";
const NOW_SEC = 1_800_000_000;
const encoder = new TextEncoder();

function mockD1(
  tables: Parameters<typeof baseMockD1>[0] = [],
  options: Parameters<typeof baseMockD1>[1] = {},
) {
  return baseMockD1([
    ...tables,
    { match: "WHERE cache.updated_at <= ?", rows: [] },
    { match: "FROM telegram_subscribers", rows: [], first: null },
    { match: "FROM telegram_subscriptions", rows: [] },
    { match: "FROM telegram_preset_subscriptions", rows: [] },
    { match: "FROM telegram_pending_alerts", rows: [], first: null },
    { match: "FROM telegram_pending_disambiguation", rows: [], first: null },
    { match: "FROM telegram_recap_preferences", rows: [], first: null },
    { match: "FROM telegram_recap_targets", rows: [] },
    { match: "INSERT OR IGNORE INTO telegram_subscribers", rows: [] },
    { match: "INSERT INTO telegram_subscribers", rows: [] },
    { match: "UPDATE telegram_subscribers", rows: [] },
    { match: "INSERT INTO telegram_subscriptions", rows: [] },
    { match: "UPDATE telegram_subscriptions", rows: [] },
    { match: "DELETE FROM telegram_subscriptions", rows: [] },
    { match: "INSERT INTO telegram_preset_subscriptions", rows: [] },
    { match: "DELETE FROM telegram_preset_subscriptions", rows: [] },
    { match: "INSERT INTO telegram_pending_disambiguation", rows: [] },
    { match: "DELETE FROM telegram_pending_disambiguation", rows: [] },
    { match: "DELETE FROM telegram_pending_alerts", rows: [] },
    { match: "INSERT INTO telegram_recap_preferences", rows: [] },
    { match: "UPDATE telegram_recap_preferences", rows: [] },
    { match: "DELETE FROM telegram_recap_targets", rows: [] },
    { match: "DELETE FROM telegram_freeze_alert_targets", rows: [] },
    { match: "DELETE FROM telegram_alert_source_resolution_targets", rows: [] },
    { match: "DELETE FROM telegram_alert_target_plan_items", rows: [] },
    { match: "DELETE FROM telegram_alert_job_targets", rows: [] },
    { match: "DELETE FROM telegram_alert_job_target_items", rows: [] },
    { match: "DELETE FROM telegram_alert_target_plans", rows: [] },
    { match: "DELETE FROM telegram_alert_planning_subscribers", rows: [] },
    { match: "DELETE FROM telegram_transport_failure_observations", rows: [] },
    { match: "DELETE FROM telegram_alert_dead_letters", rows: [] },
    { match: "DELETE FROM telegram_chat_delivery_diagnostics", rows: [] },
    { match: "INSERT OR REPLACE INTO cache", rows: [] },
    { match: "INSERT INTO cache", rows: [] },
    { match: "UPDATE cache", rows: [] },
    { match: "DELETE FROM cache", rows: [] },
    { match: "INSERT INTO telegram_usage_daily", rows: [] },
    { match: "INSERT OR IGNORE INTO telegram_processed_updates", rows: [], runMeta: { changes: 1 } },
    { match: "UPDATE telegram_processed_updates", rows: [], runMeta: { changes: 1 } },
    { match: "FROM cache", rows: [], first: null },
  ], options);
}

async function hmacSha256(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signedInitData(fields: Record<string, string>, token = BOT_TOKEN): Promise<string> {
  const params = new URLSearchParams(fields);
  const check = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");
  const secret = await hmacSha256(encoder.encode("WebAppData"), token);
  params.set("hash", hex(await hmacSha256(secret, check)));
  return params.toString();
}

function request(path: string, body: unknown): Request {
  return new Request(`https://api.pharos.watch${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function versionedRequest(path: string, body: unknown, versions: {
  contractVersion?: string;
  catalogVersion?: string;
} = {}): Request {
  const url = new URL(path, "https://api.pharos.watch");
  url.searchParams.set(
    TELEGRAM_MINI_APP_CONTRACT_VERSION_PARAM,
    versions.contractVersion ?? TELEGRAM_MINI_APP_CONTRACT_VERSION,
  );
  url.searchParams.set(
    TELEGRAM_MINI_APP_CATALOG_VERSION_PARAM,
    versions.catalogVersion ?? TELEGRAM_MINI_APP_CATALOG_VERSION,
  );
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function streamedRequest(path: string, chunks: string[], headers: Record<string, string> = {}): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Request(`https://api.pharos.watch${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

async function privateInitData(ageSec = 60, startParam?: string): Promise<string> {
  return signedInitData({
    auth_date: String(NOW_SEC - ageSec),
    chat_type: "private",
    ...(startParam ? { start_param: startParam } : {}),
    user: JSON.stringify({ id: 42, username: "alice" }),
  });
}

function stateReadTables(overrides: {
  subscriber?: Record<string, unknown> | null;
  subscriptions?: Record<string, unknown>[];
  presets?: Record<string, unknown>[];
} = {}): MockTableConfig[] {
  const subscriber = overrides.subscriber ?? {
    global_alert_dews: 0,
    global_alert_depeg: 0,
    global_alert_safety: 0,
    global_alert_launch: 0,
    global_alert_reserve: 0,
    global_depeg_worsening_bps_step: null,
    quiet_hours_enabled: 0,
    quiet_hours_start_utc: null,
    quiet_hours_end_utc: null,
    timezone: null,
    alert_snooze_until_ts: null,
  };
  return [
    {
      match: "FROM telegram_subscribers",
      first: subscriber,
      rows: subscriber == null ? [] : [subscriber],
    },
    { match: "FROM telegram_subscriptions", rows: overrides.subscriptions ?? [] },
    { match: "FROM telegram_preset_subscriptions", rows: overrides.presets ?? [] },
    { match: "FROM telegram_chat_delivery_diagnostics", first: null, rows: [] },
    { match: "FROM telegram_pending_alerts", first: { queued_alerts: 0 }, rows: [{ queued_alerts: 0 }] },
  ];
}





function historyHas(db: MockD1Database, sqlNeedle: string, bindNeedles: unknown[] = []): boolean {
  return db.getHistory().some((entry) =>
    entry.sql.includes(sqlNeedle)
    && bindNeedles.every((value) => entry.binds.includes(value)),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_SEC * 1000);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("handleTelegramMiniAppSession", () => {
  it("returns a compact versioned snapshot while legacy clients retain the full catalog", async () => {
    const initData = await privateInitData();
    const versionedDb = mockD1(stateReadTables());
    const legacyDb = mockD1(stateReadTables());

    const compactResponse = await handleTelegramMiniAppSession(
      versionedDb,
      versionedRequest("/api/telegram-mini-app/session", { initData }),
      BOT_TOKEN,
    );
    const compactText = await compactResponse.text();
    const compact = TelegramMiniAppSnapshotSchema.parse(JSON.parse(compactText));

    const legacyResponse = await handleTelegramMiniAppSession(
      legacyDb,
      request("/api/telegram-mini-app/session", { initData }),
      BOT_TOKEN,
    );
    const legacyText = await legacyResponse.text();
    const legacy = JSON.parse(legacyText) as { catalog?: { searchableCoins?: unknown[] } };

    expect(compactResponse.status).toBe(200);
    expect(compact.contractVersion).toBe(TELEGRAM_MINI_APP_CONTRACT_VERSION);
    expect(compact.catalogVersion).toBe(TELEGRAM_MINI_APP_CATALOG_VERSION);
    expect(compact.stateRevision).toMatch(/^state-v1-/);
    expect(compact).not.toHaveProperty("catalog");
    expect(compact.state).not.toHaveProperty("catalog");
    expect(legacy.catalog?.searchableCoins?.length).toBeGreaterThan(300);
    expect(compactText.length).toBeLessThan(legacyText.length / 10);
  });

  it("rejects version skew before auth, cooldown, or analytics writes", async () => {
    const db = mockD1();
    const response = await handleTelegramMiniAppSession(
      db,
      versionedRequest("/api/telegram-mini-app/session", { initData: "not-signed" }, {
        catalogVersion: "catalog-v0-stale",
      }),
      BOT_TOKEN,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "catalog-version-mismatch",
      contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION,
      catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
    });
    expect(db.getHistory()).toEqual([]);
  });

  it("returns private-chat state", async () => {
    const initData = await privateInitData();
    const db = mockD1([
      ...stateReadTables({
        subscriber: { global_alert_dews: 1, global_alert_depeg: 0, global_alert_safety: 0, global_alert_launch: 0, global_depeg_worsening_bps_step: 250, quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null, timezone: null, alert_snooze_until_ts: null },
        subscriptions: [{ stablecoin_id: "usdc-circle", alert_dews: 1, alert_depeg: 1, alert_safety: 0, alert_launch: 0, alert_dews_override: 1, alert_depeg_override: 1, dews_min_band: "ALERT", safety_mode: null, depeg_worsening_bps_step: 250, alert_snooze_until_ts: null }],
      }),
    ]);

    const response = await handleTelegramMiniAppSession(db, request("/api/telegram-mini-app/session", { initData }), BOT_TOKEN);
    const body = await response.json() as {
      viewer: { canMutate: boolean; chatId: string | null };
      subscriber: {
        exists: boolean;
        snoozeUntilTs: number | null;
        recap: {
          enabled: boolean;
          deliveryHourLocal: number;
          timezoneConfirmed: boolean;
          nextDueAt: number | null;
          lastWindowEndAt: number | null;
          lastDeliveredLocalDate: string | null;
          lastOutcome: string | null;
        };
      };
      subscriptions: Array<{ stablecoinId: string; symbol: string; alertTypes: { dews: boolean; depeg: boolean }; alertOverrides: { dews: boolean; depeg: boolean } }>;
      catalog: { searchableCoins: Array<{ stablecoinId: string }> };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.viewer.canMutate).toBe(true);
    expect(body.viewer.chatId).toBe("42");
    expect(body.subscriber.exists).toBe(true);
    expect(body.subscriber.snoozeUntilTs).toBeNull();
    expect(body.subscriber.recap).toEqual({
      available: true,
      enabled: false,
      deliveryHourLocal: 9,
      timezoneConfirmed: false,
      nextDueAt: null,
      lastWindowEndAt: null,
      lastDeliveredLocalDate: null,
      lastOutcome: null,
    });
    expect(body.subscriptions[0]).toMatchObject({
      stablecoinId: "usdc-circle",
      symbol: "USDC",
      alertTypes: { dews: true, depeg: true },
      alertOverrides: { dews: true, depeg: true },
    });
    expect(body.catalog.searchableCoins.length).toBeGreaterThan(0);
  });

  it("marks recap unavailable in an off rollout and rejects its mutation before a preference write", async () => {
    const initData = await privateInitData();
    const offPolicy = { mode: "off" as const, allowedChatIds: new Set<string>() };
    const sessionDb = mockD1(stateReadTables());

    const session = await handleTelegramMiniAppSession(
      sessionDb,
      request("/api/telegram-mini-app/session", { initData }),
      BOT_TOKEN,
      undefined,
      offPolicy,
    );

    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toMatchObject({ subscriber: { recap: { available: false } } });

    const mutationDb = mockD1();
    const mutation = await handleTelegramMiniAppMutation(
      mutationDb,
      request("/api/telegram-mini-app/mutate", {
        initData,
        operation: { kind: "set-recap", enabled: true, deliveryHourLocal: 9 },
      }),
      BOT_TOKEN,
      undefined,
      offPolicy,
    );

    expect(mutation.status).toBe(404);
    await expect(mutation.json()).resolves.toMatchObject({ code: "recap-unavailable" });
    expect(historyHas(mutationDb, "telegram_recap_preferences")).toBe(false);
  });

  it("loads private-chat state through one D1 batch plus separate health diagnostics", async () => {
    const initData = await privateInitData();
    const db = mockD1(stateReadTables()) as MockD1Database;
    const batchSpy = vi.spyOn(db, "batch");

    const response = await handleTelegramMiniAppSession(db, request("/api/telegram-mini-app/session", { initData }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(batchSpy).toHaveBeenCalledTimes(2);
    expect(batchSpy.mock.calls[0]?.[0]).toHaveLength(2);
    expect(batchSpy.mock.calls[1]?.[0]).toHaveLength(5);
    const history = db.getHistory();
    expect(history.filter((entry) => entry.sql.includes("FROM telegram_chat_delivery_diagnostics"))).toHaveLength(1);
  });

  it("hides inert rows but keeps marker-backed local-off and snooze-only rows", async () => {
    const initData = await privateInitData();
    const db = mockD1([
      ...stateReadTables({
        subscriptions: [
          { stablecoin_id: "usdt-tether", alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0, dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null, alert_snooze_until_ts: null },
          { stablecoin_id: "pyusd-paypal", alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0, alert_dews_override: 1, dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null, alert_snooze_until_ts: null },
          { stablecoin_id: "usdc-circle", alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0, dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null, alert_snooze_until_ts: NOW_SEC + 3600 },
          { stablecoin_id: "eurc-circle", alert_dews: 1, alert_depeg: 0, alert_safety: 0, alert_launch: 0, dews_min_band: "ALERT", safety_mode: null, depeg_worsening_bps_step: null, alert_snooze_until_ts: null },
        ],
      }),
    ]);

    const response = await handleTelegramMiniAppSession(db, request("/api/telegram-mini-app/session", { initData }), BOT_TOKEN);
    const body = await response.json() as {
      subscriptions: Array<{ stablecoinId: string; snoozeUntilTs: number | null; alertOverrides: { dews: boolean } }>;
    };

    expect(response.status).toBe(200);
    expect(body.subscriptions.map((row) => row.stablecoinId)).toEqual(["pyusd-paypal", "usdc-circle", "eurc-circle"]);
    expect(body.subscriptions[0]).toMatchObject({ stablecoinId: "pyusd-paypal", alertOverrides: { dews: true } });
    expect(body.subscriptions[1]).toMatchObject({ stablecoinId: "usdc-circle", snoozeUntilTs: NOW_SEC + 3600 });
  });

  it("accepts Telegram session initData with the Ed25519 signature field", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      chat_type: "private",
      signature: "telegram-ed25519-signature",
      user: JSON.stringify({ id: 42, username: "alice" }),
    });
    const db = mockD1(stateReadTables());

    const response = await handleTelegramMiniAppSession(db, request("/api/telegram-mini-app/session", { initData }), BOT_TOKEN);

    expect(response.status).toBe(200);
  });

  it("keeps stale-but-valid sessions read-only", async () => {
    const initData = await privateInitData(3_600);
    const db = mockD1(stateReadTables());

    const response = await handleTelegramMiniAppSession(db, request("/api/telegram-mini-app/session", { initData }), BOT_TOKEN);
    const body = await response.json() as { viewer: { canMutate: boolean; mutationBlockReason: string | null } };

    expect(response.status).toBe(200);
    expect(body.viewer.canMutate).toBe(false);
    expect(body.viewer.mutationBlockReason).toBe("stale-auth");
  });

  it("marks group launches read-only", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      chat_type: "supergroup",
      user: JSON.stringify({ id: 42, username: "alice" }),
    });
    const db = mockD1();

    const response = await handleTelegramMiniAppSession(db, request("/api/telegram-mini-app/session", { initData }), BOT_TOKEN);
    const body = await response.json() as { viewer: { canMutate: boolean; mutationBlockReason: string } };

    expect(response.status).toBe(200);
    expect(body.viewer.canMutate).toBe(false);
    expect(body.viewer.mutationBlockReason).toBe("not-private");
  });

  it("treats direct-link sender launches as mutable private-chat state", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      chat_type: "sender",
      user: JSON.stringify({ id: 42, username: "alice" }),
    });
    const db = mockD1(stateReadTables());

    const response = await handleTelegramMiniAppSession(db, request("/api/telegram-mini-app/session", { initData }), BOT_TOKEN);
    const body = await response.json() as {
      viewer: {
        chatId: string | null;
        chatType: string | null;
        canMutate: boolean;
        mutationBlockReason: string | null;
      };
    };

    expect(response.status).toBe(200);
    expect(body.viewer.chatId).toBe("42");
    expect(body.viewer.chatType).toBe("sender");
    expect(body.viewer.canMutate).toBe(true);
    expect(body.viewer.mutationBlockReason).toBeNull();
  });

  it("validates session initData with the previous bot token during rotation overlap", async () => {
    const previousToken = "previous-bot-token";
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      chat_type: "private",
      user: JSON.stringify({ id: 42, username: "alice" }),
    }, previousToken);
    const db = mockD1(stateReadTables());

    const response = await handleTelegramMiniAppSession(
      db,
      request("/api/telegram-mini-app/session", { initData }),
      BOT_TOKEN,
      previousToken,
    );
    const body = await response.json() as { viewer: { chatId: string | null; canMutate: boolean } };

    expect(response.status).toBe(200);
    expect(body.viewer.chatId).toBe("42");
    expect(body.viewer.canMutate).toBe(true);
  });

  it("marks channel launches read-only without loading channel-scoped rows", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      chat_type: "channel",
      user: JSON.stringify({ id: 42, username: "alice" }),
    });
    const db = mockD1();

    const response = await handleTelegramMiniAppSession(db, request("/api/telegram-mini-app/session", { initData }), BOT_TOKEN);
    const body = await response.json() as {
      viewer: {
        chatId: string | null;
        chatType: string | null;
        canMutate: boolean;
        mutationBlockReason: string | null;
      };
    };

    expect(response.status).toBe(200);
    expect(body.viewer.chatId).toBeNull();
    expect(body.viewer.chatType).toBe("channel");
    expect(body.viewer.canMutate).toBe(false);
    expect(body.viewer.mutationBlockReason).toBe("not-private");
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM telegram_subscribers"))).toBe(false);
  });

  it("rate-limits repeated session opens after successful auth", async () => {
    const initData = await privateInitData();
    const cooldownKey = "telegram:command-cooldown:42:mini-app:session";
    const db = mockD1([
      {
        match: "INSERT INTO cache (key, value, updated_at)",
        matchBinds: [cooldownKey, "1", NOW_SEC, NOW_SEC - 2],
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "SELECT updated_at FROM cache WHERE key = ?",
        matchBinds: [cooldownKey],
        rows: [{ updated_at: NOW_SEC - 1 }],
      },
    ]);

    const response = await handleTelegramMiniAppSession(db, request("/api/telegram-mini-app/session", { initData }), BOT_TOKEN);

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "Mini App session rate limited" });
    // P1.3: cooldown denials must emit `mini_app_session_invalid` with the
    // `rate_limited` failure class so abuse signals are visible on dashboards.
    const deniedRows = db
      .getHistory()
      .filter((entry) =>
        entry.sql.includes("INSERT INTO telegram_usage_daily")
        && entry.binds.includes("mini_app_session_invalid"),
      );
    expect(deniedRows).toHaveLength(1);
    expect(deniedRows[0].binds).toContain("rate_limited");
  });

  it("does not emit analytics for oversized pre-auth session bodies", async () => {
    // Body-cap rejections fire before HMAC validation and must not write
    // unauthenticated analytics rows on the public Mini App endpoint.
    const db = mockD1();
    const req = new Request("https://api.pharos.watch/api/telegram-mini-app/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(20 * 1024) },
      body: JSON.stringify({ initData: "x" }),
    });

    const response = await handleTelegramMiniAppSession(db, req, BOT_TOKEN);

    expect(response.status).toBe(413);
    expect(db.getHistory()).toHaveLength(0);
  });

  it("rejects oversized session bodies with 413 before parsing JSON", async () => {
    const db = mockD1();
    const req = new Request("https://api.pharos.watch/api/telegram-mini-app/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(20 * 1024) },
      body: JSON.stringify({ initData: "x" }),
    });

    const response = await handleTelegramMiniAppSession(db, req, BOT_TOKEN);

    expect(response.status).toBe(413);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    // No state SELECT, cooldown INSERT, HMAC validation, or analytics write fires pre-auth.
    expect(db.getHistory()).toHaveLength(0);
  });

  it("rejects malformed session JSON without pre-auth analytics writes", async () => {
    const db = mockD1();
    const req = new Request("https://api.pharos.watch/api/telegram-mini-app/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    const response = await handleTelegramMiniAppSession(db, req, BOT_TOKEN);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "validation-error" });
    expect(db.getHistory()).toHaveLength(0);
  });

  it("rejects oversized streamed session bodies without relying on Content-Length", async () => {
    const db = mockD1();
    const req = streamedRequest("/api/telegram-mini-app/session", [
      "{\"initData\":\"",
      "x".repeat(17 * 1024),
      "\"}",
    ]);

    const response = await handleTelegramMiniAppSession(db, req, BOT_TOKEN);

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "body-too-large" });
    // No state SELECT, cooldown INSERT, HMAC validation, or analytics write fires pre-auth.
    expect(db.getHistory()).toHaveLength(0);
  });

  it("rejects lying-small Content-Length session streams through the bounded reader", async () => {
    const db = mockD1();
    const req = streamedRequest(
      "/api/telegram-mini-app/session",
      [
        "{\"initData\":\"",
        "x".repeat(17 * 1024),
        "\"}",
      ],
      { "Content-Length": "12" },
    );

    const response = await handleTelegramMiniAppSession(db, req, BOT_TOKEN);

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "body-too-large" });
    expect(db.getHistory()).toHaveLength(0);
  });

  it("rejects malformed hash with 401 without HMAC compute", async () => {
    const initData = new URLSearchParams({
      auth_date: String(NOW_SEC - 60),
      hash: "0".repeat(63),
      user: JSON.stringify({ id: 42 }),
    }).toString();
    const db = mockD1();

    const response = await handleTelegramMiniAppSession(db, request("/api/telegram-mini-app/session", { initData }), BOT_TOKEN);

    expect(response.status).toBe(401);
    expect(db.getHistory()).toHaveLength(0);
  });

  it("rejects oversized initData via schema before HMAC compute", async () => {
    const initData = "auth_date=1&hash=" + "a".repeat(64) + "&user=" + encodeURIComponent(JSON.stringify({ id: 42 }));
    const padded = initData + "&padding=" + "x".repeat(8 * 1024);
    const db = mockD1();

    const response = await handleTelegramMiniAppSession(db, request("/api/telegram-mini-app/session", { initData: padded }), BOT_TOKEN);

    expect(response.status).toBe(400);
    // Schema-validation failures happen before HMAC and must not write analytics.
    expect(db.getHistory()).toHaveLength(0);
  });

  it("rejects an unsigned start_param body override", async () => {
    const initData = await privateInitData();
    const db = mockD1(stateReadTables());

    const response = await handleTelegramMiniAppSession(db, request("/api/telegram-mini-app/session", {
      initData,
      startParam: "evil",
    }), BOT_TOKEN);

    expect(response.status).toBe(400);
  });

  it("does not write analytics or cooldown rows for invalid auth", async () => {
    const initData = new URLSearchParams({
      auth_date: String(NOW_SEC - 60),
      hash: "0".repeat(64),
      user: JSON.stringify({ id: 42, username: "alice" }),
    }).toString();
    const db = mockD1();

    const response = await handleTelegramMiniAppSession(db, request("/api/telegram-mini-app/session", { initData }), BOT_TOKEN);

    expect(response.status).toBe(401);
    expect(db.getHistory()).toHaveLength(0);
  });

  it("emits mini_app_session_invalid on stale auth but not on invalid signature", async () => {
    // T-63: stale-auth has already passed the HMAC check, so emitting a
    // usage event does not create an unauthenticated-write gate. Invalid
    // signature stays silent.
    // 24h session window + 1s gives stale-auth from the session handler.
    const staleInitData = await signedInitData({
      auth_date: String(NOW_SEC - 24 * 60 * 60 - 1),
      chat_type: "private",
      user: JSON.stringify({ id: 42, username: "alice" }),
    });
    const staleDb = mockD1();
    const staleResponse = await handleTelegramMiniAppSession(
      staleDb,
      request("/api/telegram-mini-app/session", { initData: staleInitData }),
      BOT_TOKEN,
    );
    expect(staleResponse.status).toBe(401);
    const staleInvalidRows = staleDb
      .getHistory()
      .filter((entry) =>
        entry.sql.includes("INSERT INTO telegram_usage_daily")
        && entry.binds.includes("mini_app_session_invalid"),
      );
    expect(staleInvalidRows).toHaveLength(1);
    expect(staleInvalidRows[0].binds).toContain("stale-auth");

    // Invalid signature: zero-byte hash. Must not write any analytics row.
    const invalidInitData = new URLSearchParams({
      auth_date: String(NOW_SEC - 60),
      hash: "0".repeat(64),
      user: JSON.stringify({ id: 42, username: "alice" }),
    }).toString();
    const invalidDb = mockD1();
    const invalidResponse = await handleTelegramMiniAppSession(
      invalidDb,
      request("/api/telegram-mini-app/session", { initData: invalidInitData }),
      BOT_TOKEN,
    );
    expect(invalidResponse.status).toBe(401);
    expect(invalidDb.getHistory()).toHaveLength(0);
  });

  it("rate-limits stale auth telemetry by signed Mini App user", async () => {
    const staleInitData = await signedInitData({
      auth_date: String(NOW_SEC - 301),
      chat_type: "private",
      user: JSON.stringify({ id: 42, username: "alice" }),
    });
    const cooldownKey = "telegram:command-cooldown:42:mini-app:mutation-auth-failure";
    const db = mockD1([
      {
        match: "INSERT INTO cache (key, value, updated_at)",
        matchBinds: [cooldownKey, "1", NOW_SEC, NOW_SEC - 5],
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "SELECT updated_at FROM cache WHERE key = ?",
        matchBinds: [cooldownKey],
        rows: [{ updated_at: NOW_SEC - 1 }],
      },
    ]);

    const response = await handleTelegramMiniAppMutation(
      db,
      request("/api/telegram-mini-app/mutate", { initData: staleInitData, operation: { kind: "clear-snooze" } }),
      BOT_TOKEN,
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "rate-limited" });
    expect(historyHas(db, "INSERT INTO cache (key, value, updated_at)", [cooldownKey])).toBe(true);
    expect(historyHas(db, "INSERT INTO telegram_usage_daily", ["mini_app_mutation_denied"])).toBe(false);
  });

  it("emits mini_app_mutation_denied with a stale-auth class on stale mutation auth", async () => {
    // TGB-022 measurement: stale-auth mutation denials must be separable from
    // session-read expiry (`mini_app_session_invalid`) in `telegram_usage_daily`.
    const staleInitData = await signedInitData({
      auth_date: String(NOW_SEC - 301),
      chat_type: "private",
      user: JSON.stringify({ id: 42, username: "alice" }),
    });
    const db = mockD1();

    const response = await handleTelegramMiniAppMutation(
      db,
      request("/api/telegram-mini-app/mutate", { initData: staleInitData, operation: { kind: "clear-snooze" } }),
      BOT_TOKEN,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "stale-auth" });
    const deniedRows = db
      .getHistory()
      .filter((entry) =>
        entry.sql.includes("INSERT INTO telegram_usage_daily")
        && entry.binds.includes("mini_app_mutation_denied"),
      );
    expect(deniedRows).toHaveLength(1);
    expect(deniedRows[0].binds).toContain("stale-auth");
    expect(deniedRows[0].binds).toContain(mutationActionDetail({ kind: "clear-snooze" }));
    expect(historyHas(db, "INSERT INTO telegram_usage_daily", ["mini_app_session_invalid"])).toBe(false);
  });

  it("attaches a non-null latencyBucket to successful session analytics rows", async () => {
    // T-64: every recordMiniAppEvent call carries latency telemetry. With fake
    // timers `Date.now() - start === 0`, which buckets to "lt_250ms".
    const initData = await privateInitData();
    const db = mockD1(stateReadTables());

    const response = await handleTelegramMiniAppSession(
      db,
      request("/api/telegram-mini-app/session", { initData }),
      BOT_TOKEN,
    );

    expect(response.status).toBe(200);
    const sessionValidRows = db
      .getHistory()
      .filter((entry) =>
        entry.sql.includes("INSERT INTO telegram_usage_daily")
        && entry.binds.includes("mini_app_session_valid"),
      );
    expect(sessionValidRows).toHaveLength(1);
    // latency_bucket is the sixth bind in the INSERT (see telegram-usage-analytics.ts).
    expect(sessionValidRows[0].binds[5]).toBe("lt_250ms");
  });

  it("records aggregate recap button actions without storing user identifiers", async () => {
    const initData = await privateInitData(60, "recap_watchlist");
    const db = mockD1(stateReadTables());

    const response = await handleTelegramMiniAppSession(
      db,
      request("/api/telegram-mini-app/session", { initData }),
      BOT_TOKEN,
    );

    expect(response.status).toBe(200);
    const row = db.getHistory().find((entry) =>
      entry.sql.includes("INSERT INTO telegram_usage_daily")
      && entry.binds.includes("mini_app_session_valid"));
    expect(row?.binds).toContain("recap_view_watchlist");
    expect(row?.binds).not.toContain("42");
    expect(row?.binds).not.toContain("alice");
  });

  it("records the recap-settings launch action without storing user identifiers", async () => {
    const initData = await privateInitData(60, "recap_settings");
    const db = mockD1(stateReadTables());

    const response = await handleTelegramMiniAppSession(
      db,
      request("/api/telegram-mini-app/session", { initData }),
      BOT_TOKEN,
    );

    expect(response.status).toBe(200);
    const row = db.getHistory().find((entry) =>
      entry.sql.includes("INSERT INTO telegram_usage_daily")
      && entry.binds.includes("mini_app_session_valid"));
    expect(row?.binds).toContain("recap_settings");
    expect(row?.binds).not.toContain("42");
    expect(row?.binds).not.toContain("alice");
  });
});

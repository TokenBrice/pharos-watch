import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1, type MockD1Database, type MockPreparedStatement, type MockTableConfig } from "../../test-helpers/__shared/mock-d1";
import { PAUSE_SENTINEL_TS } from "../../lib/telegram-constants";
import { FROZEN_STABLECOINS } from "@shared/lib/stablecoins/registry";
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

async function privateInitData(ageSec = 60): Promise<string> {
  return signedInitData({
    auth_date: String(NOW_SEC - ageSec),
    chat_type: "private",
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

function stablecoinsCacheTable(): MockTableConfig {
  return {
    match: "SELECT value, updated_at FROM cache WHERE key = ?",
    matchBinds: ["stablecoins"],
    rows: [{
      key: "stablecoins",
      value: JSON.stringify({
        peggedAssets: [
          { id: "usdt-tether", symbol: "USDT", name: "Tether", circulating: { peggedUSD: 1_000_000_000 } },
          { id: "usdc-circle", symbol: "USDC", name: "USD Coin", circulating: { peggedUSD: 900_000_000 } },
          { id: "eurc-circle", symbol: "EURC", name: "Euro Coin", circulating: { peggedUSD: 800_000_000 } },
        ],
      }),
      updated_at: NOW_SEC,
    }],
  };
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
});

describe("handleTelegramMiniAppMutation", () => {
  it("returns only mutable state and revision for a routine versioned mutation", async () => {
    const initData = await privateInitData();
    const db = mockD1(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, versionedRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-global", alertType: "safety", enabled: true },
    }), BOT_TOKEN);
    const responseText = await response.text();
    const body = TelegramMiniAppSnapshotSchema.parse(JSON.parse(responseText));

    expect(response.status).toBe(200);
    expect(body.stateRevision).toMatch(/^state-v1-/);
    expect(body).not.toHaveProperty("catalog");
    expect(body.state).not.toHaveProperty("catalog");
    expect(responseText.length).toBeLessThan(8 * 1024);
  });

  it("rejects version skew before burst admission, analytics, or mutation writes", async () => {
    const db = mockD1();
    const response = await handleTelegramMiniAppMutation(db, versionedRequest("/api/telegram-mini-app/mutate", {
      initData: "not-signed",
      operation: { kind: "set-global", alertType: "safety", enabled: true },
    }, {
      contractVersion: "1",
    }), BOT_TOKEN);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "contract-version-mismatch",
      contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION,
      catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
    });
    expect(db.getHistory()).toEqual([]);
  });

  it("uses semantic action details for timezone and unsubscribe-all mutations", () => {
    expect(mutationActionDetail({ kind: "set-timezone", timezone: "Europe/Paris" })).toBe("timezone");
    expect(mutationActionDetail({ kind: "unsubscribe-all" })).toBe("all");
  });

  it("allows a stale signed session to export without consuming mutation burst capacity", async () => {
    const initData = await privateInitData(60 * 60);
    const db = mockD1(stateReadTables({
      subscriptions: [{
        stablecoin_id: "usdc-circle",
        alert_dews: 1,
        alert_depeg: 0,
        alert_safety: 0,
        alert_launch: 0,
        alert_reserve: 0,
        alert_dews_override: 1,
        alert_depeg_override: 0,
        alert_safety_override: 0,
        alert_launch_override: 0,
        alert_reserve_override: 0,
        dews_min_band: null,
        safety_mode: null,
        depeg_worsening_bps_step: null,
      }],
    }));

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "export-watchlist" },
    }), BOT_TOKEN);
    const body = await response.json() as { result?: { kind?: string; token?: string } };

    expect(response.status).toBe(200);
    expect(body.result?.kind).toBe("watchlist-export");
    expect(body.result?.token).toMatch(/^pw3\./);
    expect(db.getHistory().some((entry) => entry.binds.some((value) => String(value).includes("mini-app:mutation")))).toBe(false);
    expect(historyHas(db, "INSERT INTO telegram_usage_daily", ["mini_app_portability", "watchlist_export"])).toBe(true);
    expect(historyHas(db, "INSERT INTO telegram_usage_daily", ["mini_app_mutation", "watchlist_export"])).toBe(false);
  });

  it("exports freeze intent through pw3 without using mutation telemetry", async () => {
    const initData = await privateInitData(60 * 60);
    const db = mockD1(stateReadTables({
      subscriptions: [{
        stablecoin_id: "usdc-circle",
        alert_dews: 0,
        alert_depeg: 0,
        alert_safety: 0,
        alert_launch: 0,
        alert_reserve: 0,
        alert_freeze: 1,
        alert_dews_override: 0,
        alert_depeg_override: 0,
        alert_safety_override: 0,
        alert_launch_override: 0,
        alert_reserve_override: 0,
        alert_freeze_override: 1,
        dews_min_band: null,
        safety_mode: null,
        depeg_worsening_bps_step: null,
      }],
    }));

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "export-watchlist" },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { kind: "watchlist-export", token: expect.stringMatching(/^pw3\./) } });
    expect(historyHas(db, "INSERT INTO telegram_usage_daily", ["mini_app_portability", "watchlist_export"])).toBe(true);
    expect(historyHas(db, "INSERT INTO telegram_usage_daily", ["mini_app_mutation_denied", "watchlist_export"])).toBe(false);
  });

  it("applies global alert mutations", async () => {
    const initData = await privateInitData();
    const db = mockD1(stateReadTables({
      subscriber: { global_alert_dews: 0, global_alert_depeg: 0, global_alert_safety: 1, global_alert_launch: 0, global_depeg_worsening_bps_step: null, quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null, timezone: null, alert_snooze_until_ts: null },
    }));

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-global", alertType: "safety", enabled: true },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(db.getHistory().some((entry) => entry.sql.includes("global_alert_safety = excluded.global_alert_safety"))).toBe(true);
  });

  it("applies global depeg-step mutations", async () => {
    const initData = await privateInitData();
    const db = mockD1(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-global-depeg-step", depegStepBps: 500 },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(db.getHistory().some((entry) => entry.sql.includes("global_alert_depeg = MAX(telegram_subscribers.global_alert_depeg, excluded.global_alert_depeg)"))).toBe(true);
    expect(historyHas(db, "global_depeg_worsening_bps_step = ?", [500, NOW_SEC, "42"])).toBe(true);
  });

  it("applies quiet-hour mutations with exact quiet window binds", async () => {
    const initData = await privateInitData();
    const db = mockD1(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-quiet-hours", enabled: true, startHourUtc: 22, endHourUtc: 7 },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(historyHas(db, "quiet_hours_enabled = excluded.quiet_hours_enabled", ["42", "alice", 1, 22, 7])).toBe(true);
  });

  it("clears subscriber snooze through the Mini App mutation path", async () => {
    const initData = await privateInitData();
    const db = mockD1(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "clear-snooze" },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(historyHas(db, "alert_snooze_until_ts = NULL", ["42", "alice"])).toBe(true);
  });

  it("does not re-enable an explicitly disabled coin alert family", async () => {
    const initData = await privateInitData();
    const db = mockD1(stateReadTables());
    const batchSizes: number[] = [];
    const originalBatch = db.batch.bind(db);
    (db as { batch: D1Database["batch"] }).batch = async (statements: D1PreparedStatement[]) => {
      batchSizes.push(statements.length);
      return originalBatch(statements);
    };

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: {
        kind: "set-coin",
        stablecoinId: "usdc-circle",
        patch: {
          alertTypes: { dews: false, depeg: true },
          dewsMinBand: "WARNING",
          safetyMode: "downgrade-only",
          launch: true,
        },
      },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(historyHas(db, "alert_dews = excluded.alert_dews", ["42", "usdc-circle", 0, null])).toBe(true);
    expect(historyHas(db, "alert_dews = excluded.alert_dews", ["42", "usdc-circle", 1, "WARNING"])).toBe(false);
    expect(historyHas(db, "alert_safety = excluded.alert_safety", ["42", "usdc-circle", 1, "downgrade-only"])).toBe(true);
    expect(historyHas(db, "alert_launch = excluded.alert_launch", ["42", "usdc-circle", 1])).toBe(true);
    expect(batchSizes[0]).toBeGreaterThan(1);
    expect(batchSizes).toContain(5);
  });

  it("enables per-coin depeg alerts when setting a worsening step", async () => {
    const initData = await privateInitData();
    const db = mockD1(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: {
        kind: "set-coin",
        stablecoinId: "usdc-circle",
        patch: { depegStepBps: 250 },
      },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(historyHas(db, "alert_depeg = 1", ["42", "usdc-circle", 250])).toBe(true);
    expect(historyHas(db, "depeg_worsening_bps_step = excluded.depeg_worsening_bps_step", ["42", "usdc-circle", 250])).toBe(true);
  });

  it("applies reserve alert mutations through direct and alert-type patches", async () => {
    const initData = await privateInitData();
    const enableDb = mockD1(stateReadTables());

    const enableResponse = await handleTelegramMiniAppMutation(enableDb, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: {
        kind: "set-coin",
        stablecoinId: "usdc-circle",
        patch: { reserve: true },
      },
    }), BOT_TOKEN);

    expect(enableResponse.status).toBe(200);
    expect(historyHas(enableDb, "alert_reserve = excluded.alert_reserve", ["42", "usdc-circle", 1])).toBe(true);
    expect(historyHas(enableDb, "alert_reserve = MAX(telegram_subscribers.alert_reserve, excluded.alert_reserve)", ["42", "alice", NOW_SEC])).toBe(true);

    const disableDb = mockD1(stateReadTables());
    const disableResponse = await handleTelegramMiniAppMutation(disableDb, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: {
        kind: "set-coin",
        stablecoinId: "usdc-circle",
        patch: { alertTypes: { reserve: false }, reserve: true },
      },
    }), BOT_TOKEN);

    expect(disableResponse.status).toBe(200);
    expect(historyHas(disableDb, "alert_reserve = excluded.alert_reserve", ["42", "usdc-circle", 0])).toBe(true);
    expect(historyHas(disableDb, "alert_reserve = excluded.alert_reserve", ["42", "usdc-circle", 1])).toBe(false);
  });

  it("returns a marker-backed local opt-out after disabling the last alert", async () => {
    const initData = await privateInitData();
    const db = mockD1(stateReadTables({
      subscriptions: [{ stablecoin_id: "usdc-circle", alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0, alert_depeg_override: 1, dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null, alert_snooze_until_ts: null }],
    }));

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: {
        kind: "set-coin",
        stablecoinId: "usdc-circle",
        patch: { alertTypes: { depeg: false } },
      },
    }), BOT_TOKEN);
    const body = await response.json() as { subscriptions: Array<{ stablecoinId: string; alertOverrides: { depeg: boolean } }> };

    expect(response.status).toBe(200);
    expect(historyHas(db, "alert_depeg = 0", ["42", "usdc-circle"])).toBe(true);
    expect(body.subscriptions).toEqual([
      expect.objectContaining({ stablecoinId: "usdc-circle", alertOverrides: expect.objectContaining({ depeg: true }) }),
    ]);
  });

  it("removes explicit coin subscriptions", async () => {
    const initData = await privateInitData();
    const db = mockD1(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "remove-coin", stablecoinId: "usdc-circle" },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(historyHas(db, "DELETE FROM telegram_subscriptions", ["42", "usdc-circle"])).toBe(true);
    expect(historyHas(db, "preference_generation = preference_generation + 1", ["42"])).toBe(true);
  });

  it("writes recommended setup as preset provenance without materializing coin rows", async () => {
    const initData = await privateInitData();
    const db = mockD1([stablecoinsCacheTable(), ...stateReadTables()]);

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "recommended-setup", presetId: "usd-top25", alertTypes: ["dews", "depeg"] },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(historyHas(db, "INSERT INTO telegram_subscriptions", ["42"])).toBe(false);
    expect(historyHas(db, "INSERT INTO telegram_preset_subscriptions", ["42", "usd-top25", 1, 1, 0])).toBe(true);
  });

  it("keeps authenticated transient failures inside the bounded mutation budget", async () => {
    const initData = await privateInitData();
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["stablecoins"],
        rows: [],
        first: null,
      },
    ]);

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "recommended-setup", presetId: "usd-top25", alertTypes: ["dews", "depeg"] },
    }), BOT_TOKEN);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "preset-unavailable" });
    expect(historyHas(db, "INSERT INTO cache (key, value, updated_at)", ["telegram:mini-app-mutation-burst:42"])).toBe(true);
    expect(historyHas(db, "DELETE FROM cache WHERE key = ?", [])).toBe(false);
  });

  it("follows and unfollows presets through exact preset tables", async () => {
    const initData = await privateInitData();
    const followDb = mockD1([stablecoinsCacheTable(), ...stateReadTables()]);
    const followResponse = await handleTelegramMiniAppMutation(followDb, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "follow-preset", presetId: "usd-top10", alertTypes: { dews: true, depeg: true }, depegStepBps: 250 },
    }), BOT_TOKEN);

    expect(followResponse.status).toBe(200);
    expect(historyHas(followDb, "INSERT INTO telegram_subscriptions", ["42"])).toBe(false);
    expect(historyHas(followDb, "INSERT INTO telegram_preset_subscriptions", ["42", "usd-top10", 1, 1, 0, 250])).toBe(true);

    const unfollowDb = mockD1(stateReadTables());
    const unfollowResponse = await handleTelegramMiniAppMutation(unfollowDb, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "unfollow-preset", presetId: "usd-top10" },
    }), BOT_TOKEN);

    expect(unfollowResponse.status).toBe(200);
    expect(historyHas(unfollowDb, "DELETE FROM telegram_subscriptions", ["42"])).toBe(false);
    expect(historyHas(unfollowDb, "DELETE FROM telegram_preset_subscriptions", ["42", "usd-top10"])).toBe(true);
  });

  it("accepts non-USD preset ids through Mini App follow mutations", async () => {
    const initData = await privateInitData();
    const db = mockD1([stablecoinsCacheTable(), ...stateReadTables()]);

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "follow-preset", presetId: "non-usd-top10", alertTypes: { dews: true } },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(historyHas(db, "INSERT INTO telegram_subscriptions", ["42"])).toBe(false);
    expect(historyHas(db, "INSERT INTO telegram_preset_subscriptions", ["42", "non-usd-top10", 1, 0, 0])).toBe(true);
  });

  it("does not persist subscription, preset, or analytics rows when D1 fails mid-batch", async () => {
    const initData = await privateInitData();
    const db = mockD1([stablecoinsCacheTable()]);
    const stagedStatements: Array<{ sql: string; binds: unknown[] }> = [];
    const committedStatements: Array<{ sql: string; binds: unknown[] }> = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
    (db as { batch: D1Database["batch"] }).batch = (async <T = unknown>(statements: D1PreparedStatement[]) => {
      const stagedForBatch: Array<{ sql: string; binds: unknown[] }> = [];
      for (const statement of statements as MockPreparedStatement[]) {
        const entry = { sql: statement.sql, binds: [...statement.boundValues] };
        stagedForBatch.push(entry);
        stagedStatements.push(entry);
        if (statement.sql.includes("INSERT INTO telegram_preset_subscriptions")) {
          throw new Error("mid-batch D1 failure");
        }
      }
      committedStatements.push(...stagedForBatch);
      return stagedForBatch.map(() => ({
        success: true,
        meta: { changes: 1 } as D1Meta & Record<string, unknown>,
        results: [] as T[],
      }));
    }) as D1Database["batch"];

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "recommended-setup", presetId: "usd-top25", alertTypes: ["dews", "depeg"] },
    }), BOT_TOKEN);

    expect(response.status).toBe(500);
    expect(stagedStatements.some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(false);
    expect(stagedStatements.some((entry) => entry.sql.includes("INSERT INTO telegram_preset_subscriptions"))).toBe(true);
    expect(committedStatements.some((entry) => entry.sql.includes("telegram_subscriptions"))).toBe(false);
    expect(committedStatements.some((entry) => entry.sql.includes("telegram_preset_subscriptions"))).toBe(false);
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO telegram_usage_daily"))).toBe(false);
  });

  it("denies group mutations", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      chat_type: "group",
      user: JSON.stringify({ id: 42 }),
    });
    const response = await handleTelegramMiniAppMutation(mockD1(), request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-global", alertType: "dews", enabled: true },
    }), BOT_TOKEN);
    expect(response.status).toBe(403);
  });

  it("allows direct-link sender mutations", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      chat_type: "sender",
      user: JSON.stringify({ id: 42, username: "alice" }),
    });
    const db = mockD1(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "clear-snooze" },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(historyHas(db, "alert_snooze_until_ts = NULL", ["42", "alice"])).toBe(true);
    expect(historyHas(db, "ON CONFLICT(key) DO NOTHING", [])).toBe(false);
  });

  it("allows multiple mutations from the same fresh Mini App launch", async () => {
    const initData = await privateInitData();
    const db = mockD1(stateReadTables());

    const firstResponse = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "clear-snooze" },
    }), BOT_TOKEN);
    const secondResponse = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-global", alertType: "safety", enabled: true },
    }), BOT_TOKEN);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("alert_snooze_until_ts = NULL"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("global_alert_safety = excluded.global_alert_safety"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("ON CONFLICT(key) DO NOTHING"))).toBe(false);
  });

  it("rejects stale mutation auth at the 5-minute boundary", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 301),
      chat_type: "private",
      user: JSON.stringify({ id: 42 }),
    });
    const response = await handleTelegramMiniAppMutation(mockD1(), request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "clear-snooze" },
    }), BOT_TOKEN);
    expect(response.status).toBe(401);
  });

  it("shares the mutation burst budget across operation kinds", async () => {
    const initData = await privateInitData();
    const burstKey = "telegram:mini-app-mutation-burst:42";
    const db = mockD1([
      {
        match: "INSERT INTO cache (key, value, updated_at)",
        matchBinds: [burstKey, NOW_SEC, NOW_SEC - 30, NOW_SEC - 30, NOW_SEC - 30, 12],
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "SELECT updated_at FROM cache WHERE key = ?",
        matchBinds: [burstKey],
        rows: [{ updated_at: NOW_SEC - 17 }],
      },
    ]);

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "remove-coin", stablecoinId: "usdc-circle" },
    }), BOT_TOKEN);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("13");
    expect(await response.json()).toMatchObject({ code: "rate-limited", retryAfterSec: 13 });
    // P1.3: mutation budget denials must emit `mini_app_mutation_denied`
    // with the `rate_limited` failure class so abuse signals are visible.
    const deniedRows = db
      .getHistory()
      .filter((entry) =>
        entry.sql.includes("INSERT INTO telegram_usage_daily")
        && entry.binds.includes("mini_app_mutation_denied"),
      );
    expect(deniedRows).toHaveLength(1);
    expect(deniedRows[0].binds).toContain("rate_limited");
  });

  it("rejects oversized mutation bodies with 413 before parsing JSON", async () => {
    const req = new Request("https://api.pharos.watch/api/telegram-mini-app/mutate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(20 * 1024) },
      body: JSON.stringify({ initData: "x", operation: { kind: "clear-snooze" } }),
    });

    const db = mockD1();
    const response = await handleTelegramMiniAppMutation(db, req, BOT_TOKEN);

    expect(response.status).toBe(413);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    // No state SELECT, cooldown INSERT, HMAC validation, or analytics write fires pre-auth.
    expect(db.getHistory()).toHaveLength(0);
  });

  it("rejects oversized streamed mutation bodies without relying on Content-Length", async () => {
    const db = mockD1();
    const req = streamedRequest("/api/telegram-mini-app/mutate", [
      "{\"initData\":\"x\",\"operation\":{\"kind\":\"set-timezone\",\"timezone\":\"",
      "x".repeat(17 * 1024),
      "\"}}",
    ]);

    const response = await handleTelegramMiniAppMutation(db, req, BOT_TOKEN);

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "body-too-large" });
    // Streamed body-cap failures are also pre-auth and must not write analytics.
    expect(db.getHistory()).toHaveLength(0);
  });

  it("rejects strict-schema violations on mutation payloads", async () => {
    const initData = await privateInitData();
    const db = mockD1();

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "clear-snooze", evil: 1 },
    }), BOT_TOKEN);

    expect(response.status).toBe(400);
    expect(db.getHistory()).toHaveLength(0);
  });

  it("rejects empty set-coin patches", async () => {
    const initData = await privateInitData();
    const db = mockD1();

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-coin", stablecoinId: "usdc-circle", patch: {} },
    }), BOT_TOKEN);

    expect(response.status).toBe(400);
    expect(historyHas(db, "INSERT INTO cache (key, value, updated_at)", ["telegram:mini-app-mutation-burst:42"])).toBe(false);
  });

  it("rejects set-quiet-hours with equal start and end hours", async () => {
    const initData = await privateInitData();
    const db = mockD1();

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-quiet-hours", enabled: true, startHourUtc: 3, endHourUtc: 3 },
    }), BOT_TOKEN);

    expect(response.status).toBe(400);
  });

  it("rejects non-canonical recommended-setup payloads", async () => {
    const initData = await privateInitData();
    const db = mockD1();

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "recommended-setup", presetId: "usd-top10", alertTypes: ["dews", "depeg"] },
    }), BOT_TOKEN);

    expect(response.status).toBe(400);
  });

  it("returns no-store on internal server errors", async () => {
    const initData = await privateInitData();
    const db = mockD1();
    (db as { batch: D1Database["batch"] }).batch = async () => {
      throw new Error("transient D1 failure");
    };

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "remove-coin", stablecoinId: "usdc-circle" },
    }), BOT_TOKEN);

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(db.getHistory().some((entry) => entry.sql.includes("ON CONFLICT(key) DO NOTHING"))).toBe(false);
    expect(historyHas(db, "INSERT INTO cache (key, value, updated_at)", ["telegram:mini-app-mutation-burst:42"])).toBe(true);
    expect(historyHas(db, "DELETE FROM cache WHERE key = ?", [])).toBe(false);
  });

  it("validates initData with the previous bot token when current rejects", async () => {
    const PREVIOUS_TOKEN = "previous-bot-token";
    const params = new URLSearchParams({
      auth_date: String(NOW_SEC - 60),
      chat_type: "private",
      user: JSON.stringify({ id: 42, username: "alice" }),
    });
    const check = [...params.entries()]
      .map(([key, value]) => `${key}=${value}`)
      .sort()
      .join("\n");
    const secret = await hmacSha256(encoder.encode("WebAppData"), PREVIOUS_TOKEN);
    params.set("hash", hex(await hmacSha256(secret, check)));
    const initData = params.toString();

    const db = mockD1(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "clear-snooze" },
    }), BOT_TOKEN, PREVIOUS_TOKEN);

    expect(response.status).toBe(200);
  });

  it("routes clear-snooze through the seam-compliant clearAlertSnooze helper", async () => {
    // The discriminator is the literal `alert_snooze_until_ts = NULL` SET
    // clause written by the canonical store helper.
    const initData = await privateInitData();
    const db = mockD1(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "clear-snooze" },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    // The seam compliance is enforced at the import level:
    // telegram-mini-app-mutations.ts imports clearAlertSnooze.
    expect(historyHas(db, "alert_snooze_until_ts = NULL", ["42", "alice"])).toBe(true);
  });

  it("applies a chat-wide snooze with the duration token offset", async () => {
    const initData = await privateInitData();
    const db = mockD1(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-snooze", durationToken: "4h" },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    // 4h = 14400s; alert_snooze_until_ts should be NOW + 14400.
    expect(historyHas(db, "alert_snooze_until_ts = excluded.alert_snooze_until_ts", ["42", "alice", NOW_SEC + 14400])).toBe(true);
  });

  it("writes the durable Paused sentinel via the pause op", async () => {
    const initData = await privateInitData();
    const db = mockD1(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "pause" },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(historyHas(db, "alert_snooze_until_ts = excluded.alert_snooze_until_ts", ["42", "alice", PAUSE_SENTINEL_TS])).toBe(true);
  });

  it("snoozes a single coin via set-coin-snooze and clears via the clear token", async () => {
    const initData = await privateInitData();
    const setDb = mockD1(stateReadTables());

    const setResponse = await handleTelegramMiniAppMutation(setDb, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-coin-snooze", stablecoinId: "usdc-circle", durationToken: "1h" },
    }), BOT_TOKEN);

    expect(setResponse.status).toBe(200);
    expect(historyHas(setDb, "INSERT INTO telegram_subscribers", ["42", null, NOW_SEC])).toBe(true);
    expect(historyHas(setDb, "INSERT INTO telegram_subscriptions", ["42", "usdc-circle", NOW_SEC + 3600])).toBe(true);

    const clearDb = mockD1(stateReadTables());
    const clearResponse = await handleTelegramMiniAppMutation(clearDb, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-coin-snooze", stablecoinId: "usdc-circle", durationToken: "clear" },
    }), BOT_TOKEN);

    expect(clearResponse.status).toBe(200);
    expect(historyHas(clearDb, "UPDATE telegram_subscriptions", ["42", "usdc-circle"])).toBe(true);
    expect(historyHas(clearDb, "DELETE FROM telegram_subscriptions", ["42", "usdc-circle"])).toBe(true);
    expect(historyHas(clearDb, "INSERT INTO telegram_subscriptions", ["42", "usdc-circle"])).toBe(false);
  });

  it("rejects new frozen-coin state but still permits frozen cleanup", async () => {
    const frozen = FROZEN_STABLECOINS[0];
    if (!frozen) throw new Error("Expected a frozen stablecoin fixture");
    const initData = await privateInitData();

    const setDb = mockD1();
    const setResponse = await handleTelegramMiniAppMutation(setDb, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: {
        kind: "set-coin",
        stablecoinId: frozen.id,
        patch: { alertTypes: { dews: true } },
      },
    }), BOT_TOKEN);
    expect(setResponse.status).toBe(400);
    expect(await setResponse.json()).toMatchObject({ code: "unknown-coin" });
    expect(historyHas(setDb, "INSERT INTO telegram_subscriptions", [frozen.id])).toBe(false);

    const snoozeDb = mockD1();
    const snoozeResponse = await handleTelegramMiniAppMutation(snoozeDb, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-coin-snooze", stablecoinId: frozen.id, durationToken: "1h" },
    }), BOT_TOKEN);
    expect(snoozeResponse.status).toBe(400);
    expect(await snoozeResponse.json()).toMatchObject({ code: "unknown-coin" });
    expect(historyHas(snoozeDb, "INSERT INTO telegram_subscriptions", [frozen.id])).toBe(false);

    const clearDb = mockD1(stateReadTables());
    const clearResponse = await handleTelegramMiniAppMutation(clearDb, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-coin-snooze", stablecoinId: frozen.id, durationToken: "clear" },
    }), BOT_TOKEN);
    expect(clearResponse.status).toBe(200);
    expect(historyHas(clearDb, "UPDATE telegram_subscriptions", ["42", frozen.id])).toBe(true);

    const removeDb = mockD1(stateReadTables());
    const removeResponse = await handleTelegramMiniAppMutation(removeDb, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "remove-coin", stablecoinId: frozen.id },
    }), BOT_TOKEN);
    expect(removeResponse.status).toBe(200);
    expect(historyHas(removeDb, "DELETE FROM telegram_subscriptions", ["42", frozen.id])).toBe(true);
  });

  it("rejects set-coin-snooze with a stable unknown-coin code on unknown coin", async () => {
    const initData = await privateInitData();
    const db = mockD1();

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-coin-snooze", stablecoinId: "not-a-coin", durationToken: "1h" },
    }), BOT_TOKEN);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Unknown stablecoin", code: "unknown-coin" });
  });

  it("persists a valid IANA timezone via set-timezone", async () => {
    const initData = await privateInitData();
    const db = mockD1(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-timezone", timezone: "Europe/Paris" },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(historyHas(db, "timezone = excluded.timezone", ["42", "alice", "Europe/Paris"])).toBe(true);
  });

  it("clears the timezone to UTC default when null is passed", async () => {
    const initData = await privateInitData();
    const db = mockD1(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-timezone", timezone: null },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(historyHas(db, "timezone = excluded.timezone", ["42", "alice", null])).toBe(true);
  });

  it("rejects invalid IANA timezones with a stable invalid-timezone code", async () => {
    const initData = await privateInitData();
    const db = mockD1();

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-timezone", timezone: "Not/AZone" },
    }), BOT_TOKEN);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Unknown timezone", code: "invalid-timezone" });
  });

  it("unsubscribe-all clears subscriptions, presets, and global flags in one batch", async () => {
    const initData = await privateInitData();
    const db = mockD1(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "unsubscribe-all" },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(historyHas(db, "DELETE FROM telegram_subscriptions", ["42"])).toBe(true);
    expect(historyHas(db, "DELETE FROM telegram_preset_subscriptions", ["42"])).toBe(true);
    expect(historyHas(db, "global_depeg_worsening_bps_step = NULL", [NOW_SEC, "42"])).toBe(true);
    expect(historyHas(db, "alert_reserve = 0", [NOW_SEC, "42"])).toBe(true);
    expect(historyHas(db, "global_alert_reserve = 0", [NOW_SEC, "42"])).toBe(true);
  });

  it("forget-me deletes subscriber-owned rows but retains processed_updates", async () => {
    const initData = await privateInitData();
    const db = mockD1(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "forget-me" },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(historyHas(db, "DELETE FROM telegram_subscriptions WHERE chat_id = ?", ["42"])).toBe(true);
    expect(historyHas(db, "DELETE FROM telegram_preset_subscriptions WHERE chat_id = ?", ["42"])).toBe(true);
    expect(historyHas(db, "DELETE FROM telegram_pending_disambiguation WHERE chat_id = ?", ["42"])).toBe(true);
    expect(historyHas(db, "DELETE FROM telegram_pending_alerts WHERE chat_id = ?", ["42"])).toBe(true);
    expect(historyHas(db, "DELETE FROM telegram_alert_job_targets WHERE chat_id = ?", ["42"])).toBe(true);
    expect(historyHas(db, "DELETE FROM telegram_alert_dead_letters WHERE chat_id = ?", ["42"])).toBe(true);
    expect(historyHas(db, "DELETE FROM telegram_chat_delivery_diagnostics WHERE chat_id = ?", ["42"])).toBe(true);
    expect(historyHas(db, "DELETE FROM telegram_subscribers WHERE chat_id = ?", ["42"])).toBe(true);
    expect(historyHas(db, "DELETE FROM cache WHERE key = ?", ["telegram:mini-app-mutation-burst:42"])).toBe(false);
    // processed_updates intentionally retained for idempotency.
    expect(db.getHistory().some((entry) => entry.sql.includes("DELETE FROM telegram_processed_updates"))).toBe(false);
  });

  it("applies the same mutation burst budget to destructive operation kinds", async () => {
    const initData = await privateInitData();
    const burstKey = "telegram:mini-app-mutation-burst:42";
    const db = mockD1([
      {
        match: "INSERT INTO cache (key, value, updated_at)",
        matchBinds: [burstKey, NOW_SEC, NOW_SEC - 30, NOW_SEC - 30, NOW_SEC - 30, 12],
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "SELECT updated_at FROM cache WHERE key = ?",
        matchBinds: [burstKey],
        rows: [{ updated_at: NOW_SEC - 29 }],
      },
    ]);

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "forget-me" },
    }), BOT_TOKEN);

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "rate-limited", retryAfterSec: 1 });
  });

  it("attaches a non-null latencyBucket to failed mutation analytics rows", async () => {
    // T-64: failed mutations also carry latency telemetry. With fake timers
    // `Date.now() - start === 0`, which buckets to "lt_250ms".
    const initData = await privateInitData();
    const db = mockD1();

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-coin-snooze", stablecoinId: "not-a-coin", durationToken: "1h" },
    }), BOT_TOKEN);

    expect(response.status).toBe(400);
    const deniedRows = db
      .getHistory()
      .filter((entry) =>
        entry.sql.includes("INSERT INTO telegram_usage_daily")
        && entry.binds.includes("mini_app_mutation_denied"),
      );
    expect(deniedRows).toHaveLength(1);
    expect(deniedRows[0].binds[5]).toBe("lt_250ms");
  });

  it("attaches stable error codes to each known-error response", async () => {
    // Configuration error: missing bot token.
    const notConfigured = await handleTelegramMiniAppMutation(
      mockD1(),
      request("/api/telegram-mini-app/mutate", { initData: "x", operation: { kind: "clear-snooze" } }),
      undefined,
    );
    expect(notConfigured.status).toBe(503);
    expect(await notConfigured.json()).toMatchObject({ code: "not-configured" });

    // Oversized body: 413 body-too-large.
    const oversize = new Request("https://api.pharos.watch/api/telegram-mini-app/mutate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(20 * 1024) },
      body: JSON.stringify({ initData: "x", operation: { kind: "clear-snooze" } }),
    });
    const oversizeResponse = await handleTelegramMiniAppMutation(mockD1(), oversize, BOT_TOKEN);
    expect(oversizeResponse.status).toBe(413);
    expect(await oversizeResponse.json()).toMatchObject({ code: "body-too-large" });

    // Stale auth: 5-minute boundary.
    const staleInitData = await signedInitData({
      auth_date: String(NOW_SEC - 301),
      chat_type: "private",
      user: JSON.stringify({ id: 42 }),
    });
    const staleResponse = await handleTelegramMiniAppMutation(
      mockD1(),
      request("/api/telegram-mini-app/mutate", { initData: staleInitData, operation: { kind: "clear-snooze" } }),
      BOT_TOKEN,
    );
    expect(staleResponse.status).toBe(401);
    expect(await staleResponse.json()).toMatchObject({ code: "stale-auth" });

    // Validation error: strict-mode unknown field.
    const validInitData = await privateInitData();
    const validationResponse = await handleTelegramMiniAppMutation(
      mockD1(),
      request("/api/telegram-mini-app/mutate", { initData: validInitData, operation: { kind: "clear-snooze", evil: 1 } }),
      BOT_TOKEN,
    );
    expect(validationResponse.status).toBe(400);
    expect(await validationResponse.json()).toMatchObject({ code: "validation-error" });

    // Group chat: 403 not-private.
    const groupInitData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      chat_type: "group",
      user: JSON.stringify({ id: 42 }),
    });
    const groupResponse = await handleTelegramMiniAppMutation(
      mockD1(),
      request("/api/telegram-mini-app/mutate", { initData: groupInitData, operation: { kind: "clear-snooze" } }),
      BOT_TOKEN,
    );
    expect(groupResponse.status).toBe(403);
    expect(await groupResponse.json()).toMatchObject({ code: "not-private" });

    // Fresh auth remains reusable within the same Mini App launch.
    const reusableInitData = await privateInitData();
    const reusableDb = mockD1(stateReadTables());
    const reusableResponse = await handleTelegramMiniAppMutation(
      reusableDb,
      request("/api/telegram-mini-app/mutate", { initData: reusableInitData, operation: { kind: "clear-snooze" } }),
      BOT_TOKEN,
    );
    expect(reusableResponse.status).toBe(200);
  });
});

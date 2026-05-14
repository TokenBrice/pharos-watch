import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1, type MockD1Database, type MockTableConfig } from "./helpers/mock-d1";

const { handleTelegramMiniAppMutation, handleTelegramMiniAppSession } = await import("../telegram-mini-app");

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

async function signedInitData(fields: Record<string, string>): Promise<string> {
  const params = new URLSearchParams(fields);
  const check = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");
  const secret = await hmacSha256(encoder.encode("WebAppData"), BOT_TOKEN);
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
  return [
    {
      match: "FROM telegram_subscribers",
      first: overrides.subscriber ?? {
        global_alert_dews: 0,
        global_alert_depeg: 0,
        global_alert_safety: 0,
        global_alert_launch: 0,
        global_depeg_worsening_bps_step: null,
        quiet_hours_enabled: 0,
        quiet_hours_start_utc: null,
        quiet_hours_end_utc: null,
        timezone: null,
        alert_snooze_until_ts: null,
      },
      rows: [],
    },
    { match: "FROM telegram_subscriptions", rows: overrides.subscriptions ?? [] },
    { match: "FROM telegram_preset_subscriptions", rows: overrides.presets ?? [] },
    { match: "FROM telegram_chat_delivery_diagnostics", first: null, rows: [] },
    { match: "FROM telegram_pending_alerts", first: { queued_alerts: 0 }, rows: [] },
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
});

describe("handleTelegramMiniAppSession", () => {
  it("returns private-chat state", async () => {
    const initData = await privateInitData();
    const db = mockD1([
      ...stateReadTables({
        subscriber: { global_alert_dews: 1, global_alert_depeg: 0, global_alert_safety: 0, global_alert_launch: 0, global_depeg_worsening_bps_step: 250, quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null, timezone: null, alert_snooze_until_ts: null },
        subscriptions: [{ stablecoin_id: "usdc-circle", alert_dews: 1, alert_depeg: 1, alert_safety: 0, alert_launch: 0, dews_min_band: "ALERT", safety_mode: null, depeg_worsening_bps_step: 250, alert_snooze_until_ts: null }],
      }),
    ]);

    const response = await handleTelegramMiniAppSession(db, request("/api/telegram-mini-app/session", { initData }), BOT_TOKEN);
    const body = await response.json() as {
      viewer: { canMutate: boolean; chatId: string | null };
      subscriber: { exists: boolean; snoozeUntilTs: number | null };
      subscriptions: Array<{ stablecoinId: string; symbol: string; alertTypes: { dews: boolean; depeg: boolean } }>;
      catalog: { searchableCoins: Array<{ stablecoinId: string }> };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.viewer.canMutate).toBe(true);
    expect(body.viewer.chatId).toBe("42");
    expect(body.subscriber.exists).toBe(true);
    expect(body.subscriber.snoozeUntilTs).toBeNull();
    expect(body.subscriptions[0]).toMatchObject({ stablecoinId: "usdc-circle", symbol: "USDC", alertTypes: { dews: true, depeg: true } });
    expect(body.catalog.searchableCoins.length).toBeGreaterThan(0);
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
});

describe("handleTelegramMiniAppMutation", () => {
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
    expect(historyHas(db, "UPDATE telegram_subscribers SET last_active_at = ? WHERE chat_id = ?", ["42"])).toBe(true);
  });

  it("writes recommended setup preset and subscription rows", async () => {
    const initData = await privateInitData();
    const db = mockD1([stablecoinsCacheTable(), ...stateReadTables()]);

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "recommended-setup", presetId: "usd-top25", alertTypes: ["dews", "depeg"] },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(historyHas(db, "INSERT INTO telegram_subscriptions", ["42", "usdt-tether", 1, 1])).toBe(true);
    expect(historyHas(db, "INSERT INTO telegram_preset_subscriptions", ["42", "usd-top25", 1, 1, 0])).toBe(true);
  });

  it("follows and unfollows presets through exact preset tables", async () => {
    const initData = await privateInitData();
    const followDb = mockD1([stablecoinsCacheTable(), ...stateReadTables()]);
    const followResponse = await handleTelegramMiniAppMutation(followDb, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "follow-preset", presetId: "usd-top10", alertTypes: { dews: true, depeg: true }, depegStepBps: 250 },
    }), BOT_TOKEN);

    expect(followResponse.status).toBe(200);
    expect(historyHas(followDb, "INSERT INTO telegram_subscriptions", ["42", "usdt-tether", 1, 1, 0, 0, 250])).toBe(true);
    expect(historyHas(followDb, "INSERT INTO telegram_preset_subscriptions", ["42", "usd-top10", 1, 1, 0, 250])).toBe(true);

    const unfollowDb = mockD1([stablecoinsCacheTable(), ...stateReadTables()]);
    const unfollowResponse = await handleTelegramMiniAppMutation(unfollowDb, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "unfollow-preset", presetId: "usd-top10" },
    }), BOT_TOKEN);

    expect(unfollowResponse.status).toBe(200);
    expect(historyHas(unfollowDb, "DELETE FROM telegram_subscriptions", ["42", "usdt-tether"])).toBe(true);
    expect(historyHas(unfollowDb, "DELETE FROM telegram_preset_subscriptions", ["42", "usd-top10"])).toBe(true);
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
    expect(historyHas(db, "ON CONFLICT(key) DO NOTHING", [])).toBe(true);
  });

  it("rejects replayed mutation initData before applying the mutation", async () => {
    const initData = await privateInitData();
    const db = mockD1([
      {
        match: "ON CONFLICT(key) DO UPDATE SET",
        rows: [],
        runMeta: { changes: 1 },
      },
      {
        match: "DELETE FROM cache WHERE key LIKE ?",
        rows: [],
        runMeta: { changes: 1 },
      },
      {
        match: "ON CONFLICT(key) DO NOTHING",
        rows: [],
        runMeta: { changes: 0 },
      },
    ]);

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "clear-snooze" },
    }), BOT_TOKEN);

    expect(response.status).toBe(409);
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("alert_snooze_until_ts = NULL"))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("DELETE FROM cache WHERE key LIKE ?"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("ON CONFLICT(key) DO NOTHING"))).toBe(true);
  });

  it("rejects stale mutation auth", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 901),
      chat_type: "private",
      user: JSON.stringify({ id: 42 }),
    });
    const response = await handleTelegramMiniAppMutation(mockD1(), request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "clear-snooze" },
    }), BOT_TOKEN);
    expect(response.status).toBe(401);
  });
});

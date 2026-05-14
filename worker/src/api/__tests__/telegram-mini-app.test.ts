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
    (db as { batch: D1Database["batch"] }).batch = async (statements) => {
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
    expect(batchSizes).toHaveLength(1);
    expect(batchSizes[0]).toBeGreaterThan(1);
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

  it("shares the mutation cooldown across operation kinds", async () => {
    const initData = await privateInitData();
    const cooldownKey = "telegram:command-cooldown:42:mini-app:mutation:any";
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

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "remove-coin", stablecoinId: "usdc-circle" },
    }), BOT_TOKEN);

    expect(response.status).toBe(429);
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
  });

  it("rejects empty set-coin patches", async () => {
    const initData = await privateInitData();
    const db = mockD1();

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-coin", stablecoinId: "usdc-circle", patch: {} },
    }), BOT_TOKEN);

    expect(response.status).toBe(400);
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
    const deleteAttempts = db.getHistory().filter((entry) =>
      entry.sql.includes("DELETE FROM cache WHERE key = ?")
      && entry.binds.some((bind) => typeof bind === "string" && bind.startsWith("telegram-mini-app:mutation-init:")));
    expect(deleteAttempts.length).toBeGreaterThan(0);
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
    // T-19: previously routed via clearSnoozeViaSettings; now flows through the
    // store helper. The discriminator is the literal `alert_snooze_until_ts = NULL`
    // SET clause written by `clearAlertSnooze` (telegram-webhook-store.ts:933).
    const initData = await privateInitData();
    const db = mockD1(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "clear-snooze" },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    // Both clearAlertSnooze and the prior settings helper use the same SQL
    // shape; the discriminator here is that the call still goes through and
    // writes the NULL clause. The seam compliance is enforced at the import
    // level (telegram-mini-app-mutations.ts imports clearAlertSnooze, not
    // clearSnoozeViaSettings).
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

  it("snoozes a single coin via set-coin-snooze and clears via the clear token", async () => {
    const initData = await privateInitData();
    const setDb = mockD1(stateReadTables());

    const setResponse = await handleTelegramMiniAppMutation(setDb, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-coin-snooze", stablecoinId: "usdc-circle", durationToken: "1h" },
    }), BOT_TOKEN);

    expect(setResponse.status).toBe(200);
    expect(historyHas(setDb, "INSERT INTO telegram_subscriptions", ["42", "usdc-circle", NOW_SEC + 3600])).toBe(true);

    const clearDb = mockD1(stateReadTables());
    const clearResponse = await handleTelegramMiniAppMutation(clearDb, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-coin-snooze", stablecoinId: "usdc-circle", durationToken: "clear" },
    }), BOT_TOKEN);

    expect(clearResponse.status).toBe(200);
    expect(historyHas(clearDb, "INSERT INTO telegram_subscriptions", ["42", "usdc-circle", null])).toBe(true);
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
    expect(historyHas(db, "DELETE FROM telegram_chat_delivery_diagnostics WHERE chat_id = ?", ["42"])).toBe(true);
    expect(historyHas(db, "DELETE FROM telegram_subscribers WHERE chat_id = ?", ["42"])).toBe(true);
    // processed_updates intentionally retained for idempotency.
    expect(db.getHistory().some((entry) => entry.sql.includes("DELETE FROM telegram_processed_updates"))).toBe(false);
  });

  it("shares the mini-app:mutation:any cooldown across new operation kinds", async () => {
    const initData = await privateInitData();
    const cooldownKey = "telegram:command-cooldown:42:mini-app:mutation:any";
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

    const response = await handleTelegramMiniAppMutation(db, request("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "forget-me" },
    }), BOT_TOKEN);

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "rate-limited" });
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

    // Replay claimed: stub the claim INSERT to return changes=0.
    const replayInitData = await privateInitData();
    const replayDb = mockD1([
      { match: "ON CONFLICT(key) DO NOTHING", rows: [], runMeta: { changes: 0 } },
    ]);
    const replayResponse = await handleTelegramMiniAppMutation(
      replayDb,
      request("/api/telegram-mini-app/mutate", { initData: replayInitData, operation: { kind: "clear-snooze" } }),
      BOT_TOKEN,
    );
    expect(replayResponse.status).toBe(409);
    expect(await replayResponse.json()).toMatchObject({ code: "replay-claimed" });
  });
});

import { readJsonResponse } from "../../../test-helpers/__shared/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOT_TOKEN,
  NOW_SEC,
  historyMatches,
  makeMiniAppDb,
  makeMiniAppRequest,
  makeStreamedMiniAppRequest,
  makeVersionedMiniAppRequest,
  privateInitData,
  signedInitData,
  stateReadTables,
} from "./telegram-mini-app.test-support.ts";
import {
  TELEGRAM_MINI_APP_CATALOG_VERSION,
  TELEGRAM_MINI_APP_CONTRACT_VERSION,
  TelegramMiniAppSnapshotSchema,
} from "@shared/lib/telegram-mini-app-contract";

const { handleTelegramMiniAppMutation, handleTelegramMiniAppSession } = await import("../telegram-mini-app");

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
    const versionedDb = makeMiniAppDb(stateReadTables());
    const legacyDb = makeMiniAppDb(stateReadTables());

    const compactResponse = await handleTelegramMiniAppSession(
      versionedDb,
      makeVersionedMiniAppRequest("/api/telegram-mini-app/session", { initData }),
      BOT_TOKEN,
    );
    const compactText = await compactResponse.text();
    const compact = TelegramMiniAppSnapshotSchema.parse(JSON.parse(compactText));

    const legacyResponse = await handleTelegramMiniAppSession(
      legacyDb,
      makeMiniAppRequest("/api/telegram-mini-app/session", { initData }),
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
    const db = makeMiniAppDb();
    const response = await handleTelegramMiniAppSession(
      db,
      makeVersionedMiniAppRequest("/api/telegram-mini-app/session", { initData: "not-signed" }, {
        catalogVersion: "catalog-v0-stale",
      }),
      BOT_TOKEN,
    );

    expect(await readJsonResponse(response, 409)).toMatchObject({
      code: "catalog-version-mismatch",
      contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION,
      catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
    });
    expect(db.getHistory()).toEqual([]);
  });

  it("returns private-chat state", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb([
      ...stateReadTables({
        subscriber: { global_alert_dews: 1, global_alert_depeg: 0, global_alert_safety: 0, global_alert_launch: 0, global_depeg_worsening_bps_step: 250, quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null, timezone: null, alert_snooze_until_ts: null },
        subscriptions: [{ stablecoin_id: "usdc-circle", alert_dews: 1, alert_depeg: 1, alert_safety: 0, alert_launch: 0, alert_dews_override: 1, alert_depeg_override: 1, dews_min_band: "ALERT", safety_mode: null, depeg_worsening_bps_step: 250, alert_snooze_until_ts: null }],
      }),
    ]);

    const response = await handleTelegramMiniAppSession(db, makeMiniAppRequest("/api/telegram-mini-app/session", { initData }), BOT_TOKEN);
    const body = await response.json() as {
      viewer: { canMutate: boolean; chatId: string | null };
      subscriber: {
        exists: boolean;
        snoozeUntilTs: number | null;
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
    expect(body.subscriber).not.toHaveProperty("recap");
    expect(body.subscriptions[0]).toMatchObject({
      stablecoinId: "usdc-circle",
      symbol: "USDC",
      alertTypes: { dews: true, depeg: true },
      alertOverrides: { dews: true, depeg: true },
    });
    expect(body.catalog.searchableCoins.length).toBeGreaterThan(0);
  });

  it("reports followed-group membership as unknown, never empty, when the market-cap cache is unreadable", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb([
      ...stateReadTables({
        presets: [{ preset_id: "usd-top25", alert_dews: 1, alert_depeg: 1, alert_safety: 0, depeg_worsening_bps_step: null }],
      }),
    ]);

    const response = await handleTelegramMiniAppSession(db, makeMiniAppRequest("/api/telegram-mini-app/session", { initData }), BOT_TOKEN);
    const body = await response.json() as { presets: Array<{ id: string; memberIds: string[] | null }> };

    expect(response.status).toBe(200);
    expect(body.presets).toEqual([expect.objectContaining({ id: "usd-top25", memberIds: null })]);
  });


  it("hides inert rows but keeps marker-backed local-off and snooze-only rows", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb([
      ...stateReadTables({
        subscriptions: [
          { stablecoin_id: "usdt-tether", alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0, dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null, alert_snooze_until_ts: null },
          { stablecoin_id: "pyusd-paypal", alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0, alert_dews_override: 1, dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null, alert_snooze_until_ts: null },
          { stablecoin_id: "usdc-circle", alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0, dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null, alert_snooze_until_ts: NOW_SEC + 3600 },
          { stablecoin_id: "eurc-circle", alert_dews: 1, alert_depeg: 0, alert_safety: 0, alert_launch: 0, dews_min_band: "ALERT", safety_mode: null, depeg_worsening_bps_step: null, alert_snooze_until_ts: null },
        ],
      }),
    ]);

    const response = await handleTelegramMiniAppSession(db, makeMiniAppRequest("/api/telegram-mini-app/session", { initData }), BOT_TOKEN);
    const body = await readJsonResponse(response, 200) as {
      subscriptions: Array<{ stablecoinId: string; snoozeUntilTs: number | null; alertOverrides: { dews: boolean } }>;
    };

    expect(body.subscriptions.map((row) => row.stablecoinId)).toEqual(["pyusd-paypal", "usdc-circle", "eurc-circle"]);
    expect(body.subscriptions[0]).toMatchObject({ stablecoinId: "pyusd-paypal", alertOverrides: { dews: true } });
    expect(body.subscriptions[1]).toMatchObject({ stablecoinId: "usdc-circle", snoozeUntilTs: NOW_SEC + 3600 });
  });

  it("keeps stale-but-valid sessions read-only", async () => {
    const initData = await privateInitData(3_600);
    const db = makeMiniAppDb(stateReadTables());

    const response = await handleTelegramMiniAppSession(db, makeMiniAppRequest("/api/telegram-mini-app/session", { initData }), BOT_TOKEN);
    const body = await readJsonResponse(response, 200) as { viewer: { canMutate: boolean; mutationBlockReason: string | null } };

    expect(body.viewer.canMutate).toBe(false);
    expect(body.viewer.mutationBlockReason).toBe("stale-auth");
  });

  it("marks group launches read-only", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      chat_type: "supergroup",
      user: JSON.stringify({ id: 42, username: "alice" }),
    });
    const db = makeMiniAppDb();

    const response = await handleTelegramMiniAppSession(db, makeMiniAppRequest("/api/telegram-mini-app/session", { initData }), BOT_TOKEN);
    const body = await readJsonResponse(response, 200) as { viewer: { canMutate: boolean; mutationBlockReason: string } };

    expect(body.viewer.canMutate).toBe(false);
    expect(body.viewer.mutationBlockReason).toBe("not-private");
  });

  it("treats direct-link sender launches as mutable private-chat state", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      chat_type: "sender",
      user: JSON.stringify({ id: 42, username: "alice" }),
    });
    const db = makeMiniAppDb(stateReadTables());

    const response = await handleTelegramMiniAppSession(db, makeMiniAppRequest("/api/telegram-mini-app/session", { initData }), BOT_TOKEN);
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
    const db = makeMiniAppDb(stateReadTables());

    const response = await handleTelegramMiniAppSession(
      db,
      makeMiniAppRequest("/api/telegram-mini-app/session", { initData }),
      BOT_TOKEN,
      previousToken,
    );
    const body = await readJsonResponse(response, 200) as { viewer: { chatId: string | null; canMutate: boolean } };

    expect(body.viewer.chatId).toBe("42");
    expect(body.viewer.canMutate).toBe(true);
  });

  it("marks channel launches read-only without loading channel-scoped rows", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      chat_type: "channel",
      user: JSON.stringify({ id: 42, username: "alice" }),
    });
    const db = makeMiniAppDb();

    const response = await handleTelegramMiniAppSession(db, makeMiniAppRequest("/api/telegram-mini-app/session", { initData }), BOT_TOKEN);
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
    const db = makeMiniAppDb([
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

    const response = await handleTelegramMiniAppSession(db, makeMiniAppRequest("/api/telegram-mini-app/session", { initData }), BOT_TOKEN);

    expect(await readJsonResponse(response, 429)).toMatchObject({ error: "Mini App session rate limited" });
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

  it("rejects oversized session bodies with 413 before parsing JSON", async () => {
    const db = makeMiniAppDb();
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
    const db = makeMiniAppDb();
    const req = new Request("https://api.pharos.watch/api/telegram-mini-app/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    const response = await handleTelegramMiniAppSession(db, req, BOT_TOKEN);

    expect(await readJsonResponse(response, 400)).toMatchObject({ code: "validation-error" });
    expect(db.getHistory()).toHaveLength(0);
  });

  it("rejects oversized streamed session bodies without relying on Content-Length", async () => {
    const db = makeMiniAppDb();
    const req = makeStreamedMiniAppRequest("/api/telegram-mini-app/session", [
      "{\"initData\":\"",
      "x".repeat(17 * 1024),
      "\"}",
    ]);

    const response = await handleTelegramMiniAppSession(db, req, BOT_TOKEN);

    expect(await readJsonResponse(response, 413)).toMatchObject({ code: "body-too-large" });
    // No state SELECT, cooldown INSERT, HMAC validation, or analytics write fires pre-auth.
    expect(db.getHistory()).toHaveLength(0);
  });

  it("rejects lying-small Content-Length session streams through the bounded reader", async () => {
    const db = makeMiniAppDb();
    const req = makeStreamedMiniAppRequest(
      "/api/telegram-mini-app/session",
      [
        "{\"initData\":\"",
        "x".repeat(17 * 1024),
        "\"}",
      ],
      { "Content-Length": "12" },
    );

    const response = await handleTelegramMiniAppSession(db, req, BOT_TOKEN);

    expect(await readJsonResponse(response, 413)).toMatchObject({ code: "body-too-large" });
    expect(db.getHistory()).toHaveLength(0);
  });

  it("rejects malformed hash with 401 without HMAC compute", async () => {
    const initData = new URLSearchParams({
      auth_date: String(NOW_SEC - 60),
      hash: "0".repeat(63),
      user: JSON.stringify({ id: 42 }),
    }).toString();
    const db = makeMiniAppDb();

    const response = await handleTelegramMiniAppSession(db, makeMiniAppRequest("/api/telegram-mini-app/session", { initData }), BOT_TOKEN);

    expect(response.status).toBe(401);
    expect(db.getHistory()).toHaveLength(0);
  });

  it("rejects oversized initData via schema before HMAC compute", async () => {
    const initData = "auth_date=1&hash=" + "a".repeat(64) + "&user=" + encodeURIComponent(JSON.stringify({ id: 42 }));
    const padded = initData + "&padding=" + "x".repeat(8 * 1024);
    const db = makeMiniAppDb();

    const response = await handleTelegramMiniAppSession(db, makeMiniAppRequest("/api/telegram-mini-app/session", { initData: padded }), BOT_TOKEN);

    expect(response.status).toBe(400);
    // Schema-validation failures happen before HMAC and must not write analytics.
    expect(db.getHistory()).toHaveLength(0);
  });

  it("rejects an unsigned start_param body override", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb(stateReadTables());

    const response = await handleTelegramMiniAppSession(db, makeMiniAppRequest("/api/telegram-mini-app/session", {
      initData,
      startParam: "evil",
    }), BOT_TOKEN);

    expect(response.status).toBe(400);
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
    const staleDb = makeMiniAppDb();
    const staleResponse = await handleTelegramMiniAppSession(
      staleDb,
      makeMiniAppRequest("/api/telegram-mini-app/session", { initData: staleInitData }),
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
    const invalidDb = makeMiniAppDb();
    const invalidResponse = await handleTelegramMiniAppSession(
      invalidDb,
      makeMiniAppRequest("/api/telegram-mini-app/session", { initData: invalidInitData }),
      BOT_TOKEN,
    );
    expect(invalidResponse.status).toBe(401);
    expect(invalidDb.getHistory()).toHaveLength(0);
  });

  it("records stale auth telemetry once per expired initData and still returns stale-auth on retry", async () => {
    const staleInitData = await signedInitData({
      auth_date: String(NOW_SEC - 301),
      chat_type: "private",
      user: JSON.stringify({ id: 42, username: "alice" }),
    });
    const hashPrefix = new URLSearchParams(staleInitData).get("hash")!.slice(0, 16);
    const cooldownKey = `telegram:command-cooldown:42:mini-app:stale:mini_app_mutation_denied:${hashPrefix}`;
    const db = makeMiniAppDb([
      {
        match: "INSERT INTO cache (key, value, updated_at)",
        matchBinds: [cooldownKey, "1", NOW_SEC, NOW_SEC - 7 * 24 * 60 * 60],
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
      makeMiniAppRequest("/api/telegram-mini-app/mutate", { initData: staleInitData, operation: { kind: "clear-snooze" } }),
      BOT_TOKEN,
    );

    // F6: a retry inside the dedupe window must keep the relaunch path, not 429.
    expect(await readJsonResponse(response, 401)).toMatchObject({ code: "stale-auth" });
    expect(historyMatches(db, "INSERT INTO cache (key, value, updated_at)", { 0: cooldownKey })).toBe(true);
    expect(historyMatches(db, "INSERT INTO telegram_usage_daily", {1:"mini_app_mutation_denied"})).toBe(false);
  });

  it("returns 401 stale-auth even when the telemetry dedupe write fails", async () => {
    const staleInitData = await signedInitData({
      auth_date: String(NOW_SEC - 301),
      chat_type: "private",
      user: JSON.stringify({ id: 42, username: "alice" }),
    });
    const hashPrefix = new URLSearchParams(staleInitData).get("hash")!.slice(0, 16);
    const cooldownKey = `telegram:command-cooldown:42:mini-app:stale:mini_app_mutation_denied:${hashPrefix}`;
    const db = makeMiniAppDb([
      {
        // The stale-auth telemetry dedupe is a best-effort cache write; a
        // transient D1 failure must not replace the auth verdict.
        match: "INSERT INTO cache (key, value, updated_at)",
        matchBinds: [cooldownKey, "1", NOW_SEC, NOW_SEC - 7 * 24 * 60 * 60],
        rows: [],
        throwError: new Error("D1 DB is overloaded. Requests queued for too long."),
      },
    ]);

    const response = await handleTelegramMiniAppMutation(
      db,
      makeMiniAppRequest("/api/telegram-mini-app/mutate", { initData: staleInitData, operation: { kind: "clear-snooze" } }),
      BOT_TOKEN,
    );

    expect(await readJsonResponse(response, 401)).toMatchObject({ code: "stale-auth" });
  });

  it("does not interpret retired recap launch tokens as an action", async () => {
    const initData = await privateInitData(60, "recap_watchlist");
    const db = makeMiniAppDb(stateReadTables());

    const response = await handleTelegramMiniAppSession(
      db,
      makeMiniAppRequest("/api/telegram-mini-app/session", { initData }),
      BOT_TOKEN,
    );

    expect(response.status).toBe(200);
    const row = db.getHistory().find((entry) =>
      entry.sql.includes("INSERT INTO telegram_usage_daily")
      && entry.binds.includes("mini_app_session_valid"));
    expect(row?.binds).not.toContain("recap_view_watchlist");
    expect(row?.binds).not.toContain("42");
    expect(row?.binds).not.toContain("alice");
  });
});

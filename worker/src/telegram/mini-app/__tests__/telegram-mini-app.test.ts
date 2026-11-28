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
  TelegramMiniAppContextResponseSchema,
  TelegramMiniAppSnapshotSchema,
} from "@shared/lib/telegram-mini-app-contract";
import { STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { WORKER_ACTIVE_STABLECOINS, WORKER_PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins/worker-runtime-registry";
import { buildDewsStablecoinIdsDigest, DEWS_PUBLICATION_POINTER_CACHE_KEY } from "../../../lib/dews-publication-pointer";
import * as safetyScoreIndex from "../../../lib/safety-score-index";
import { createMiniAppSqlite } from "../../webhook/__tests__/telegram-sqlite.test-support.ts";

const { handleTelegramMiniAppMutation, handleTelegramMiniAppSession } = await import("../telegram-mini-app");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_SEC * 1000);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SESSION_PATH = "/api/telegram-mini-app/session";
type SessionDb = Parameters<typeof handleTelegramMiniAppSession>[0];

function postSession(db: SessionDb, body: unknown, botTokenPrevious?: string, execCtx?: ExecutionContext): Promise<Response> {
  return handleTelegramMiniAppSession(db, makeMiniAppRequest(SESSION_PATH, body), BOT_TOKEN, botTokenPrevious, execCtx);
}

function postVersionedSession(db: SessionDb, body: unknown, versions?: { contractVersion?: string; catalogVersion?: string }): Promise<Response> {
  return handleTelegramMiniAppSession(db, makeVersionedMiniAppRequest(SESSION_PATH, body, versions), BOT_TOKEN);
}

function chatInitData(chatType: string, ageSec = 60, token?: string): Promise<string> {
  return signedInitData({ auth_date: String(NOW_SEC - ageSec), chat_type: chatType, user: JSON.stringify({ id: 42, username: "alice" }) }, token);
}

function unsignedInitData(hash: string, user: Record<string, unknown> = { id: 42, username: "alice" }): string {
  return new URLSearchParams({ auth_date: String(NOW_SEC - 60), hash, user: JSON.stringify(user) }).toString();
}

function usageRows(db: ReturnType<typeof makeMiniAppDb>, eventType: string) {
  return db.getHistory().filter((entry) => entry.sql.includes("INSERT INTO telegram_usage_daily") && entry.binds.includes(eventType));
}

function cooldownTables(cooldownKey: string, windowStartSec: number) {
  return [
    { match: "INSERT INTO cache (key, value, updated_at)", matchBinds: [cooldownKey, "1", NOW_SEC, windowStartSec], rows: [], runMeta: { changes: 0 } },
    { match: "SELECT updated_at FROM cache WHERE key = ?", matchBinds: [cooldownKey], rows: [{ updated_at: NOW_SEC - 1 }] },
  ];
}

async function staleMutationCooldown(): Promise<{ initData: string; cooldownKey: string }> {
  const initData = await chatInitData("private", 301);
  const hashPrefix = new URLSearchParams(initData).get("hash")!.slice(0, 16);
  return { initData, cooldownKey: `telegram:command-cooldown:42:mini-app:stale:mini_app_mutation_denied:${hashPrefix}` };
}

async function postContext(db: SessionDb, initData: string, contextRequest: unknown) {
  return TelegramMiniAppContextResponseSchema.parse(await readJsonResponse(await postVersionedSession(db, { initData, contextRequest }), 200)).context;
}

async function postCoinsContext(db: SessionDb, initData: string, stablecoinIds: string[]) {
  const context = await postContext(db, initData, { kind: "coins", stablecoinIds });
  if (context.kind !== "coins") throw new Error("Expected coins");
  return context;
}

type MiniAppSqlite = ReturnType<typeof createMiniAppSqlite>["sqlite"];

function usdAsset(id: string, symbol: string, name: string, price: number, circulating: number, observedAgoSec = 30) {
  return { id, symbol, name, pegType: "peggedUSD", price, priceSource: "coingecko", priceObservedAt: NOW_SEC - observedAgoSec, circulating: { peggedUSD: circulating } };
}

function seedStablecoins(sqlite: MiniAppSqlite, peggedAssets: object[], updatedAgoSec = 30): void {
  sqlite.prepare("UPDATE cache SET value = ?, updated_at = ? WHERE key = 'stablecoins'").run(JSON.stringify({ peggedAssets }), NOW_SEC - updatedAgoSec);
}

function seedCensus(sqlite: MiniAppSqlite, count: number): void {
  sqlite.prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status, item_count, metadata) VALUES ('sync-stablecoins', ?, 1000, 'ok', 150, ?)").run(NOW_SEC - 30, JSON.stringify({
    cacheWriteMode: "published",
    capabilities: { depegPipeline: true },
    quality: { depegObservation: { scope: "psi-non-nav-before-supply-floor", evaluatedAt: NOW_SEC - 30, eligibleCount: count, observedCount: count, unavailableCount: 0, belowFloorCount: 0, reasonCounts: {} } },
  }));
}

function insertDepeg(sqlite: MiniAppSqlite, id: string, symbol: string, peakBps: number, startedAt: number, price: number): void {
  sqlite.prepare("INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peak_price, peg_reference, source) VALUES (?, ?, 'peggedUSD', 'below', ?, ?, ?, ?, 1, 'live')").run(id, symbol, peakBps, startedAt, price, price);
}

function mockSafetyIndex(kind: "v9" | "held", publicationGenerationId: string, expectedCount: number, cards: object[]): void {
  vi.spyOn(safetyScoreIndex, "loadActiveSafetyScoreIndex").mockResolvedValue({
    kind,
    ...(kind === "held" ? { reason: "v9-publication-held", detail: "held" } : {}),
    snapshot: {
      lifecycle: "active",
      safetyScoreIdentity: { publicationGenerationId, methodologyVersion: "9.0" } as never,
      methodology: { version: "9.0" },
      asOfSec: NOW_SEC - 60,
      updatedAt: NOW_SEC - 60,
      publicationHealth: {} as never,
      completeness: { expectedCount },
      cards: cards as never,
    },
  } as never);
}

describe("handleTelegramMiniAppSession", () => {
  it("returns a compact versioned snapshot while legacy clients retain the full catalog", async () => {
    const initData = await privateInitData();
    const compactResponse = await postVersionedSession(makeMiniAppDb(stateReadTables()), { initData });
    const compactText = await compactResponse.text();
    const compact = TelegramMiniAppSnapshotSchema.parse(JSON.parse(compactText));
    const legacyText = await (await postSession(makeMiniAppDb(stateReadTables()), { initData })).text();
    const legacy = JSON.parse(legacyText) as {
      viewer?: Record<string, unknown>;
      catalog?: { searchableCoins?: unknown[] };
    };

    expect(compactResponse.status).toBe(200);
    expect(compact).toMatchObject({
      contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION,
      catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
      serverNowSec: NOW_SEC,
      stateRevision: expect.stringMatching(/^state-v1-/),
    });
    expect(compact.state.viewer.mutationAuthExpiresAt).toBe(NOW_SEC - 60 + 301);
    expect(compact.state.directStateProof).toEqual({
      preferenceGeneration: 0,
      directFingerprint: expect.stringMatching(/^direct-v1-[0-9]+-[0-9a-f]{8}$/),
    });
    expect(compact).not.toHaveProperty("catalog");
    expect(compact.state).not.toHaveProperty("catalog");
    expect(legacy).not.toHaveProperty("serverNowSec");
    expect(legacy).not.toHaveProperty("directStateProof");
    expect(legacy.viewer).not.toHaveProperty("mutationAuthExpiresAt");
    expect(legacy.catalog?.searchableCoins?.length).toBeGreaterThan(300);
    expect(compactText.length).toBeLessThan(legacyText.length / 10);
  });

  it("rejects version skew before auth, cooldown, or analytics writes", async () => {
    const db = makeMiniAppDb();
    expect(await readJsonResponse(await postVersionedSession(db, { initData: "not-signed" }, { catalogVersion: "catalog-v0-stale" }), 409)).toMatchObject({
      code: "catalog-version-mismatch",
      contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION,
      catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
    });
    expect(db.getHistory()).toEqual([]);
  });

  it("returns private-chat state", async () => {
    const db = makeMiniAppDb(stateReadTables({
      subscriber: { global_alert_dews: 1, global_alert_depeg: 0, global_alert_safety: 0, global_alert_launch: 0, global_depeg_worsening_bps_step: 250, quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null, timezone: null, alert_snooze_until_ts: null },
      subscriptions: [{ stablecoin_id: "usdc-circle", alert_dews: 1, alert_depeg: 1, alert_safety: 0, alert_launch: 0, alert_dews_override: 1, alert_depeg_override: 1, dews_min_band: "ALERT", safety_mode: null, depeg_worsening_bps_step: 250, alert_snooze_until_ts: null }],
    }));

    const response = await postSession(db, { initData: await privateInitData() });
    const body = await readJsonResponse<{ subscriber: object; catalog: { searchableCoins: unknown[] } }>(response, 200);

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toMatchObject({
      viewer: { canMutate: true, chatId: "42" },
      subscriber: { exists: true, snoozeUntilTs: null },
    });
    expect(body.subscriber).not.toHaveProperty("recap");
    expect(body).toHaveProperty("subscriptions.0", expect.objectContaining({
      stablecoinId: "usdc-circle",
      symbol: "USDC",
      alertTypes: expect.objectContaining({ dews: true, depeg: true }),
      alertOverrides: expect.objectContaining({ dews: true, depeg: true }),
    }));
    expect(body.catalog.searchableCoins.length).toBeGreaterThan(0);
  });

  it.each([
    ["available when the chat has no diagnostics row", undefined, true],
    ["unavailable when the diagnostics read fails", { match: "FROM telegram_chat_delivery_diagnostics", error: new Error("diagnostics unavailable") }, false],
  ] as const)("publishes health diagnostics as %s", async (_case, failOn, diagnosticsAvailable) => {
    const db = makeMiniAppDb(stateReadTables(), failOn ? { failOn } : undefined);
    expect(await readJsonResponse(await postSession(db, { initData: await privateInitData() }), 200)).toMatchObject({
      health: { diagnosticsAvailable, lastSuccessfulDeliveryAt: null, lastSuccessfulReplyAt: null },
    });
  });

  it("reports followed-group membership as unknown, never empty, when the market-cap cache is unreadable", async () => {
    const db = makeMiniAppDb(stateReadTables({
      presets: [{ preset_id: "usd-top25", alert_dews: 1, alert_depeg: 1, alert_safety: 0, depeg_worsening_bps_step: null }],
    }));
    const body = await readJsonResponse<{ presets: unknown[] }>(await postSession(db, { initData: await privateInitData() }), 200);
    expect(body.presets).toEqual([expect.objectContaining({ id: "usd-top25", memberIds: null })]);
  });

  it("hides inert rows but keeps marker-backed local-off and snooze-only rows", async () => {
    const inert = { alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0, dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null, alert_snooze_until_ts: null };
    const db = makeMiniAppDb(stateReadTables({
      subscriptions: [
        { ...inert, stablecoin_id: "usdt-tether" },
        { ...inert, stablecoin_id: "pyusd-paypal", alert_dews_override: 1 },
        { ...inert, stablecoin_id: "usdc-circle", alert_snooze_until_ts: NOW_SEC + 3600 },
        { ...inert, stablecoin_id: "eurc-circle", alert_dews: 1, dews_min_band: "ALERT" },
      ],
    }));
    const body = await readJsonResponse<{ subscriptions: Array<{ stablecoinId: string }> }>(await postSession(db, { initData: await privateInitData() }), 200);

    expect(body.subscriptions.map((row) => row.stablecoinId)).toEqual(["pyusd-paypal", "usdc-circle", "eurc-circle"]);
    expect(body.subscriptions[0]).toMatchObject({ stablecoinId: "pyusd-paypal", alertOverrides: { dews: true } });
    expect(body.subscriptions[1]).toMatchObject({ stablecoinId: "usdc-circle", snoozeUntilTs: NOW_SEC + 3600 });
  });

  it("keeps stale-but-valid sessions read-only", async () => {
    const body = await readJsonResponse(await postSession(makeMiniAppDb(stateReadTables()), { initData: await privateInitData(3_600) }), 200);
    expect(body).toMatchObject({ viewer: { canMutate: false, mutationBlockReason: "stale-auth" } });
  });

  it("marks group launches read-only", async () => {
    const initData = await chatInitData("supergroup");
    expect(await readJsonResponse(await postSession(makeMiniAppDb(), { initData }), 200)).toMatchObject({
      viewer: { canMutate: false, mutationBlockReason: "not-private" },
    });
    const v10Group = TelegramMiniAppSnapshotSchema.parse(await readJsonResponse(await postVersionedSession(makeMiniAppDb(), { initData }), 200));
    expect(v10Group.state.viewer.mutationAuthExpiresAt).toBeNull();
    expect(v10Group.state.directStateProof).toBeNull();
  });

  it.each([
    ["treats direct-link sender launches as mutable private-chat state", "sender", { chatId: "42", chatType: "sender", canMutate: true, mutationBlockReason: null }],
    ["marks channel launches read-only without loading channel-scoped rows", "channel", { chatId: null, chatType: "channel", canMutate: false, mutationBlockReason: "not-private" }],
  ] as const)("%s", async (_name, chatType, viewer) => {
    const db = makeMiniAppDb(chatType === "sender" ? stateReadTables() : []);
    expect(await readJsonResponse(await postSession(db, { initData: await chatInitData(chatType) }), 200)).toMatchObject({ viewer });
    if (chatType === "channel") expect(db.getHistory().some((entry) => entry.sql.includes("FROM telegram_subscribers"))).toBe(false);
  });

  it("validates session initData with the previous bot token during rotation overlap", async () => {
    const previousToken = "previous-bot-token";
    const initData = await chatInitData("private", 60, previousToken);
    expect(await readJsonResponse(await postSession(makeMiniAppDb(stateReadTables()), { initData }, previousToken), 200)).toMatchObject({
      viewer: { chatId: "42", canMutate: true },
    });
  });

  it("rate-limits repeated session opens after successful auth", async () => {
    const db = makeMiniAppDb(cooldownTables("telegram:command-cooldown:42:mini-app:session", NOW_SEC - 2));

    expect(await readJsonResponse(await postSession(db, { initData: await privateInitData() }), 429)).toMatchObject({ error: "Mini App session rate limited" });
    // P1.3: cooldown denials must emit `mini_app_session_invalid` with the
    // `rate_limited` failure class so abuse signals are visible on dashboards.
    const deniedRows = usageRows(db, "mini_app_session_invalid");
    expect(deniedRows).toHaveLength(1);
    expect(deniedRows[0].binds).toContain("rate_limited");
  });

  it("rejects oversized session bodies with 413 before parsing JSON", async () => {
    const db = makeMiniAppDb();
    const req = new Request(`https://api.pharos.watch${SESSION_PATH}`, {
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
    const req = new Request(`https://api.pharos.watch${SESSION_PATH}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    expect(await readJsonResponse(await handleTelegramMiniAppSession(db, req, BOT_TOKEN), 400)).toMatchObject({ code: "validation-error" });
    expect(db.getHistory()).toHaveLength(0);
  });

  it.each([
    ["without relying on Content-Length", {}],
    ["with a lying-small Content-Length through the bounded reader", { "Content-Length": "12" }],
  ])("rejects oversized streamed session bodies %s", async (_case, headers) => {
    const db = makeMiniAppDb();
    const req = makeStreamedMiniAppRequest(SESSION_PATH, ["{\"initData\":\"", "x".repeat(17 * 1024), "\"}"], headers);
    expect(await readJsonResponse(await handleTelegramMiniAppSession(db, req, BOT_TOKEN), 413)).toMatchObject({ code: "body-too-large" });
    // No state SELECT, cooldown INSERT, HMAC validation, or analytics write fires pre-auth.
    expect(db.getHistory()).toHaveLength(0);
  });

  it("rejects malformed hash with 401 and oversized initData via schema with 400, both before HMAC compute", async () => {
    const malformedDb = makeMiniAppDb();
    expect((await postSession(malformedDb, { initData: unsignedInitData("0".repeat(63), { id: 42 }) })).status).toBe(401);
    expect(malformedDb.getHistory()).toHaveLength(0);

    const oversizedDb = makeMiniAppDb();
    const initData = "auth_date=1&hash=" + "a".repeat(64) + "&user=" + encodeURIComponent(JSON.stringify({ id: 42 }));
    expect((await postSession(oversizedDb, { initData: initData + "&padding=" + "x".repeat(8 * 1024) })).status).toBe(400);
    // Schema-validation failures happen before HMAC and must not write analytics.
    expect(oversizedDb.getHistory()).toHaveLength(0);
  });

  it("rejects an unsigned start_param body override", async () => {
    const response = await postSession(makeMiniAppDb(stateReadTables()), { initData: await privateInitData(), startParam: "evil" });
    expect(response.status).toBe(400);
  });

  it("emits mini_app_session_invalid on stale auth but not on invalid signature", async () => {
    // T-63: stale-auth has already passed the HMAC check, so emitting a
    // usage event does not create an unauthenticated-write gate. Invalid
    // signature stays silent.
    // 24h session window + 1s gives stale-auth from the session handler.
    const staleDb = makeMiniAppDb();
    expect((await postSession(staleDb, { initData: await chatInitData("private", 24 * 60 * 60 + 1) })).status).toBe(401);
    const staleInvalidRows = usageRows(staleDb, "mini_app_session_invalid");
    expect(staleInvalidRows).toHaveLength(1);
    expect(staleInvalidRows[0].binds).toContain("stale-auth");

    // Invalid signature: zero-byte hash. Must not write any analytics row.
    const invalidDb = makeMiniAppDb();
    expect((await postSession(invalidDb, { initData: unsignedInitData("0".repeat(64)) })).status).toBe(401);
    expect(invalidDb.getHistory()).toHaveLength(0);
  });

  it("records stale auth telemetry once per expired initData and still returns stale-auth on retry", async () => {
    const { initData, cooldownKey } = await staleMutationCooldown();
    const db = makeMiniAppDb(cooldownTables(cooldownKey, NOW_SEC - 7 * 24 * 60 * 60));

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", { initData, operation: { kind: "clear-snooze" } }), BOT_TOKEN);

    // F6: a retry inside the dedupe window must keep the relaunch path, not 429.
    expect(await readJsonResponse(response, 401)).toMatchObject({ code: "stale-auth" });
    expect(historyMatches(db, "INSERT INTO cache (key, value, updated_at)", { 0: cooldownKey })).toBe(true);
    expect(historyMatches(db, "INSERT INTO telegram_usage_daily", {1:"mini_app_mutation_denied"})).toBe(false);
  });

  it("returns 401 stale-auth even when the telemetry dedupe write fails", async () => {
    const { initData, cooldownKey } = await staleMutationCooldown();
    const db = makeMiniAppDb([{
      // The stale-auth telemetry dedupe is a best-effort cache write; a
      // transient D1 failure must not replace the auth verdict.
      match: "INSERT INTO cache (key, value, updated_at)",
      matchBinds: [cooldownKey, "1", NOW_SEC, NOW_SEC - 7 * 24 * 60 * 60],
      rows: [],
      throwError: new Error("D1 DB is overloaded. Requests queued for too long."),
    }]);

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", { initData, operation: { kind: "clear-snooze" } }), BOT_TOKEN);

    expect(await readJsonResponse(response, 401)).toMatchObject({ code: "stale-auth" });
  });

  it("does not interpret retired recap launch tokens as an action", async () => {
    const db = makeMiniAppDb(stateReadTables());
    expect((await postSession(db, { initData: await privateInitData(60, "recap_watchlist") })).status).toBe(200);
    const row = usageRows(db, "mini_app_session_valid")[0];
    expect(row?.binds).not.toContain("recap_view_watchlist");
    expect(row?.binds).not.toContain("42");
    expect(row?.binds).not.toContain("alice");
  });

  it("offloads post-auth session telemetry to execCtx.waitUntil without invoking it pre-auth", async () => {
    const initData = await privateInitData();
    const waitUntilPromises: Promise<unknown>[] = [];
    const execCtx = {
      waitUntil: vi.fn((promise: Promise<unknown>) => { waitUntilPromises.push(promise); }),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    expect((await postSession(makeMiniAppDb(), { initData: "auth_date=1&hash=" + "0".repeat(64) }, undefined, execCtx)).status).toBe(401);
    expect(execCtx.waitUntil).not.toHaveBeenCalled();

    const db = makeMiniAppDb(stateReadTables());
    expect((await postSession(db, { initData }, undefined, execCtx)).status).toBe(200);
    expect(execCtx.waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(waitUntilPromises);
    expect(historyMatches(db, "INSERT INTO telegram_usage_daily", { 1: "mini_app_session_valid" })).toBe(true);
  });

  it("enforces v10 negotiation, private-chat boundary, and coin allowlist on scoped contextRequest", async () => {
    const initData = await privateInitData();
    const groupInit = await signedInitData({ auth_date: String(NOW_SEC - 60), chat_type: "supergroup", user: JSON.stringify({ id: 42 }) });
    for (const [request, status, code, extra] of [
      [makeMiniAppRequest(SESSION_PATH, { initData, contextRequest: { kind: "presets" } }), 409, "contract-version-mismatch", { contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION }],
      [makeVersionedMiniAppRequest(SESSION_PATH, { initData, contextRequest: { kind: "presets" } }, { contractVersion: "9" }), 409, "contract-version-mismatch", {}],
      [makeVersionedMiniAppRequest(SESSION_PATH, { initData: groupInit, contextRequest: { kind: "coins", stablecoinIds: ["usdc-circle"] } }), 403, "not-private", {}],
    ] as const) {
      const db = makeMiniAppDb();
      expect(await readJsonResponse(await handleTelegramMiniAppSession(db, request, BOT_TOKEN), status)).toMatchObject({ code, ...extra });
      expect(db.getHistory()).toEqual([]);
    }
    expect(await readJsonResponse(
      await postVersionedSession(makeMiniAppDb(), { initData, contextRequest: { kind: "coins", stablecoinIds: ["removed-from-registry"] } }),
      400,
    )).toMatchObject({ code: "unknown-coin" });
  });

  it("serves scoped coins and presets context with R1-R8 provenance, independent 1s cooldown, and zero duplicate session telemetry", async () => {
    const { db, sqlite } = createMiniAppSqlite();
    try {
      const initData = await privateInitData();
      seedStablecoins(sqlite, [
        usdAsset("usdt-tether", "USDT", "Tether", 0.9999, 2_000_000_000),
        usdAsset("usdc-circle", "USDC", "USD Coin", 0.9871, 1_000_000_000),
        usdAsset("dai-makerdao", "DAI", "Dai", -5, 500_000_000),
      ].map(({ pegType: _legacyRowsOmitPegType, ...asset }) => asset));
      seedCensus(sqlite, 3);
      insertDepeg(sqlite, "usdc-circle", "USDC", -150, NOW_SEC - 600, 0.985);
      const dewsIds = ["usdc-circle", "usdt-tether"];
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
        DEWS_PUBLICATION_POINTER_CACHE_KEY,
        JSON.stringify({
          updatedAt: NOW_SEC - 60,
          source: "compute-dews",
          publishStatus: "published",
          coverageVersion: 2,
          expectedRowCount: dewsIds.length,
          stablecoinIdsDigest: buildDewsStablecoinIdsDigest(dewsIds),
        }),
        NOW_SEC - 60,
      );
      const insertPubDews = sqlite.prepare("INSERT INTO stress_signal_publication_rows (stablecoin_id, computed_at, score, band, signals_json) VALUES (?, ?, ?, ?, '{}')");
      insertPubDews.run("usdc-circle", NOW_SEC - 60, 68, "WARNING");
      insertPubDews.run("usdt-tether", NOW_SEC - 60, 12, "CALM");
      // Older row in stress_signals_latest must NEVER be served for an exact v2 pointer.
      sqlite.prepare("INSERT INTO stress_signals_latest (stablecoin_id, score, band, signals_json, computed_at, updated_at) VALUES ('dai-makerdao', 80, 'DANGER', '{}', ?, ?)").run(NOW_SEC - 300, NOW_SEC - 300);
      mockSafetyIndex("v9", "v9-gen-1", 3, [
        {
          id: "usdc-circle", ratingStatus: "rated", grade: "A-", score: 86,
          partialEvidence: { reasonCode: "partial-evidence-pipeline-gap", excludedPillars: ["exit"], causes: ["A"] },
        },
        { id: "usdt-tether", ratingStatus: "not-rated", grade: "NR", score: null, partialEvidence: null },
        // Malformed rated card gets quarantined per-asset without failing the rest.
        { id: "dai-makerdao", ratingStatus: "rated", grade: "B", score: 999, partialEvidence: null },
      ]);

      // Normal session open followed immediately by context request succeeds (independent cooldown buckets).
      expect((await postVersionedSession(db, { initData })).status).toBe(200);
      const coins = await postCoinsContext(db, initData, ["usdc-circle", "usdt-tether", "dai-makerdao"]);
      expect(coins.activeDepegs.provenance.status).toBe("ok");
      expect(coins.activeDepegs.events).toEqual([expect.objectContaining({
        stablecoinId: "usdc-circle", direction: "below", peakDeviationBps: -150, currentDeviationBps: -129, currentDirection: "below", priceUsd: 0.9871,
      })]);
      expect(coins.coinSignals["usdc-circle"]).toMatchObject({
        price: { provenance: { status: "ok", budgetSec: STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC }, priceUsd: 0.9871 },
        dews: { provenance: { status: "ok" }, band: "WARNING", score: 68 },
        safety: { provenance: { status: "ok" }, ratingStatus: "rated", grade: "A-", score: 86, held: false, partialEvidence: true },
        pegStatus: "off-peg",
      });
      expect(coins.coinSignals["usdt-tether"]).toMatchObject({
        safety: { partialEvidence: false },
        pegStatus: "on-peg",
      });
      // Per-asset quarantine: DAI bad price, missing DEWS (no stale fallback), and invalid safety card become unavailable while USDC/USDT remain ok.
      expect(coins.coinSignals["dai-makerdao"]).toMatchObject({
        price: { provenance: { status: "unavailable", reason: "price-missing" } },
        dews: { provenance: { status: "unavailable", reason: "dews-unobserved" } },
        safety: { provenance: { status: "unavailable", reason: "safety-card-invalid" }, held: false },
        pegStatus: "unavailable",
      });
      // Only the initial session open wrote `mini_app_session_valid`, not the context read.
      expect(sqlite.prepare("SELECT count FROM telegram_usage_daily WHERE event_type = 'mini_app_session_valid'").get()).toEqual({ count: 1 });

      // Immediate back-to-back context call hits the 1s `mini-app:context` cooldown.
      expect(await readJsonResponse(await postVersionedSession(db, { initData, contextRequest: { kind: "presets" } }), 429)).toMatchObject({ code: "rate-limited" });

      // After cooldown, presets returns exact memberCount + max 3 topSymbols.
      vi.setSystemTime((NOW_SEC + 2) * 1000);
      expect(await postContext(db, initData, { kind: "presets" })).toMatchObject({
        kind: "presets",
        provenance: { status: "ok", budgetSec: STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC },
        presets: expect.arrayContaining([
          expect.objectContaining({ id: "usd-top25", memberCount: 3, topSymbols: ["USDT", "USDC", "DAI"] }),
        ]),
      });

      // Missing cache + missing cron output yields explicit unavailable provenance (never fabricated zeros or "on-peg").
      vi.restoreAllMocks();
      sqlite.prepare("DELETE FROM cache WHERE key IN ('stablecoins', ?)").run(DEWS_PUBLICATION_POINTER_CACHE_KEY);
      sqlite.prepare("DELETE FROM cron_runs").run();
      vi.setSystemTime((NOW_SEC + 4) * 1000);
      expect(await postContext(db, initData, { kind: "presets" })).toMatchObject({ kind: "presets", provenance: { status: "unavailable", reason: expect.any(String) }, presets: [] });

      vi.setSystemTime((NOW_SEC + 6) * 1000);
      const unavailable = await postCoinsContext(db, initData, ["usdt-tether"]);
      expect(unavailable.activeDepegs.provenance).toMatchObject({ status: "unavailable", reason: "depeg-producer-history-missing" });
      expect(unavailable.coinSignals["usdt-tether"]).toMatchObject({
        price: { provenance: { status: "unavailable" } },
        dews: { provenance: { status: "unavailable", reason: "dews-publication-missing" } },
        safety: { provenance: { status: "unavailable" } },
        pegStatus: "unavailable",
      });
    } finally {
      sqlite.close();
    }
  });

  it("enforces pegStatus/quarantine, non-USD latest freshness, scoped DEWS errors, and held-without-card guard", async () => {
    const { db, sqlite } = createMiniAppSqlite();
    try {
      const initData = await privateInitData();
      const nav = WORKER_ACTIVE_STABLECOINS.find((c) => c.navToken || c.flags.navToken)!;
      const pre = WORKER_PRE_LAUNCH_STABLECOINS[0]!;
      const eurc = (price: number, extra: Record<string, unknown> = {}) => ({ ...usdAsset("eurc-circle", "EURC", "EURC", price, 0), pegType: "peggedEUR", circulating: { peggedEUR: 1e8 }, ...extra });
      seedStablecoins(sqlite, [
        usdAsset("usdt-tether", "USDT", "Tether", 1, 2e9),
        eurc(1.08),
        usdAsset("dai-makerdao", "DAI", "Dai", 1, 5e8),
        usdAsset(nav.id, nav.symbol, nav.name, 1.15, 5e8),
      ]);
      seedCensus(sqlite, 4);
      insertDepeg(sqlite, "dai-makerdao", "DAI", -200, -1, 0.98);
      sqlite.prepare("INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peak_price, peg_reference, source, peer_basis_json) VALUES ('eurc-circle', 'EURC', 'peggedEUR', 'below', -180, ?, 1.05, 1.05, 1.08, 'live', ?)").run(
        NOW_SEC - 4_000, JSON.stringify({ latest: { basis: "native-peg", observedAt: NOW_SEC - STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC - 10, price: 1.06, pegReference: 1.08, bps: -185 } }),
      );
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
        DEWS_PUBLICATION_POINTER_CACHE_KEY, JSON.stringify({ updatedAt: NOW_SEC + 300, source: "compute-dews", publishStatus: "published" }), NOW_SEC + 300,
      );
      mockSafetyIndex("held", "v9-held-1", 2, [
        { id: "usdt-tether", ratingStatus: "rated", grade: "B+", score: 78, partialEvidence: null },
        { id: "dai-makerdao", ratingStatus: "rated", grade: "A", score: 150, partialEvidence: null },
      ]);

      const first = await postCoinsContext(db, initData, ["usdt-tether", "dai-makerdao", "eurc-circle", nav.id, pre.id]);
      expect(first.activeDepegs).toMatchObject({ provenance: { status: "ok" }, events: [expect.objectContaining({ stablecoinId: "eurc-circle", currentDeviationBps: null, currentDirection: null })] });
      expect(first.coinSignals["usdt-tether"]).toMatchObject({ pegStatus: "on-peg", dews: { provenance: { status: "unavailable", reason: "payload updatedAt is in the future" } }, safety: { held: true, partialEvidence: false } });
      expect(first.coinSignals["dai-makerdao"]).toMatchObject({ pegStatus: "unavailable", safety: { provenance: { status: "unavailable", reason: "safety-card-invalid" }, held: false } });
      expect(first.coinSignals["eurc-circle"]?.pegStatus).toBe("off-peg");
      expect(first.coinSignals[nav.id]?.pegStatus).toBe("not-monitored");
      expect(first.coinSignals[pre.id]).toMatchObject({ pegStatus: "not-monitored", safety: { provenance: { status: "unavailable", reason: "safety-card-missing" }, held: false } });

      sqlite.prepare("UPDATE depeg_events SET peer_basis_json = ? WHERE stablecoin_id = 'eurc-circle'").run(JSON.stringify({
        latest: { basis: "native-peg", observedAt: NOW_SEC - 20, price: 1.095, pegReference: 1.08, bps: 138.6 },
      }));
      sqlite.prepare("UPDATE cache SET value = ?, updated_at = ? WHERE key = ?").run(
        JSON.stringify({ updatedAt: NOW_SEC - 60, source: "compute-dews", publishStatus: "published" }), NOW_SEC - 60, DEWS_PUBLICATION_POINTER_CACHE_KEY,
      );
      sqlite.prepare("INSERT INTO stress_signals_latest (stablecoin_id, score, band, signals_json, computed_at, updated_at) VALUES ('usdt-tether', 25, 'CALM', '{}', ?, ?), ('eurc-circle', 70, 'WARNING', '{}', ?, ?)").run(NOW_SEC - 60, NOW_SEC - 60, NOW_SEC - 120, NOW_SEC - 120);
      vi.setSystemTime((NOW_SEC + 2) * 1000);
      const second = await postCoinsContext(db, initData, ["usdt-tether", "eurc-circle"]);
      expect(second.activeDepegs.events).toEqual([expect.objectContaining({ stablecoinId: "eurc-circle", direction: "below", currentDeviationBps: 139, currentDirection: "above" })]);
      expect(second.coinSignals["usdt-tether"]?.dews).toMatchObject({ provenance: { status: "ok" }, band: "CALM", score: 25 });
      expect(second.coinSignals["eurc-circle"]?.dews.provenance).toMatchObject({ status: "unavailable", reason: "dews-unobserved" });

      // Sub-$1M floor, $0.90 unlogged quote, unavailable FX, null priceObservedAt, malformed priceSource, and degraded depegPipeline never certify on-peg.
      sqlite.prepare("DELETE FROM depeg_events").run();
      seedStablecoins(sqlite, [
        usdAsset("usdc-circle", "USDC", "USD Coin", 0.90, 2e9, 20),
        { ...usdAsset("usdt-tether", "USDT", "Tether", 1.0, 2e9), priceObservedAt: null, priceUpdatedAt: NOW_SEC - 20 },
        usdAsset("dai-makerdao", "DAI", "Dai", 0.90, 500_000, 20),
        eurc(1.08, { priceObservedAt: NOW_SEC - 20, currentPeg: { pegReferenceUnavailable: true } }),
        { ...usdAsset("pyusd-paypal", "PYUSD", "PayPal USD", 1.0, 5e8, 20), priceSource: { bad: true } },
      ], 20);
      vi.setSystemTime((NOW_SEC + 4) * 1000);
      const third = await postCoinsContext(db, initData, ["usdc-circle", "usdt-tether", "dai-makerdao", "eurc-circle", "pyusd-paypal"]);
      expect(third.coinSignals["usdc-circle"]?.pegStatus).toBe("unavailable");
      expect(third.coinSignals["usdt-tether"]).toMatchObject({ price: { provenance: { status: "unavailable", reason: "price-clock-invalid" } }, pegStatus: "unavailable" });
      expect(third.coinSignals["dai-makerdao"]?.pegStatus).toBe("not-monitored");
      expect(third.coinSignals["eurc-circle"]?.pegStatus).toBe("unavailable");
      expect(third.coinSignals["pyusd-paypal"]).toMatchObject({ price: { provenance: { status: "unavailable", reason: "price-source-invalid" } }, pegStatus: "unavailable" });

      sqlite.prepare("DELETE FROM cron_runs").run();
      sqlite.prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status, item_count, metadata) VALUES ('sync-stablecoins', ?, 1000, 'degraded', 150, '{\"cacheWriteMode\":\"published\",\"capabilities\":{\"depegPipeline\":false}}')").run(NOW_SEC - 10);
      insertDepeg(sqlite, "usdc-circle", "USDC", -200, NOW_SEC - 600, 0.98);
      vi.setSystemTime((NOW_SEC + 6) * 1000);
      const degraded = await postCoinsContext(db, initData, ["usdc-circle"]);
      expect(degraded.activeDepegs).toMatchObject({ provenance: { status: "unavailable", reason: "depeg-pipeline-unavailable" }, events: [] });
      expect(degraded.coinSignals["usdc-circle"]?.pegStatus).toBe("unavailable");
    } finally {
      sqlite.close();
    }
  });
});

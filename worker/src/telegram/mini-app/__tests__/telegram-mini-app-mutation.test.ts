import { readJsonResponse } from "../../../test-helpers/__shared/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { SqliteD1Options } from "@shared/test-utils/sqlite-d1";
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
import { PAUSE_SENTINEL_TS } from "@shared/lib/telegram-delivery-policy";
import { FROZEN_STABLECOINS } from "@shared/lib/stablecoins/registry";
import {
  TELEGRAM_MINI_APP_CATALOG_VERSION,
  TELEGRAM_MINI_APP_CONTRACT_VERSION,
  TelegramMiniAppSnapshotSchema,
} from "@shared/lib/telegram-mini-app-contract";
import { createMiniAppSqlite } from "../../webhook/__tests__/telegram-sqlite.test-support.ts";
import { isQuietHoursActive } from "../../common/quiet-hours";
import { handleTelegramMiniAppMutation, handleTelegramMiniAppSession } from "../telegram-mini-app";

const MUTATE_PATH = "/api/telegram-mini-app/mutate";
const sqliteFixtures: Array<{ sqlite: DatabaseSync; db: D1Database }> = [];

function persistedDb(options: SqliteD1Options = {}) {
  const fixture = createMiniAppSqlite(options);
  sqliteFixtures.push(fixture);
  return fixture;
}

async function postMutate(
  db: D1Database,
  operation: object,
  opts: {
    initData?: string;
    versioned?: boolean;
    contractVersion?: string;
    botToken?: string | undefined;
    previousBotToken?: string;
    execCtx?: ExecutionContext;
  } = {},
) {
  const initData = opts.initData ?? (await privateInitData());
  const req = opts.versioned || opts.contractVersion
    ? makeVersionedMiniAppRequest(MUTATE_PATH, { initData, operation }, opts.contractVersion ? { contractVersion: opts.contractVersion } : undefined)
    : makeMiniAppRequest(MUTATE_PATH, { initData, operation });
  const token = "botToken" in opts ? opts.botToken : BOT_TOKEN;
  return handleTelegramMiniAppMutation(db, req, token, opts.previousBotToken, opts.execCtx);
}

function seedPreset(sqlite: DatabaseSync, dews: number, depeg: number, safety: number, step: number | null, ts = NOW_SEC) {
  sqlite.prepare(`
    INSERT INTO telegram_preset_subscriptions
      (chat_id, preset_id, alert_dews, alert_depeg, alert_safety, depeg_worsening_bps_step, created_at, updated_at)
    VALUES ('42', 'usd-top10', ?, ?, ?, ?, ?, ?)
  `).run(dews, depeg, safety, step, ts, ts);
}

const hasBurstKey = (db: ReturnType<typeof makeMiniAppDb>, prefix = "telegram:mini-app-mutation-burst:") =>
  db.getHistory().some((e) => e.binds.some((v) => typeof v === "string" && v.startsWith(prefix)));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_SEC * 1000);
});

afterEach(() => {
  for (const { sqlite } of sqliteFixtures.splice(0)) sqlite.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("handleTelegramMiniAppMutation", () => {
  it.each([
    { kind: "set-global", alertType: "depeg", enabled: true },
    { kind: "set-global-depeg-step", depegStepBps: 250 },
    { kind: "set-coin", stablecoinId: "usdc-circle", patch: { dewsMinBand: null } },
    { kind: "follow-preset", presetId: "usd-top10", alertTypes: { dews: true } },
  ])("records one attributed first follow for $kind", async (operation) => {
    const { db, sqlite } = persistedDb();
    sqlite.prepare("DELETE FROM telegram_preset_subscriptions").run();
    sqlite.prepare("DELETE FROM telegram_subscriptions").run();
    sqlite.prepare(`UPDATE telegram_subscribers SET first_follow_at = NULL,
      global_alert_dews = 0, global_alert_depeg = 0, global_alert_safety = 0,
      global_alert_launch = 0, global_alert_reserve = 0, global_alert_freeze = 0`).run();
    const initData = await privateInitData(60, "pw1_landing_miniapp_home");
    for (let i = 0; i < 2; i += 1) {
      expect((await postMutate(db, operation, { initData })).status).toBe(200);
    }
    expect(sqlite.prepare("SELECT first_follow_at FROM telegram_subscribers WHERE chat_id = '42'").get())
      .toEqual({ first_follow_at: NOW_SEC });
  });

  it("does not claim a first follow for an off-only coin patch", async () => {
    const { db, sqlite } = persistedDb();
    const res = await postMutate(db, { kind: "set-coin", stablecoinId: "usdc-circle", patch: { alertTypes: { dews: false } } });
    expect(res.status).toBe(200);
    expect(sqlite.prepare("SELECT first_follow_at FROM telegram_subscribers WHERE chat_id = '42'").get()).toEqual({ first_follow_at: null });
  });

  it.each(["5", "6"])("rejects retired contract %s before database access", async (contractVersion) => {
    const db = makeMiniAppDb();
    const res = await handleTelegramMiniAppSession(
      db, makeVersionedMiniAppRequest("/api/telegram-mini-app/session", { initData: await privateInitData() }, { contractVersion }), BOT_TOKEN,
    );
    expect(await readJsonResponse(res, 409)).toMatchObject({ code: "contract-version-mismatch", contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION });
    expect(db.getHistory()).toEqual([]);
  });

  it.each([
    { family: "dews", expected: { dews: false, depeg: true, safety: true } },
    { family: "safety", expected: { dews: true, depeg: true, safety: false } },
  ])("turns preset $family Off without changing other families or the depeg step", async ({ family, expected }) => {
    const { db, sqlite } = persistedDb();
    seedPreset(sqlite, 1, 1, 1, 250);
    const res = await postMutate(db, { kind: "follow-preset", presetId: "usd-top10", alertTypes: { [family]: false } }, { versioned: true });
    expect(res.status).toBe(200);
    expect(TelegramMiniAppSnapshotSchema.parse(await res.json()).state.presets[0]).toMatchObject({ alertTypes: expected, depegStepBps: 250 });
    expect(sqlite.prepare("SELECT alert_dews, alert_depeg, alert_safety, depeg_worsening_bps_step FROM telegram_preset_subscriptions").get()).toEqual({
      alert_dews: expected.dews ? 1 : 0, alert_depeg: 1, alert_safety: expected.safety ? 1 : 0, depeg_worsening_bps_step: 250,
    });
  });

  it.each([TELEGRAM_MINI_APP_CONTRACT_VERSION])("persists preset Off with absent families unchanged for contract %s", async (contractVersion) => {
    const { db, sqlite } = persistedDb();
    seedPreset(sqlite, 1, 1, 1, 250, NOW_SEC - 60);
    sqlite.prepare("INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_dews, dews_min_band) VALUES ('42', 'usdc-circle', 1, 'DANGER')").run();
    const directBefore = sqlite.prepare("SELECT * FROM telegram_subscriptions").all();
    const genBefore = (sqlite.prepare("SELECT preference_generation FROM telegram_subscribers WHERE chat_id = '42'").get() as { preference_generation: number }).preference_generation;
    const res = await postMutate(db, { kind: "follow-preset", presetId: "usd-top10", alertTypes: { depeg: false }, depegStepBps: 250 }, { contractVersion });
    expect(res.status).toBe(200);
    expect(TelegramMiniAppSnapshotSchema.parse(await res.json())).toMatchObject({
      contractVersion,
      state: { presets: [{ id: "usd-top10", alertTypes: { dews: true, depeg: false, safety: true }, depegStepBps: null }] },
    });
    expect(sqlite.prepare("SELECT alert_dews, alert_depeg, alert_safety, depeg_worsening_bps_step FROM telegram_preset_subscriptions WHERE chat_id = '42' AND preset_id = 'usd-top10'").get())
      .toEqual({ alert_dews: 1, alert_depeg: 0, alert_safety: 1, depeg_worsening_bps_step: null });
    expect(sqlite.prepare("SELECT * FROM telegram_subscriptions").all()).toEqual(directBefore);
    expect(sqlite.prepare("SELECT last_active_at, preference_generation FROM telegram_subscribers WHERE chat_id = '42'").get())
      .toEqual({ last_active_at: NOW_SEC, preference_generation: genBefore + 1 });
  });

  it.each([1, 0])("merges interleaved partial preset edits against the transaction row (depeg=%s)", async (depeg) => {
    const { db, sqlite } = persistedDb();
    seedPreset(sqlite, 1, depeg, 1, depeg ? 250 : null);
    const initData = await privateInitData();
    const batch = db.batch.bind(db);
    let interleaved = false;
    vi.spyOn(db, "batch").mockImplementation(async (statements) => {
      if (!interleaved) {
        interleaved = true;
        expect((await postMutate(db, { kind: "follow-preset", presetId: "usd-top10", alertTypes: { safety: false } }, { initData, versioned: true })).status).toBe(200);
      }
      return batch(statements);
    });
    const res = await postMutate(db, { kind: "follow-preset", presetId: "usd-top10", alertTypes: { dews: false } }, { initData, versioned: true });
    expect(interleaved).toBe(true);
    expect(res.status).toBe(depeg ? 200 : 400);
    expect(sqlite.prepare("SELECT alert_dews, alert_depeg, alert_safety, depeg_worsening_bps_step FROM telegram_preset_subscriptions WHERE chat_id = '42' AND preset_id = 'usd-top10'").get()).toEqual({
      alert_dews: depeg ? 0 : 1, alert_depeg: depeg, alert_safety: 0, depeg_worsening_bps_step: depeg ? 250 : null,
    });
  });

  it("rejects disabling the final followed-preset family without changing its intent", async () => {
    const { db, sqlite } = persistedDb();
    seedPreset(sqlite, 1, 0, 0, null);
    const before = sqlite.prepare("SELECT * FROM telegram_preset_subscriptions").all();
    const res = await postMutate(db, { kind: "follow-preset", presetId: "usd-top10", alertTypes: { dews: false } }, { versioned: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid-alert-types" });
    expect(sqlite.prepare("SELECT * FROM telegram_preset_subscriptions").all()).toEqual(before);
  });

  it("rejects a stale v5 bulk preview before mutation or telemetry", async () => {
    const { db, sqlite } = persistedDb();
    sqlite.prepare("INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_dews, alert_dews_override) VALUES ('42', 'usdc-circle', 1, 1)").run();
    const res = await postMutate(db, { kind: "preview-bulk-watchlist", addStablecoinIds: ["usdt-tether"], removeStablecoinIds: [] }, { contractVersion: "5" });
    expect(await readJsonResponse(res, 409)).toMatchObject({ code: "contract-version-mismatch" });
    expect(sqlite.prepare("SELECT count(*) AS count FROM telegram_usage_daily").get()).toEqual({ count: 0 });
  });

  it.each([
    { name: "snoozed", enabled: 1, override: 1, band: null, mode: null, step: null, snooze: NOW_SEC + 14_400 },
    { name: "snooze-only", enabled: 0, override: 0, band: null, mode: null, step: null, snooze: NOW_SEC + 14_400 },
    { name: "explicit-off", enabled: 0, override: 1, band: null, mode: null, step: null, snooze: null },
    { name: "tuned", enabled: 1, override: 1, band: "DANGER", mode: "downgrade-only", step: 250, snooze: NOW_SEC + 3_600 },
  ])("round-trips an exact $name row through signed remove and fenced undo", async (row) => {
    const { db, sqlite } = persistedDb();
    sqlite.prepare(`INSERT INTO telegram_subscriptions (
      chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_launch, alert_reserve, alert_freeze,
      alert_dews_override, alert_depeg_override, alert_safety_override, alert_launch_override, alert_reserve_override, alert_freeze_override,
      dews_min_band, safety_mode, depeg_worsening_bps_step, alert_snooze_until_ts
    ) VALUES ('42', 'usdc-circle', ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.enabled, row.enabled, row.enabled, row.override, row.override, row.override,
      row.override, row.override, row.override, row.band, row.mode, row.step, row.snooze,
    );
    const before = sqlite.prepare("SELECT * FROM telegram_subscriptions WHERE chat_id = '42'").all();
    const initData = await privateInitData();
    const removed = await postMutate(db, { kind: "remove-coin", stablecoinId: "usdc-circle" }, { initData, versioned: true });
    expect(removed.status).toBe(200);
    const snapshot = TelegramMiniAppSnapshotSchema.parse(await removed.json());
    expect(snapshot.state.subscriptions).toEqual([]);
    expect(sqlite.prepare("SELECT * FROM telegram_subscriptions WHERE chat_id = '42'").all()).toEqual([]);
    expect(snapshot.undo?.restoreDirectRows[0]?.snoozeUntilTs).toBe(row.snooze);
    const restored = await postMutate(db, { kind: "undo-bulk-watchlist", ...snapshot.undo }, { initData, versioned: true });
    expect(restored.status).toBe(200);
    expect(sqlite.prepare("SELECT * FROM telegram_subscriptions WHERE chat_id = '42'").all()).toEqual(before);
    expect(TelegramMiniAppSnapshotSchema.parse(await restored.json()).state.subscriptions[0]?.snoozeUntilTs).toBe(row.snooze);
  });

  it.each(["invalid-fingerprint", "concurrent-edit"] as const)("rejects %s undo without changing persisted preferences", async (scenario) => {
    const { db, sqlite } = persistedDb();
    sqlite.prepare("INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_dews, alert_dews_override) VALUES ('42', 'usdc-circle', 1, 1)").run();
    const initData = await privateInitData();
    const removed = await postMutate(db, { kind: "remove-coin", stablecoinId: "usdc-circle" }, { initData, versioned: true });
    expect(removed.status).toBe(200);
    const { undo } = TelegramMiniAppSnapshotSchema.parse(await removed.json());
    if (!undo) throw new Error("Missing server-derived undo");
    if (scenario === "concurrent-edit") {
      expect((await postMutate(db, { kind: "set-coin", stablecoinId: "usdc-circle", patch: { alertTypes: { safety: true }, safetyMode: "upgrade-only" } }, { initData, versioned: true })).status).toBe(200);
    } else {
      undo.expectedFingerprint = "preview-v1-1-deadbeef";
    }
    const beforeRows = sqlite.prepare("SELECT * FROM telegram_subscriptions WHERE chat_id = '42'").all();
    const beforePrefs = sqlite.prepare("SELECT * FROM telegram_subscribers WHERE chat_id = '42'").get();
    const rejected = await postMutate(db, { kind: "undo-bulk-watchlist", ...undo }, { initData, versioned: true });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ code: "stale-bulk-preview" });
    expect(sqlite.prepare("SELECT * FROM telegram_subscriptions WHERE chat_id = '42'").all()).toEqual(beforeRows);
    expect(sqlite.prepare("SELECT * FROM telegram_subscribers WHERE chat_id = '42'").get()).toEqual(beforePrefs);
  });

  it("returns only mutable state and revision for a routine versioned mutation", async () => {
    const res = await postMutate(makeMiniAppDb(stateReadTables()), { kind: "set-global", alertType: "safety", enabled: true }, { versioned: true });
    const text = await res.text();
    const body = TelegramMiniAppSnapshotSchema.parse(JSON.parse(text));
    expect(res.status).toBe(200);
    expect(body.stateRevision).toMatch(/^state-v1-/);
    expect(body).not.toHaveProperty("catalog");
    expect(body.state).not.toHaveProperty("catalog");
    expect(text.length).toBeLessThan(8 * 1024);
  });

  it("rejects version skew before burst admission, analytics, or mutation writes", async () => {
    const db = makeMiniAppDb();
    const res = await postMutate(db, { kind: "set-global", alertType: "safety", enabled: true }, { initData: "not-signed", contractVersion: "1" });
    expect(await readJsonResponse(res, 409)).toMatchObject({
      code: "contract-version-mismatch", contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION, catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
    });
    expect(db.getHistory()).toEqual([]);
  });

  it.each([true, false])("rejects retired recap mutations before any database access (enabled=%s)", async (enabled) => {
    const db = makeMiniAppDb();
    const res = await postMutate(db, { kind: "set-recap", enabled, deliveryHourLocal: 9 });
    expect(await readJsonResponse(res, 400)).toMatchObject({ code: "validation-error" });
    expect(db.getHistory()).toEqual([]);
  });

  it("routes a stale signed bulk preview through the read-only path without consuming burst capacity", async () => {
    const db = makeMiniAppDb(stateReadTables());
    const res = await postMutate(db, { kind: "preview-bulk-watchlist", addStablecoinIds: ["usdt-tether"], removeStablecoinIds: [] }, { initData: await privateInitData(60 * 60) });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ result: { kind: "bulk-watchlist-preview", adds: ["usdt-tether"], removes: [] } });
    expect(hasBurstKey(db)).toBe(false);
    expect(historyMatches(db, "INSERT INTO telegram_usage_daily", { 1: "mini_app_portability", 3: "bulk_watchlist_preview" })).toBe(true);
  });

  it("rate-limits repeated read-only bulk previews on their own 1s cooldown without colliding with session open", async () => {
    const cooldownKey = "telegram:command-cooldown:42:mini-app:bulk-preview";
    const db = makeMiniAppDb([
      { match: "INSERT INTO cache (key, value, updated_at)", matchBinds: [cooldownKey, "1", NOW_SEC, NOW_SEC - 1], rows: [], runMeta: { changes: 0 } },
      { match: "SELECT updated_at FROM cache WHERE key = ?", matchBinds: [cooldownKey], first: { updated_at: NOW_SEC }, rows: [{ updated_at: NOW_SEC }] },
    ]);
    const res = await postMutate(db, { kind: "preview-bulk-watchlist", addStablecoinIds: ["usdt-tether"], removeStablecoinIds: [] });
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toMatchObject({ code: "rate-limited", retryAfterSec: 1 });
    expect(historyMatches(db, "INSERT INTO telegram_usage_daily", { 1: "mini_app_portability", 3: "bulk_watchlist_preview", 4: "rate_limited" })).toBe(true);

    // Same-second session open + bulk preview use distinct cooldown keys and do not collide.
    const { db: liveDb } = persistedDb();
    const initData = await privateInitData();
    expect((await handleTelegramMiniAppSession(liveDb, makeMiniAppRequest("/api/telegram-mini-app/session", { initData }), BOT_TOKEN)).status).toBe(200);
    expect((await postMutate(liveDb, { kind: "preview-bulk-watchlist", addStablecoinIds: ["usdt-tether"], removeStablecoinIds: [] }, { initData })).status).toBe(200);
    expect((await postMutate(liveDb, { kind: "preview-bulk-watchlist", addStablecoinIds: ["usdt-tether"], removeStablecoinIds: [] }, { initData })).status).toBe(429);
  });

  it("applies global depeg-step mutations", async () => {
    const db = makeMiniAppDb(stateReadTables());
    const res = await postMutate(db, { kind: "set-global-depeg-step", depegStepBps: 500 });
    expect(res.status).toBe(200);
    expect(db.getHistory().some((e) => e.sql.includes("global_alert_depeg = MAX(telegram_subscribers.global_alert_depeg, excluded.global_alert_depeg)"))).toBe(true);
    expect(historyMatches(db, "global_depeg_worsening_bps_step = ?", { 0: 500, 1: NOW_SEC, 2: "42" })).toBe(true);
  });

  it("retains a custom quiet window across omitted-hour toggles and replaces it only with explicit hours", async () => {
    const initData = await privateInitData();
    const { db, sqlite } = persistedDb();
    const ops = [
      { kind: "set-quiet-hours", enabled: true, startHourUtc: 1, endHourUtc: 9 },
      { kind: "set-quiet-hours", enabled: false },
      { kind: "set-quiet-hours", enabled: true },
      { kind: "set-quiet-hours", enabled: true, startHourUtc: 22, endHourUtc: 7 },
    ];
    for (const [i, op] of ops.entries()) {
      expect((await postMutate(db, op, { initData })).status).toBe(200);
      expect(sqlite.prepare("SELECT quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc FROM telegram_subscribers WHERE chat_id = '42'").get()).toEqual({
        quiet_hours_enabled: op.enabled ? 1 : 0, quiet_hours_start_utc: i === 3 ? 22 : 1, quiet_hours_end_utc: i === 3 ? 7 : 9,
      });
    }
  });

  it.each([
    { label: "start only", operation: { kind: "set-quiet-hours", enabled: true, startHourUtc: 7 } },
    { label: "end only", operation: { kind: "set-quiet-hours", enabled: true, endHourUtc: 22 } },
  ] as const)("never persists an enabled quiet window that suppresses every hour ($label)", async ({ operation }) => {
    const { db, sqlite } = persistedDb();
    const res = await postMutate(db, operation);
    const row = sqlite.prepare("SELECT quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc FROM telegram_subscribers WHERE chat_id = '42'").get() as {
      quiet_hours_enabled: number; quiet_hours_start_utc: number | null; quiet_hours_end_utc: number | null;
    };
    const enabled = row.quiet_hours_enabled === 1;
    const suppressesSomeHour = Array.from({ length: 24 }, (_, h) => isQuietHoursActive(h * 3600, enabled, row.quiet_hours_start_utc, row.quiet_hours_end_utc)).some(Boolean);
    expect(res.status).not.toBe(500);
    expect(enabled && !suppressesSomeHour).toBe(false);
  });

  it("clears subscriber snooze through the Mini App mutation path", async () => {
    const { db, sqlite } = persistedDb();
    sqlite.exec("UPDATE telegram_subscribers SET alert_snooze_until_ts = 2000000000");
    expect((await postMutate(db, { kind: "clear-snooze" })).status).toBe(200);
    expect(sqlite.prepare("SELECT alert_snooze_until_ts FROM telegram_subscribers WHERE chat_id = '42'").get()).toEqual({ alert_snooze_until_ts: null });
  });

  it("does not re-enable an explicitly disabled coin alert family", async () => {
    const db = makeMiniAppDb(stateReadTables());
    const batchSizes: number[] = [];
    const originalBatch = db.batch.bind(db);
    (db as { batch: D1Database["batch"] }).batch = async (stmts: D1PreparedStatement[]) => {
      batchSizes.push(stmts.length);
      return originalBatch(stmts);
    };
    const res = await postMutate(db, {
      kind: "set-coin", stablecoinId: "usdc-circle",
      patch: { alertTypes: { dews: false, depeg: true }, dewsMinBand: "WARNING", safetyMode: "downgrade-only", launch: true },
    });
    expect(res.status).toBe(200);
    expect(historyMatches(db, "alert_dews = excluded.alert_dews", { 0: "42", 1: "usdc-circle", 2: 0, 3: null })).toBe(true);
    expect(historyMatches(db, "alert_dews = excluded.alert_dews", { 0: "42", 1: "usdc-circle", 2: 1, 3: "WARNING" })).toBe(false);
    expect(historyMatches(db, "alert_safety = excluded.alert_safety", { 0: "42", 1: "usdc-circle", 2: 1, 3: "downgrade-only" })).toBe(true);
    expect(historyMatches(db, "alert_launch = excluded.alert_launch", { 0: "42", 1: "usdc-circle", 2: 1 })).toBe(false);
    expect(batchSizes[0]).toBeGreaterThan(1);
  });

  it("enables per-coin depeg alerts when setting a worsening step", async () => {
    const db = makeMiniAppDb(stateReadTables());
    expect((await postMutate(db, { kind: "set-coin", stablecoinId: "usdc-circle", patch: { depegStepBps: 250 } })).status).toBe(200);
    expect(historyMatches(db, "alert_depeg = 1", { 0: "42", 1: "usdc-circle", 2: 250 })).toBe(true);
    expect(historyMatches(db, "depeg_worsening_bps_step = excluded.depeg_worsening_bps_step", { 0: "42", 1: "usdc-circle", 2: 250 })).toBe(true);
  });

  it("applies reserve alert mutations through direct and alert-type patches", async () => {
    const initData = await privateInitData();
    const enableDb = makeMiniAppDb(stateReadTables());
    expect((await postMutate(enableDb, { kind: "set-coin", stablecoinId: "usdc-circle", patch: { reserve: true } }, { initData })).status).toBe(200);
    expect(historyMatches(enableDb, "alert_reserve = excluded.alert_reserve", { 0: "42", 1: "usdc-circle", 2: 1 })).toBe(true);
    expect(historyMatches(enableDb, "alert_reserve = MAX(telegram_subscribers.alert_reserve, excluded.alert_reserve)", { 0: "42", 1: "alice", 17: NOW_SEC })).toBe(true);

    const disableDb = makeMiniAppDb(stateReadTables());
    expect((await postMutate(disableDb, { kind: "set-coin", stablecoinId: "usdc-circle", patch: { alertTypes: { reserve: false }, reserve: true } }, { initData })).status).toBe(200);
    expect(historyMatches(disableDb, "alert_reserve = excluded.alert_reserve", { 0: "42", 1: "usdc-circle", 2: 0 })).toBe(true);
    expect(historyMatches(disableDb, "alert_reserve = excluded.alert_reserve", { 0: "42", 1: "usdc-circle", 2: 1 })).toBe(false);
  });

  it("returns a marker-backed local opt-out after disabling the last alert", async () => {
    const { db, sqlite } = persistedDb();
    sqlite.prepare("INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_depeg_override) VALUES ('42', 'usdc-circle', 0, 1, 0, 0)").run();
    const res = await postMutate(db, { kind: "set-coin", stablecoinId: "usdc-circle", patch: { alertTypes: { depeg: false } } });
    const body = await readJsonResponse(res, 200) as { subscriptions: Array<{ stablecoinId: string; alertOverrides: { depeg: boolean } }> };
    expect(sqlite.prepare("SELECT alert_depeg, alert_depeg_override FROM telegram_subscriptions WHERE chat_id = '42' AND stablecoin_id = 'usdc-circle'").get()).toEqual({ alert_depeg: 0, alert_depeg_override: 1 });
    expect(body.subscriptions).toEqual([expect.objectContaining({ stablecoinId: "usdc-circle", alertOverrides: expect.objectContaining({ depeg: true }) })]);
  });

  it("writes recommended setup as preset provenance without materializing coin rows", async () => {
    const { db, sqlite } = persistedDb();
    expect((await postMutate(db, { kind: "recommended-setup", presetId: "usd-top25", alertTypes: ["dews", "depeg"] })).status).toBe(200);
    expect(sqlite.prepare("SELECT stablecoin_id FROM telegram_subscriptions WHERE chat_id = '42'").all()).toEqual([]);
    expect(sqlite.prepare("SELECT preset_id, alert_dews, alert_depeg, alert_safety FROM telegram_preset_subscriptions WHERE chat_id = '42'").all())
      .toEqual([{ preset_id: "usd-top25", alert_dews: 1, alert_depeg: 1, alert_safety: 0 }]);
  });

  it("keeps authenticated transient failures inside the bounded mutation budget", async () => {
    const db = makeMiniAppDb([{ match: "SELECT value, updated_at FROM cache WHERE key = ?", matchBinds: ["stablecoins"], rows: [], first: null }]);
    const res = await postMutate(db, { kind: "recommended-setup", presetId: "usd-top25", alertTypes: ["dews", "depeg"] });
    expect(await readJsonResponse(res, 503)).toMatchObject({ code: "preset-unavailable" });
    expect(hasBurstKey(db, "telegram:mini-app-mutation-burst:anon:")).toBe(true);
    expect(historyMatches(db, "DELETE FROM cache WHERE key = ?")).toBe(false);
  });

  it("follows and unfollows presets through exact preset tables", async () => {
    const initData = await privateInitData();
    const { db, sqlite } = persistedDb();
    expect((await postMutate(db, { kind: "follow-preset", presetId: "usd-top10", alertTypes: { dews: true, depeg: true }, depegStepBps: 250 }, { initData })).status).toBe(200);
    expect(sqlite.prepare("SELECT stablecoin_id FROM telegram_subscriptions WHERE chat_id = '42'").all()).toEqual([]);
    expect(sqlite.prepare("SELECT preset_id, alert_dews, alert_depeg, alert_safety, depeg_worsening_bps_step FROM telegram_preset_subscriptions WHERE chat_id = '42'").all())
      .toEqual([{ preset_id: "usd-top10", alert_dews: 1, alert_depeg: 1, alert_safety: 0, depeg_worsening_bps_step: 250 }]);

    expect((await postMutate(db, { kind: "unfollow-preset", presetId: "usd-top10" }, { initData })).status).toBe(200);
    expect(sqlite.prepare("SELECT preset_id FROM telegram_preset_subscriptions WHERE chat_id = '42'").all()).toEqual([]);
  });

  it("accepts non-USD preset ids through Mini App follow mutations", async () => {
    const { db, sqlite } = persistedDb();
    expect((await postMutate(db, { kind: "follow-preset", presetId: "non-usd-top10", alertTypes: { dews: true } })).status).toBe(200);
    expect(sqlite.prepare("SELECT * FROM telegram_subscriptions WHERE chat_id = '42'").all()).toEqual([]);
    expect(sqlite.prepare("SELECT preset_id, alert_dews, alert_depeg, alert_safety FROM telegram_preset_subscriptions WHERE chat_id = '42'").all())
      .toEqual([{ preset_id: "non-usd-top10", alert_dews: 1, alert_depeg: 0, alert_safety: 0 }]);
  });

  it("does not persist subscription, preset, or analytics rows when D1 fails mid-batch", async () => {
    let injected = false;
    const { db, sqlite } = persistedDb({ onRun(sql) {
      if (sql.includes("INSERT INTO telegram_preset_subscriptions")) { injected = true; throw new Error("mid-batch D1 failure"); }
    } });
    sqlite.prepare("INSERT INTO telegram_subscriptions (chat_id, stablecoin_id) VALUES ('42', 'usdc-circle')").run();
    const before = sqlite.prepare("SELECT * FROM telegram_subscribers").all();
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect((await postMutate(db, { kind: "recommended-setup", presetId: "usd-top25", alertTypes: ["dews", "depeg"] })).status).toBe(500);
    expect(injected).toBe(true);
    expect(sqlite.prepare("SELECT * FROM telegram_subscribers").all()).toEqual(before);
    expect(sqlite.prepare("SELECT stablecoin_id FROM telegram_subscriptions").all()).toEqual([{ stablecoin_id: "usdc-circle" }]);
    expect(sqlite.prepare("SELECT * FROM telegram_preset_subscriptions").all()).toEqual([]);
    expect(sqlite.prepare("SELECT * FROM telegram_usage_daily").all()).toEqual([]);
  });

  it("denies group mutations", async () => {
    const initData = await signedInitData({ auth_date: String(NOW_SEC - 60), chat_type: "group", user: JSON.stringify({ id: 42 }) });
    const res = await postMutate(makeMiniAppDb(), { kind: "set-global", alertType: "dews", enabled: true }, { initData });
    expect(await readJsonResponse(res, 403)).toMatchObject({ code: "not-private" });
  });

  it("allows direct-link sender mutations", async () => {
    const initData = await signedInitData({ auth_date: String(NOW_SEC - 60), chat_type: "sender", user: JSON.stringify({ id: 42, username: "alice" }) });
    const db = makeMiniAppDb(stateReadTables());
    expect((await postMutate(db, { kind: "clear-snooze" }, { initData })).status).toBe(200);
    expect(historyMatches(db, "ON CONFLICT(key) DO NOTHING")).toBe(false);
  });

  it("allows multiple mutations from the same fresh Mini App launch", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb(stateReadTables());
    expect((await postMutate(db, { kind: "clear-snooze" }, { initData })).status).toBe(200);
    expect((await postMutate(db, { kind: "set-global", alertType: "safety", enabled: true }, { initData })).status).toBe(200);
    const history = db.getHistory();
    expect(history.some((e) => e.sql.includes("global_alert_safety = excluded.global_alert_safety"))).toBe(true);
    expect(history.some((e) => e.sql.includes("ON CONFLICT(key) DO NOTHING"))).toBe(false);
  });

  it("rejects stale mutation auth at the 5-minute boundary", async () => {
    const initData = await signedInitData({ auth_date: String(NOW_SEC - 301), chat_type: "private", user: JSON.stringify({ id: 42 }) });
    expect(await readJsonResponse(await postMutate(makeMiniAppDb(), { kind: "clear-snooze" }, { initData }), 401)).toMatchObject({ code: "stale-auth" });
  });

  it("shares the mutation burst budget across operation kinds", async () => {
    const initData = await privateInitData();
    const { db, sqlite } = persistedDb();
    for (let i = 0; i < 12; i += 1) expect((await postMutate(db, { kind: "clear-snooze" }, { initData })).status).toBe(200);
    vi.setSystemTime((NOW_SEC + 17) * 1000);
    const res = await postMutate(db, { kind: "remove-coin", stablecoinId: "usdc-circle" }, { initData });
    expect(res.headers.get("Retry-After")).toBe("13");
    expect(await readJsonResponse(res, 429)).toMatchObject({ code: "rate-limited", retryAfterSec: 13 });
    expect(sqlite.prepare("SELECT failure_class, count FROM telegram_usage_daily WHERE event_type = 'mini_app_mutation_denied'").all())
      .toEqual([{ failure_class: "rate_limited", count: 1 }]);
  });

  it("rejects oversized mutation bodies with 413 before parsing JSON", async () => {
    const req = new Request(`https://api.pharos.watch${MUTATE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(20 * 1024) },
      body: JSON.stringify({ initData: "x", operation: { kind: "clear-snooze" } }),
    });
    const db = makeMiniAppDb();
    const res = await handleTelegramMiniAppMutation(db, req, BOT_TOKEN);
    expect(await readJsonResponse(res, 413)).toMatchObject({ code: "body-too-large" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(db.getHistory()).toHaveLength(0);
  });

  it("rejects oversized streamed mutation bodies without relying on Content-Length", async () => {
    const db = makeMiniAppDb();
    const req = makeStreamedMiniAppRequest(MUTATE_PATH, [
      "{\"initData\":\"x\",\"operation\":{\"kind\":\"set-timezone\",\"timezone\":\"", "x".repeat(17 * 1024), "\"}}",
    ]);
    expect(await readJsonResponse(await handleTelegramMiniAppMutation(db, req, BOT_TOKEN), 413)).toMatchObject({ code: "body-too-large" });
    expect(db.getHistory()).toHaveLength(0);
  });

  it("rejects strict-schema violations on mutation payloads", async () => {
    const db = makeMiniAppDb();
    expect(await readJsonResponse(await postMutate(db, { kind: "clear-snooze", evil: 1 }), 400)).toMatchObject({ code: "validation-error" });
    expect(db.getHistory()).toHaveLength(0);
  });

  it("rejects empty set-coin patches", async () => {
    const db = makeMiniAppDb();
    expect((await postMutate(db, { kind: "set-coin", stablecoinId: "usdc-circle", patch: {} })).status).toBe(400);
    expect(db.getHistory()).toHaveLength(0);
  });

  it("rejects set-quiet-hours with equal start and end hours", async () => {
    expect((await postMutate(makeMiniAppDb(), { kind: "set-quiet-hours", enabled: true, startHourUtc: 3, endHourUtc: 3 })).status).toBe(400);
  });

  it("rejects non-canonical recommended-setup payloads", async () => {
    expect((await postMutate(makeMiniAppDb(), { kind: "recommended-setup", presetId: "usd-top10", alertTypes: ["dews", "depeg"] })).status).toBe(400);
  });

  it("returns no-store on internal server errors", async () => {
    const db = makeMiniAppDb();
    (db as { batch: D1Database["batch"] }).batch = async () => { throw new Error("transient D1 failure"); };
    const res = await postMutate(db, { kind: "pause" });
    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(db.getHistory().some((e) => e.sql.includes("ON CONFLICT(key) DO NOTHING"))).toBe(false);
    expect(hasBurstKey(db, "telegram:mini-app-mutation-burst:anon:")).toBe(true);
    expect(historyMatches(db, "DELETE FROM cache WHERE key = ?")).toBe(false);
  });

  it("validates initData with the previous bot token when current rejects", async () => {
    const PREVIOUS_TOKEN = "previous-bot-token";
    const initData = await signedInitData({ auth_date: String(NOW_SEC - 60), chat_type: "private", user: JSON.stringify({ id: 42, username: "alice" }) }, PREVIOUS_TOKEN);
    expect((await postMutate(makeMiniAppDb(stateReadTables()), { kind: "clear-snooze" }, { initData, previousBotToken: PREVIOUS_TOKEN })).status).toBe(200);
  });

  it("applies a chat-wide snooze with the duration token offset", async () => {
    const db = makeMiniAppDb(stateReadTables());
    expect((await postMutate(db, { kind: "set-snooze", durationToken: "4h" })).status).toBe(200);
    expect(historyMatches(db, "alert_snooze_until_ts = excluded.alert_snooze_until_ts", { 0: "42", 1: "alice", 2: NOW_SEC + 14400 })).toBe(true);
  });

  it("writes the durable Paused sentinel via the pause op", async () => {
    const db = makeMiniAppDb(stateReadTables());
    expect((await postMutate(db, { kind: "pause" })).status).toBe(200);
    expect(historyMatches(db, "alert_snooze_until_ts = excluded.alert_snooze_until_ts", { 0: "42", 1: "alice", 2: PAUSE_SENTINEL_TS })).toBe(true);
  });

  it("snoozes a single coin via set-coin-snooze and clears via the clear token", async () => {
    const initData = await privateInitData();
    const setDb = makeMiniAppDb(stateReadTables());
    expect((await postMutate(setDb, { kind: "set-coin-snooze", stablecoinId: "usdc-circle", durationToken: "1h" }, { initData })).status).toBe(200);
    expect(historyMatches(setDb, "INSERT INTO telegram_subscribers", { 0: "42", 1: null, 17: NOW_SEC })).toBe(true);
    expect(historyMatches(setDb, "INSERT INTO telegram_subscriptions", { 0: "42", 1: "usdc-circle", 2: NOW_SEC + 3600 })).toBe(true);

    const clearDb = makeMiniAppDb(stateReadTables());
    expect((await postMutate(clearDb, { kind: "set-coin-snooze", stablecoinId: "usdc-circle", durationToken: "clear" }, { initData })).status).toBe(200);
    expect(historyMatches(clearDb, "UPDATE telegram_subscriptions", { 0: "42", 1: "usdc-circle" })).toBe(true);
    expect(historyMatches(clearDb, "DELETE FROM telegram_subscriptions", { 0: "42", 1: "usdc-circle" })).toBe(true);
    expect(historyMatches(clearDb, "INSERT INTO telegram_subscriptions", { 0: "42", 1: "usdc-circle" })).toBe(false);
  });

  it("rejects new frozen-coin state but still permits frozen cleanup", async () => {
    const frozen = FROZEN_STABLECOINS[0];
    if (!frozen) throw new Error("Expected a frozen stablecoin fixture");
    const initData = await privateInitData();

    const setDb = makeMiniAppDb();
    expect(await readJsonResponse(await postMutate(setDb, { kind: "set-coin", stablecoinId: frozen.id, patch: { alertTypes: { dews: true } } }, { initData }), 400)).toMatchObject({ code: "unknown-coin" });
    expect(historyMatches(setDb, "INSERT INTO telegram_subscriptions", { 1: frozen.id })).toBe(false);

    const snoozeDb = makeMiniAppDb();
    expect(await readJsonResponse(await postMutate(snoozeDb, { kind: "set-coin-snooze", stablecoinId: frozen.id, durationToken: "1h" }, { initData }), 400)).toMatchObject({ code: "unknown-coin" });
    expect(historyMatches(snoozeDb, "INSERT INTO telegram_subscriptions", { 1: frozen.id })).toBe(false);

    const clearDb = makeMiniAppDb(stateReadTables());
    expect((await postMutate(clearDb, { kind: "set-coin-snooze", stablecoinId: frozen.id, durationToken: "clear" }, { initData })).status).toBe(200);
    expect(historyMatches(clearDb, "UPDATE telegram_subscriptions", { 0: "42", 1: frozen.id })).toBe(true);

    const { db: removeDb, sqlite } = persistedDb();
    sqlite.prepare("INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_dews, alert_dews_override) VALUES ('42', ?, 1, 1)").run(frozen.id);
    expect((await postMutate(removeDb, { kind: "remove-coin", stablecoinId: frozen.id }, { initData })).status).toBe(200);
    expect(sqlite.prepare("SELECT * FROM telegram_subscriptions WHERE chat_id = '42' AND stablecoin_id = ?").get(frozen.id)).toBeUndefined();
  });

  it("rejects set-coin-snooze with a stable unknown-coin code on unknown coin", async () => {
    expect(await readJsonResponse(await postMutate(makeMiniAppDb(), { kind: "set-coin-snooze", stablecoinId: "not-a-coin", durationToken: "1h" }), 400))
      .toMatchObject({ error: "Unknown stablecoin", code: "unknown-coin" });
  });

  it("persists a valid IANA timezone via set-timezone", async () => {
    const db = makeMiniAppDb(stateReadTables());
    expect((await postMutate(db, { kind: "set-timezone", timezone: "Europe/Paris" })).status).toBe(200);
    expect(historyMatches(db, "timezone = excluded.timezone", { 0: "42", 1: "alice", 2: "Europe/Paris" })).toBe(true);
  });

  it("clears the timezone to UTC default when null is passed", async () => {
    const db = makeMiniAppDb(stateReadTables());
    expect((await postMutate(db, { kind: "set-timezone", timezone: null })).status).toBe(200);
    expect(historyMatches(db, "timezone = excluded.timezone", { 0: "42", 1: "alice", 2: null })).toBe(true);
  });

  it("rejects invalid IANA timezones with a stable invalid-timezone code", async () => {
    expect(await readJsonResponse(await postMutate(makeMiniAppDb(), { kind: "set-timezone", timezone: "Not/AZone" }), 400))
      .toMatchObject({ error: "Unknown timezone", code: "invalid-timezone" });
  });

  it("unsubscribe-all clears subscriptions, presets, and global flags in one batch", async () => {
    const db = makeMiniAppDb(stateReadTables());
    expect((await postMutate(db, { kind: "unsubscribe-all" })).status).toBe(200);
    expect(historyMatches(db, "DELETE FROM telegram_subscriptions", { 0: "42" })).toBe(true);
    expect(historyMatches(db, "DELETE FROM telegram_preset_subscriptions", { 0: "42" })).toBe(true);
    expect(historyMatches(db, "global_depeg_worsening_bps_step = NULL", { 0: NOW_SEC, 1: "42" })).toBe(true);
    expect(historyMatches(db, "alert_reserve = 0", { 0: NOW_SEC, 1: "42" })).toBe(true);
    expect(historyMatches(db, "global_alert_reserve = 0", { 0: NOW_SEC, 1: "42" })).toBe(true);
  });

  it("cannot reset authenticated admission by repeatedly recreating and forgetting the profile", async () => {
    const { db, sqlite } = persistedDb();
    sqlite.prepare("INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_depeg) VALUES ('42', 'usdc-circle', 1)").run();
    const initData = await privateInitData();
    vi.setSystemTime((NOW_SEC + 17) * 1000);
    for (let i = 0; i < 6; i += 1) {
      expect((await postMutate(db, { kind: "follow-preset", presetId: "usd-top10", alertTypes: { dews: true } }, { initData })).status).toBe(200);
      expect((await postMutate(db, { kind: "forget-me" }, { initData })).status).toBe(200);
      for (const table of ["telegram_subscribers", "telegram_subscriptions", "telegram_preset_subscriptions"]) {
        expect(sqlite.prepare(`SELECT count(*) AS count FROM ${table} WHERE chat_id = '42'`).get()).toEqual({ count: 0 });
      }
    }
    vi.setSystemTime((NOW_SEC + 30) * 1000);
    for (let i = 0; i < 3; i += 1) {
      const denied = await postMutate(db, { kind: "forget-me" }, { initData });
      expect(denied.headers.get("Retry-After")).toBe("17");
      expect(await readJsonResponse(denied, 429)).toMatchObject({ code: "rate-limited", retryAfterSec: 17 });
    }
    expect(sqlite.prepare("SELECT key, value, updated_at FROM cache WHERE key LIKE 'telegram:mini-app-mutation-burst:%'").all()).toEqual([{
      key: expect.stringMatching(/^telegram:mini-app-mutation-burst:anon:[a-f0-9]{64}$/), value: "12", updated_at: NOW_SEC + 17,
    }]);
    vi.setSystemTime((NOW_SEC + 47) * 1000);
    expect((await postMutate(db, { kind: "follow-preset", presetId: "usd-top10", alertTypes: { dews: true } }, { initData })).status).toBe(200);
    expect(sqlite.prepare("SELECT chat_id, preset_id FROM telegram_preset_subscriptions").all()).toEqual([{ chat_id: "42", preset_id: "usd-top10" }]);
  });

  it("forget-me deletes subscriber-owned rows but retains processed_updates", async () => {
    const db = makeMiniAppDb(stateReadTables());
    expect((await postMutate(db, { kind: "forget-me" })).status).toBe(200);
    expect(historyMatches(db, "DELETE FROM telegram_subscriptions WHERE chat_id = ?", { 0: "42" })).toBe(true);
    expect(historyMatches(db, "DELETE FROM telegram_preset_subscriptions WHERE chat_id = ?", { 0: "42" })).toBe(true);
    expect(historyMatches(db, "DELETE FROM telegram_chat_delivery_diagnostics WHERE chat_id = ?", { 0: "42" })).toBe(true);
    expect(historyMatches(db, "DELETE FROM telegram_subscribers WHERE chat_id = ?", { 0: "42" })).toBe(true);
    expect(historyMatches(db, "DELETE FROM cache WHERE key = ?", { 0: "telegram:mini-app-mutation-burst:42" })).toBe(true);
    expect(db.getHistory().some((e) => e.sql.includes("DELETE FROM telegram_processed_updates"))).toBe(false);
  });

  it("applies the same mutation burst budget to destructive operation kinds", async () => {
    const initData = await privateInitData();
    const { db, sqlite } = persistedDb();
    for (let i = 0; i < 12; i += 1) expect((await postMutate(db, { kind: "clear-snooze" }, { initData })).status).toBe(200);
    vi.setSystemTime((NOW_SEC + 29) * 1000);
    expect(await readJsonResponse(await postMutate(db, { kind: "forget-me" }, { initData }), 429)).toMatchObject({ code: "rate-limited", retryAfterSec: 1 });
    expect(sqlite.prepare("SELECT chat_id FROM telegram_subscribers").all()).toEqual([{ chat_id: "42" }]);
  });

  it("reuses the strict stablecoins publication across follow-preset and post-mutation state, and offloads telemetry to waitUntil", async () => {
    const { db, sqlite } = persistedDb();
    const prepareSpy = vi.spyOn(db, "prepare");
    const waitUntilPromises: Promise<unknown>[] = [];
    const execCtx = {
      waitUntil: vi.fn((p: Promise<unknown>) => { waitUntilPromises.push(p); }),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;
    const res = await postMutate(db, { kind: "follow-preset", presetId: "usd-top10", alertTypes: { dews: true } }, { versioned: true, execCtx });
    const snapshot = TelegramMiniAppSnapshotSchema.parse(await readJsonResponse(res, 200));
    const stablecoinsReads = prepareSpy.mock.calls.filter(
      ([sql]) => sql.includes("SELECT") && sql.includes("value") && sql.includes("cache") && !sql.includes("INSERT INTO cache"),
    ).length;
    expect(stablecoinsReads).toBe(1);
    expect(snapshot.state.presets[0]?.memberIds?.length).toBeGreaterThan(0);
    expect(execCtx.waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(waitUntilPromises);
    expect(sqlite.prepare("SELECT count FROM telegram_usage_daily WHERE event_type = 'mini_app_mutation'").get()).toEqual({ count: 1 });
  });

  it("returns not-configured when the bot token is missing", async () => {
    expect(await readJsonResponse(await postMutate(makeMiniAppDb(), { kind: "clear-snooze" }, { initData: "x", botToken: undefined }), 503))
      .toMatchObject({ code: "not-configured" });
  });
});

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshTelegramAdoptionRetention } from "../adoption-analytics";
import { applySubscribeIntent } from "../../store/presets";
import { upsertGlobalAlertTypes } from "../../store/subscribers";
import { applySettingToSubscriptions, applyGlobalSetting } from "../../store/subscriptions";
import { applyCoinSetting, toggleGlobalAlert } from "../../webhook/telegram-webhook-settings-mutations";
import { applyWatchlistImportV2, applyWatchlistDirectPatch } from "../../store/watchlist-import";
import { packWatchlistDirectState } from "../../mini-app/watchlist-token";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

const NOW = Math.floor(Date.parse("2026-08-20T12:00:00Z") / 1_000);

const fixtures = createLatestSchemaFixtureTracker();

describe("Telegram adoption analytics", () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1_000);
    ({ sqlite, db } = fixtures.open());
  });
  afterEach(() => { fixtures.closeAll(); vi.useRealTimers(); });

  it("claims a first follow once while keeping chat_id out of the rollup", async () => {
    sqlite.prepare(
      "INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES (?, ?, ?)",
    ).run("chat-42", NOW, NOW);
    const input = {
      chatId: "chat-42", username: null, alertTypes: new Set(["dews"]),
      directStablecoinIds: [], presetIds: ["usd-top25"],
      adoption: { campaign: "landing" as const, placement: "hero" as const },
    };
    await applySubscribeIntent(db, input);
    await applySubscribeIntent(db, input);

    expect(sqlite.prepare("SELECT first_follow_at FROM telegram_subscribers").get()).toEqual({ first_follow_at: NOW });
    expect(sqlite.prepare("SELECT campaign, placement, stage, feature, count FROM telegram_adoption_daily").all())
      .toEqual([{ campaign: "landing", placement: "hero", stage: "first_follow", feature: "preset", count: 1 }]);
    expect(sqlite.prepare("PRAGMA table_info(telegram_adoption_daily)").all().map((row) => (row as { name: string }).name))
      .not.toContain("chat_id");
  });

  it.each([
    ["direct", (db: D1Database) => applySubscribeIntent(db, {
      chatId: "first", username: null, directStablecoinIds: ["usdc-circle"], alertTypes: new Set(["dews"]),
    })],
    ["preset", (db: D1Database) => applySubscribeIntent(db, {
      chatId: "first", username: null, directStablecoinIds: [], presetIds: ["usd-top25"], alertTypes: new Set(["dews"]),
    })],
    ["global", (db: D1Database) => upsertGlobalAlertTypes(db, "first", null, new Set(["depeg"]))],
    ["direct", (db: D1Database) => applyCoinSetting(db, "first", null, "usdc-circle", "db", "A")],
    ["global", (db: D1Database) => toggleGlobalAlert(db, "first", null, "depeg", { next: 1 })],
    ["direct", (db: D1Database) => applySettingToSubscriptions(db, "first", null,
      [{ id: "usdc-circle", symbol: "USDC", name: "USD Coin" }], { ticker: "USDC", setting: "depeg", enabled: true })],
    ["global", (db: D1Database) => applyGlobalSetting(db, "first", null, { ticker: "all", setting: "depeg", enabled: true })],
  ] as const)("claims the %s first enable atomically and only once", async (feature, enable) => {
    await enable(db);
    await enable(db);
    expect(sqlite.prepare("SELECT first_follow_at FROM telegram_subscribers WHERE chat_id = 'first'").get())
      .toEqual({ first_follow_at: NOW });
    expect(sqlite.prepare("SELECT feature, count FROM telegram_adoption_daily WHERE stage = 'first_follow'").all())
      .toEqual([{ feature, count: 1 }]);
  });

  it("does not turn off-only, existing historical follows, or failed writes into first follows", async () => {
    await applyGlobalSetting(db, "off", null, { ticker: "all", setting: "depeg", enabled: false });
    sqlite.prepare("INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at, global_alert_depeg) VALUES (?, ?, ?, 1)")
      .run("historical", NOW - 86_400, NOW);
    await upsertGlobalAlertTypes(db, "historical", null, new Set(["dews"]));
    await expect(applySubscribeIntent(db, {
      chatId: "failed", username: null, directStablecoinIds: ["usdc-circle"], alertTypes: new Set(["dews"]),
      operationStatements: [db.prepare("INSERT INTO telegram_subscriptions (chat_id, stablecoin_id) VALUES (NULL, NULL)")],
    })).rejects.toThrow();
    expect(sqlite.prepare("SELECT count(*) AS count FROM telegram_adoption_daily").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT first_follow_at FROM telegram_subscribers WHERE chat_id = 'off'").get())
      .toEqual({ first_follow_at: null });
  });

  it.each(["import", "bulk"] as const)("claims an enabled %s only under its successful generation transition", async (kind) => {
    const directEntries = [packWatchlistDirectState({
      stablecoinId: "usdc-circle", alertDews: true, alertDepeg: false, alertSafety: false,
      alertLaunch: false, alertReserve: false, alertFreeze: false,
      overrideDews: true, overrideDepeg: false, overrideSafety: false,
      overrideLaunch: false, overrideReserve: false, overrideFreeze: false,
      dewsMinBand: null, safetyMode: null, depegWorseningBpsStep: null,
    })];
    sqlite.prepare("INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('import', ?, ?)").run(NOW, NOW);
    const input = {
      chatId: "import", expectedPreferenceGeneration: 0, generationLease: 123,
      directEntries, presetEntries: [], directRemoveIds: [], presetRemoveIds: [],
      pendingExpiresAt: NOW, pendingActionPayload: "import",
    };
    const apply = (expectedPreferenceGeneration: number) => kind === "import"
      ? applyWatchlistImportV2(db, { ...input, expectedPreferenceGeneration })
      : applyWatchlistDirectPatch(db, { ...input, expectedPreferenceGeneration, directEntriesToUpsert: directEntries });
    expect(await apply(99)).toBe("stale");
    expect(sqlite.prepare("SELECT count(*) AS count FROM telegram_adoption_daily").get()).toEqual({ count: 0 });
    expect(await apply(0)).toBe("applied");
    expect(await apply(0)).toBe("stale");
    expect(sqlite.prepare("SELECT feature, count FROM telegram_adoption_daily").all()).toEqual([{ feature: "direct", count: 1 }]);
  });

  it.each([0, 1])("quarantines retained two/cohort %i without hiding consistent measurements", async (cohortSize) => {
    const cohortDay = "2026-08-12";
    const cohortAt = Math.floor(Date.parse(`${cohortDay}T12:00:00Z`) / 1_000);
    for (const chat of ["one", "two"]) {
      sqlite.prepare("INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at, first_follow_at, global_alert_depeg) VALUES (?, ?, ?, ?, 1)")
        .run(chat, cohortAt, cohortAt, cohortAt);
    }
    if (cohortSize) {
      sqlite.prepare(`INSERT INTO telegram_adoption_daily
        (day, campaign, placement, stage, feature, latency_bucket, outcome, count, first_seen_at, last_seen_at)
        VALUES (?, 'organic', 'unknown', 'first_follow', 'global', '', 'success', ?, ?, ?)`)
        .run(cohortDay, cohortSize, cohortAt, cohortAt);
    }
    const result = await refreshTelegramAdoptionRetention(db, NOW);
    expect(result.mismatches).toEqual([{
      outcome: "cohort-evidence-mismatch", cohortDay, measurementDay: "2026-08-19", windowDays: 7,
      cohortSize, retained: { any: 2, direct: 0, preset: 0, global: 2 },
    }]);
    expect(sqlite.prepare("SELECT count(*) AS count FROM telegram_adoption_retention_daily WHERE measurement_day = '2026-08-19' AND window_days = 7").get())
      .toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT cohort_size, retained_count FROM telegram_adoption_retention_daily WHERE measurement_day = '2026-08-19' AND window_days = 30 AND feature = 'any'").get())
      .toEqual({ cohort_size: 0, retained_count: 0 });
  });

  it("persists the aggregate denominator and raw consistent retained counts", async () => {
    vi.setSystemTime(Date.parse("2026-08-12T12:00:00Z"));
    await upsertGlobalAlertTypes(db, "retained", null, new Set(["depeg"]));
    const result = await refreshTelegramAdoptionRetention(db, NOW);
    expect(result.mismatches).toEqual([]);
    expect(sqlite.prepare(`SELECT feature, cohort_size, retained_count FROM telegram_adoption_retention_daily
      WHERE measurement_day = '2026-08-19' AND window_days = 7 ORDER BY feature`).all()).toEqual([
      { feature: "any", cohort_size: 1, retained_count: 1 },
      { feature: "direct", cohort_size: 1, retained_count: 0 },
      { feature: "global", cohort_size: 1, retained_count: 1 },
      { feature: "preset", cohort_size: 1, retained_count: 0 },
    ]);
  });
  it("labels cohorts before aggregate first-follow collection as unavailable", async () => {
    const preRolloutNow = Math.floor(Date.parse("2026-07-11T12:00:00Z") / 1_000);
    await refreshTelegramAdoptionRetention(db, preRolloutNow);
    expect(sqlite.prepare(
      "SELECT DISTINCT quality, cohort_size, retained_count FROM telegram_adoption_retention_daily",
    ).all()).toEqual([{ quality: "pre_rollout_unavailable", cohort_size: 0, retained_count: 0 }]);
  });
});

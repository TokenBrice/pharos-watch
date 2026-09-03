import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOT_TOKEN,
  NOW_SEC,
  encoder,
  historyHas,
  hex,
  hmacSha256,
  makeMiniAppDb,
  makeMiniAppRequest,
  makeStreamedMiniAppRequest,
  makeVersionedMiniAppRequest,
  privateInitData,
  signedInitData,
  stateReadTables,
  type MockTableConfig,
} from "./telegram-mini-app.test-support";
import { type MockPreparedStatement } from "@shared/test-utils/mock-d1";
import { PAUSE_SENTINEL_TS } from "../../lib/telegram/constants";
import { encodeWatchlistTokenV3 } from "../../lib/telegram/watchlist-token";
import { FROZEN_STABLECOINS } from "@shared/lib/stablecoins/registry";
import {
  TELEGRAM_MINI_APP_CATALOG_VERSION,
  TELEGRAM_MINI_APP_CONTRACT_VERSION,
  TelegramMiniAppSnapshotSchema,
} from "@shared/lib/telegram-mini-app-contract";

const { handleTelegramMiniAppMutation } = await import("../telegram-mini-app");
const { mutationActionDetail } = await import("../telegram-mini-app-mutations");

function recapPreferenceTable(overrides: Partial<Record<string, unknown>> = {}): MockTableConfig {
  const row = {
    chat_id: "42",
    enabled: 1,
    cadence: "daily",
    delivery_hour_local: 14,
    next_due_at: NOW_SEC + 18_000,
    last_window_end_at: null,
    last_delivered_local_date: null,
    created_at: NOW_SEC,
    updated_at: NOW_SEC,
    preference_generation: 1,
    ...overrides,
  };
  return {
    match: "FROM telegram_recap_preferences p",
    first: row,
    rows: [row],
  };
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_SEC * 1000);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("handleTelegramMiniAppMutation", () => {
  it("returns only mutable state and revision for a routine versioned mutation", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, makeVersionedMiniAppRequest("/api/telegram-mini-app/mutate", {
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
    const db = makeMiniAppDb();
    const response = await handleTelegramMiniAppMutation(db, makeVersionedMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData: "not-signed",
      operation: { kind: "set-global", alertType: "safety", enabled: true },
    }, {
      contractVersion: "1",
    }), BOT_TOKEN);

    expect(await readJsonResponse(response, 409)).toMatchObject({
      code: "contract-version-mismatch",
      contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION,
      catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
    });
    expect(db.getHistory()).toEqual([]);
  });

  it("uses semantic action details for timezone and unsubscribe-all mutations", () => {
    expect(mutationActionDetail({ kind: "set-timezone", timezone: "Europe/Paris" })).toBe("timezone");
    expect(mutationActionDetail({ kind: "set-recap", enabled: true, deliveryHourLocal: 14 })).toBe("recap");
    expect(mutationActionDetail({ kind: "unsubscribe-all" })).toBe("all");
  });

  it("enables a timezone-confirmed recap, records recap telemetry, and returns refreshed state", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb([
      recapPreferenceTable(),
      ...stateReadTables({
        subscriber: {
          global_alert_dews: 0,
          global_alert_depeg: 0,
          global_alert_safety: 0,
          global_alert_launch: 0,
          global_alert_reserve: 0,
          global_alert_freeze: 0,
          global_depeg_worsening_bps_step: null,
          quiet_hours_enabled: 0,
          quiet_hours_start_utc: null,
          quiet_hours_end_utc: null,
          timezone: "Europe/Paris",
          alert_snooze_until_ts: null,
        },
      }),
    ]);

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-recap", enabled: true, deliveryHourLocal: 14 },
    }), BOT_TOKEN);

    expect(historyHas(db, "INSERT INTO telegram_recap_preferences", ["42", 1, 14])).toBe(true);
    expect(historyHas(db, "INSERT INTO telegram_usage_daily", ["mini_app_recap", "recap"])).toBe(true);
    expect(await readJsonResponse(response, 200)).toMatchObject({
      subscriber: { recap: { enabled: true, deliveryHourLocal: 14, timezoneConfirmed: true } },
    });
  });

  it("disables a recap without requiring a timezone and cancels uncommitted recap delivery", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb([
      recapPreferenceTable({ enabled: 0, delivery_hour_local: 9, next_due_at: null }),
      ...stateReadTables(),
    ]);

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-recap", enabled: false, deliveryHourLocal: 9 },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(historyHas(db, "terminal_reason = 'recap_disabled'", ["42"])).toBe(true);
    expect(historyHas(db, "DELETE FROM telegram_pending_alerts", ["42"])).toBe(true);
    expect(historyHas(db, "INSERT INTO telegram_usage_daily", ["mini_app_recap", "recap"])).toBe(true);
  });

  it("returns a retryable recap-preference conflict when the generation fence is stale", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb([
      recapPreferenceTable({ preference_generation: 2 }),
      ...stateReadTables({
        subscriber: {
          global_alert_dews: 0,
          global_alert_depeg: 0,
          global_alert_safety: 0,
          global_alert_launch: 0,
          global_alert_reserve: 0,
          global_alert_freeze: 0,
          global_depeg_worsening_bps_step: null,
          quiet_hours_enabled: 0,
          quiet_hours_start_utc: null,
          quiet_hours_end_utc: null,
          timezone: "Europe/Paris",
          alert_snooze_until_ts: null,
          preference_generation: 0,
        },
      }),
    ]);

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-recap", enabled: true, deliveryHourLocal: 14 },
    }), BOT_TOKEN);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "stale-recap-preference",
      error: "Your recap settings changed. Refresh and try again",
    });
    const recapWrite = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO telegram_recap_preferences"));
    expect(recapWrite?.binds[recapWrite.binds.length - 1]).toBe(0);
  });

  it("requires an existing subscriber and confirmed timezone before enabling a recap", async () => {
    const initData = await privateInitData();
    const missingSubscriberDb = makeMiniAppDb([
      { match: "FROM telegram_subscribers", first: null, rows: [] },
    ]);
    const missingTimezoneDb = makeMiniAppDb(stateReadTables());

    const missingSubscriber = await handleTelegramMiniAppMutation(
      missingSubscriberDb,
      makeMiniAppRequest("/api/telegram-mini-app/mutate", {
        initData,
        operation: { kind: "set-recap", enabled: true, deliveryHourLocal: 9 },
      }),
      BOT_TOKEN,
    );
    const missingTimezone = await handleTelegramMiniAppMutation(
      missingTimezoneDb,
      makeMiniAppRequest("/api/telegram-mini-app/mutate", {
        initData,
        operation: { kind: "set-recap", enabled: true, deliveryHourLocal: 9 },
      }),
      BOT_TOKEN,
    );

    expect(missingSubscriber.status).toBe(409);
    await expect(missingSubscriber.json()).resolves.toMatchObject({
      code: "recap-subscriber-required",
      error: "Add a watchlist before configuring the daily recap",
    });
    expect(missingTimezone.status).toBe(409);
    await expect(missingTimezone.json()).resolves.toMatchObject({
      code: "recap-timezone-required",
      error: "Set and confirm a timezone before enabling the daily recap",
    });
    expect(historyHas(missingSubscriberDb, "INSERT INTO telegram_usage_daily", ["mini_app_mutation_denied", "recap", "recap-subscriber-required"])).toBe(true);
    expect(historyHas(missingTimezoneDb, "INSERT INTO telegram_usage_daily", ["mini_app_mutation_denied", "recap", "recap-timezone-required"])).toBe(true);
  });

  it("allows a stale signed session to export without consuming mutation burst capacity", async () => {
    const initData = await privateInitData(60 * 60);
    const db = makeMiniAppDb(stateReadTables({
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

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "export-watchlist" },
    }), BOT_TOKEN);
    const body = await readJsonResponse(response, 200) as { result?: { kind?: string; token?: string } };

    expect(body.result?.kind).toBe("watchlist-export");
    expect(body.result?.token).toMatch(/^pw3\./);
    expect(db.getHistory().some((entry) => entry.binds.some((value) => String(value).includes("mini-app:mutation")))).toBe(false);
    expect(historyHas(db, "INSERT INTO telegram_usage_daily", ["mini_app_portability", "watchlist_export"])).toBe(true);
    expect(historyHas(db, "INSERT INTO telegram_usage_daily", ["mini_app_mutation", "watchlist_export"])).toBe(false);
  });

  it("exports freeze intent through pw3 without using mutation telemetry", async () => {
    const initData = await privateInitData(60 * 60);
    const db = makeMiniAppDb(stateReadTables({
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

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "export-watchlist" },
    }), BOT_TOKEN);

    expect(await readJsonResponse(response, 200)).toMatchObject({ result: { kind: "watchlist-export", token: expect.stringMatching(/^pw3\./) } });
    expect(historyHas(db, "INSERT INTO telegram_usage_daily", ["mini_app_portability", "watchlist_export"])).toBe(true);
    expect(historyHas(db, "INSERT INTO telegram_usage_daily", ["mini_app_mutation_denied", "watchlist_export"])).toBe(false);
  });

  it("routes a signed bulk preview through the read-only portability path", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "preview-bulk-watchlist", addStablecoinIds: ["usdt-tether"], removeStablecoinIds: [] },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: { kind: "bulk-watchlist-preview", adds: ["usdt-tether"], removes: [] },
    });
    expect(historyHas(db, "INSERT INTO telegram_usage_daily", ["mini_app_portability", "bulk_watchlist_preview"])).toBe(true);
  });

  it("hydrates state after a confirmed signed watchlist import", async () => {
    const initData = await privateInitData();
    const token = await encodeWatchlistTokenV3({
      registryVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
      direct: [{
        stablecoinId: "usdt-tether",
        alertDews: true,
        alertDepeg: true,
        alertSafety: false,
        alertLaunch: false,
        alertReserve: false,
        alertFreeze: false,
        overrideDews: true,
        overrideDepeg: true,
        overrideSafety: false,
        overrideLaunch: false,
        overrideReserve: false,
        overrideFreeze: false,
        dewsMinBand: null,
        safetyMode: null,
        depegWorseningBpsStep: null,
      }],
      presets: [],
    });
    const db = makeMiniAppDb(stateReadTables({
      subscriptions: [{
        stablecoin_id: "usdc-circle",
        alert_dews: 1,
        alert_depeg: 1,
        alert_safety: 0,
        alert_launch: 0,
        alert_reserve: 0,
        alert_freeze: 0,
        alert_dews_override: 1,
        alert_depeg_override: 1,
        alert_safety_override: 0,
        alert_launch_override: 0,
        alert_reserve_override: 0,
        alert_freeze_override: 0,
        dews_min_band: null,
        safety_mode: null,
        depeg_worsening_bps_step: null,
        alert_snooze_until_ts: null,
      }],
    }));

    const previewResponse = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "preview-watchlist-import", token },
    }), BOT_TOKEN);
    const preview = await previewResponse.json() as { result: { expectedPreferenceGeneration: number; previewFingerprint: string } };
    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: {
        kind: "confirm-watchlist-import",
        token,
        expectedPreferenceGeneration: preview.result.expectedPreferenceGeneration,
        previewFingerprint: preview.result.previewFingerprint,
      },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ viewer: { chatId: "42" } });
    expect(historyHas(db, "INSERT INTO telegram_usage_daily", ["mini_app_mutation", "watchlist_import_confirm"])).toBe(true);
  });

  it("returns stable portability errors for invalid tokens, empty exports, and stale bulk previews", async () => {
    const initData = await privateInitData();
    const invalidToken = await handleTelegramMiniAppMutation(
      makeMiniAppDb(stateReadTables()),
      makeMiniAppRequest("/api/telegram-mini-app/mutate", { initData, operation: { kind: "preview-watchlist-import", token: "not-a-watchlist" } }),
      BOT_TOKEN,
    );
    const emptyExport = await handleTelegramMiniAppMutation(
      makeMiniAppDb(stateReadTables()),
      makeMiniAppRequest("/api/telegram-mini-app/mutate", { initData, operation: { kind: "export-watchlist" } }),
      BOT_TOKEN,
    );
    const staleBulk = await handleTelegramMiniAppMutation(
      makeMiniAppDb(stateReadTables({
        subscriptions: [{ stablecoin_id: "usdc-circle", alert_dews: 1, alert_depeg: 0, alert_safety: 0, alert_launch: 0, alert_reserve: 0, alert_freeze: 0, alert_dews_override: 1, alert_depeg_override: 0, alert_safety_override: 0, alert_launch_override: 0, alert_reserve_override: 0, alert_freeze_override: 0, dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null, alert_snooze_until_ts: null }],
      })),
      makeMiniAppRequest("/api/telegram-mini-app/mutate", { initData, operation: { kind: "preview-bulk-watchlist", addStablecoinIds: ["usdc-circle"], removeStablecoinIds: ["eurc-circle"] } }),
      BOT_TOKEN,
    );

    await expect(invalidToken.json()).resolves.toMatchObject({ code: "invalid-portable-token" });
    await expect(emptyExport.json()).resolves.toMatchObject({ code: "empty-portable-state" });
    await expect(staleBulk.json()).resolves.toMatchObject({ code: "stale-bulk-preview" });
  });

  it("rate-limits repeated read-only portability requests with portable telemetry", async () => {
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
        first: { updated_at: NOW_SEC - 1 },
        rows: [{ updated_at: NOW_SEC - 1 }],
      },
    ]);

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "export-watchlist" },
    }), BOT_TOKEN);

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ code: "rate-limited", retryAfterSec: 1 });
    expect(historyHas(db, "INSERT INTO telegram_usage_daily", ["mini_app_portability", "watchlist_export", "rate_limited"])).toBe(true);
  });

  it("applies global alert mutations", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb(stateReadTables({
      subscriber: { global_alert_dews: 0, global_alert_depeg: 0, global_alert_safety: 1, global_alert_launch: 0, global_depeg_worsening_bps_step: null, quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null, timezone: null, alert_snooze_until_ts: null },
    }));

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-global", alertType: "safety", enabled: true },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(db.getHistory().some((entry) => entry.sql.includes("global_alert_safety = excluded.global_alert_safety"))).toBe(true);
  });

  it("applies global depeg-step mutations", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-global-depeg-step", depegStepBps: 500 },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(db.getHistory().some((entry) => entry.sql.includes("global_alert_depeg = MAX(telegram_subscribers.global_alert_depeg, excluded.global_alert_depeg)"))).toBe(true);
    expect(historyHas(db, "global_depeg_worsening_bps_step = ?", [500, NOW_SEC, "42"])).toBe(true);
  });

  it("applies quiet-hour mutations with exact quiet window binds", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-quiet-hours", enabled: true, startHourUtc: 22, endHourUtc: 7 },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(historyHas(db, "quiet_hours_enabled = excluded.quiet_hours_enabled", ["42", "alice", 1, 22, 7])).toBe(true);
  });

  it("clears subscriber snooze through the Mini App mutation path", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "clear-snooze" },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(historyHas(db, "alert_snooze_until_ts = NULL", ["42", "alice"])).toBe(true);
  });

  it("does not re-enable an explicitly disabled coin alert family", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb(stateReadTables());
    const batchSizes: number[] = [];
    const originalBatch = db.batch.bind(db);
    (db as { batch: D1Database["batch"] }).batch = async (statements: D1PreparedStatement[]) => {
      batchSizes.push(statements.length);
      return originalBatch(statements);
    };

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
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
    const db = makeMiniAppDb(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
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
    const enableDb = makeMiniAppDb(stateReadTables());

    const enableResponse = await handleTelegramMiniAppMutation(enableDb, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
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

    const disableDb = makeMiniAppDb(stateReadTables());
    const disableResponse = await handleTelegramMiniAppMutation(disableDb, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
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
    const db = makeMiniAppDb(stateReadTables({
      subscriptions: [{ stablecoin_id: "usdc-circle", alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0, alert_depeg_override: 1, dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null, alert_snooze_until_ts: null }],
    }));

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: {
        kind: "set-coin",
        stablecoinId: "usdc-circle",
        patch: { alertTypes: { depeg: false } },
      },
    }), BOT_TOKEN);
    const body = await readJsonResponse(response, 200) as { subscriptions: Array<{ stablecoinId: string; alertOverrides: { depeg: boolean } }> };

    expect(historyHas(db, "alert_depeg = 0", ["42", "usdc-circle"])).toBe(true);
    expect(body.subscriptions).toEqual([
      expect.objectContaining({ stablecoinId: "usdc-circle", alertOverrides: expect.objectContaining({ depeg: true }) }),
    ]);
  });

  it("removes explicit coin subscriptions", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "remove-coin", stablecoinId: "usdc-circle" },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(historyHas(db, "DELETE FROM telegram_subscriptions", ["42", "usdc-circle"])).toBe(true);
    expect(historyHas(db, "preference_generation = preference_generation + 1", ["42"])).toBe(true);
  });

  it("writes recommended setup as preset provenance without materializing coin rows", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb([stablecoinsCacheTable(), ...stateReadTables()]);

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "recommended-setup", presetId: "usd-top25", alertTypes: ["dews", "depeg"] },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(historyHas(db, "INSERT INTO telegram_subscriptions", ["42"])).toBe(false);
    expect(historyHas(db, "INSERT INTO telegram_preset_subscriptions", ["42", "usd-top25", 1, 1, 0])).toBe(true);
  });

  it("keeps authenticated transient failures inside the bounded mutation budget", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["stablecoins"],
        rows: [],
        first: null,
      },
    ]);

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "recommended-setup", presetId: "usd-top25", alertTypes: ["dews", "depeg"] },
    }), BOT_TOKEN);

    expect(await readJsonResponse(response, 503)).toMatchObject({ code: "preset-unavailable" });
    expect(historyHas(db, "INSERT INTO cache (key, value, updated_at)", ["telegram:mini-app-mutation-burst:42"])).toBe(true);
    expect(historyHas(db, "DELETE FROM cache WHERE key = ?", [])).toBe(false);
  });

  it("follows and unfollows presets through exact preset tables", async () => {
    const initData = await privateInitData();
    const followDb = makeMiniAppDb([stablecoinsCacheTable(), ...stateReadTables()]);
    const followResponse = await handleTelegramMiniAppMutation(followDb, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "follow-preset", presetId: "usd-top10", alertTypes: { dews: true, depeg: true }, depegStepBps: 250 },
    }), BOT_TOKEN);

    expect(followResponse.status).toBe(200);
    expect(historyHas(followDb, "INSERT INTO telegram_subscriptions", ["42"])).toBe(false);
    expect(historyHas(followDb, "INSERT INTO telegram_preset_subscriptions", ["42", "usd-top10", 1, 1, 0, 250])).toBe(true);

    const unfollowDb = makeMiniAppDb(stateReadTables());
    const unfollowResponse = await handleTelegramMiniAppMutation(unfollowDb, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "unfollow-preset", presetId: "usd-top10" },
    }), BOT_TOKEN);

    expect(unfollowResponse.status).toBe(200);
    expect(historyHas(unfollowDb, "DELETE FROM telegram_subscriptions", ["42"])).toBe(false);
    expect(historyHas(unfollowDb, "DELETE FROM telegram_preset_subscriptions", ["42", "usd-top10"])).toBe(true);
  });

  it("accepts non-USD preset ids through Mini App follow mutations", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb([stablecoinsCacheTable(), ...stateReadTables()]);

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "follow-preset", presetId: "non-usd-top10", alertTypes: { dews: true } },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(historyHas(db, "INSERT INTO telegram_subscriptions", ["42"])).toBe(false);
    expect(historyHas(db, "INSERT INTO telegram_preset_subscriptions", ["42", "non-usd-top10", 1, 0, 0])).toBe(true);
  });

  it("does not persist subscription, preset, or analytics rows when D1 fails mid-batch", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb([stablecoinsCacheTable()]);
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

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
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
    const response = await handleTelegramMiniAppMutation(makeMiniAppDb(), makeMiniAppRequest("/api/telegram-mini-app/mutate", {
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
    const db = makeMiniAppDb(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "clear-snooze" },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(historyHas(db, "alert_snooze_until_ts = NULL", ["42", "alice"])).toBe(true);
    expect(historyHas(db, "ON CONFLICT(key) DO NOTHING", [])).toBe(false);
  });

  it("allows multiple mutations from the same fresh Mini App launch", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb(stateReadTables());

    const firstResponse = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "clear-snooze" },
    }), BOT_TOKEN);
    const secondResponse = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
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
    const response = await handleTelegramMiniAppMutation(makeMiniAppDb(), makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "clear-snooze" },
    }), BOT_TOKEN);
    expect(response.status).toBe(401);
  });

  it("shares the mutation burst budget across operation kinds", async () => {
    const initData = await privateInitData();
    const burstKey = "telegram:mini-app-mutation-burst:42";
    const db = makeMiniAppDb([
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

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "remove-coin", stablecoinId: "usdc-circle" },
    }), BOT_TOKEN);

    expect(response.headers.get("Retry-After")).toBe("13");
    expect(await readJsonResponse(response, 429)).toMatchObject({ code: "rate-limited", retryAfterSec: 13 });
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

    const db = makeMiniAppDb();
    const response = await handleTelegramMiniAppMutation(db, req, BOT_TOKEN);

    expect(response.status).toBe(413);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    // No state SELECT, cooldown INSERT, HMAC validation, or analytics write fires pre-auth.
    expect(db.getHistory()).toHaveLength(0);
  });

  it("rejects oversized streamed mutation bodies without relying on Content-Length", async () => {
    const db = makeMiniAppDb();
    const req = makeStreamedMiniAppRequest("/api/telegram-mini-app/mutate", [
      "{\"initData\":\"x\",\"operation\":{\"kind\":\"set-timezone\",\"timezone\":\"",
      "x".repeat(17 * 1024),
      "\"}}",
    ]);

    const response = await handleTelegramMiniAppMutation(db, req, BOT_TOKEN);

    expect(await readJsonResponse(response, 413)).toMatchObject({ code: "body-too-large" });
    // Streamed body-cap failures are also pre-auth and must not write analytics.
    expect(db.getHistory()).toHaveLength(0);
  });

  it("rejects strict-schema violations on mutation payloads", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb();

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "clear-snooze", evil: 1 },
    }), BOT_TOKEN);

    expect(response.status).toBe(400);
    expect(db.getHistory()).toHaveLength(0);
  });

  it("rejects empty set-coin patches", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb();

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-coin", stablecoinId: "usdc-circle", patch: {} },
    }), BOT_TOKEN);

    expect(response.status).toBe(400);
    expect(historyHas(db, "INSERT INTO cache (key, value, updated_at)", ["telegram:mini-app-mutation-burst:42"])).toBe(false);
  });

  it("rejects set-quiet-hours with equal start and end hours", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb();

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-quiet-hours", enabled: true, startHourUtc: 3, endHourUtc: 3 },
    }), BOT_TOKEN);

    expect(response.status).toBe(400);
  });

  it("rejects non-canonical recommended-setup payloads", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb();

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "recommended-setup", presetId: "usd-top10", alertTypes: ["dews", "depeg"] },
    }), BOT_TOKEN);

    expect(response.status).toBe(400);
  });

  it("returns no-store on internal server errors", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb();
    (db as { batch: D1Database["batch"] }).batch = async () => {
      throw new Error("transient D1 failure");
    };

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
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

    const db = makeMiniAppDb(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "clear-snooze" },
    }), BOT_TOKEN, PREVIOUS_TOKEN);

    expect(response.status).toBe(200);
  });

  it("routes clear-snooze through the seam-compliant clearAlertSnooze helper", async () => {
    // The discriminator is the literal `alert_snooze_until_ts = NULL` SET
    // clause written by the canonical store helper.
    const initData = await privateInitData();
    const db = makeMiniAppDb(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
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
    const db = makeMiniAppDb(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-snooze", durationToken: "4h" },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    // 4h = 14400s; alert_snooze_until_ts should be NOW + 14400.
    expect(historyHas(db, "alert_snooze_until_ts = excluded.alert_snooze_until_ts", ["42", "alice", NOW_SEC + 14400])).toBe(true);
  });

  it("writes the durable Paused sentinel via the pause op", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "pause" },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(historyHas(db, "alert_snooze_until_ts = excluded.alert_snooze_until_ts", ["42", "alice", PAUSE_SENTINEL_TS])).toBe(true);
  });

  it("snoozes a single coin via set-coin-snooze and clears via the clear token", async () => {
    const initData = await privateInitData();
    const setDb = makeMiniAppDb(stateReadTables());

    const setResponse = await handleTelegramMiniAppMutation(setDb, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-coin-snooze", stablecoinId: "usdc-circle", durationToken: "1h" },
    }), BOT_TOKEN);

    expect(setResponse.status).toBe(200);
    expect(historyHas(setDb, "INSERT INTO telegram_subscribers", ["42", null, NOW_SEC])).toBe(true);
    expect(historyHas(setDb, "INSERT INTO telegram_subscriptions", ["42", "usdc-circle", NOW_SEC + 3600])).toBe(true);

    const clearDb = makeMiniAppDb(stateReadTables());
    const clearResponse = await handleTelegramMiniAppMutation(clearDb, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
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

    const setDb = makeMiniAppDb();
    const setResponse = await handleTelegramMiniAppMutation(setDb, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: {
        kind: "set-coin",
        stablecoinId: frozen.id,
        patch: { alertTypes: { dews: true } },
      },
    }), BOT_TOKEN);
    expect(await readJsonResponse(setResponse, 400)).toMatchObject({ code: "unknown-coin" });
    expect(historyHas(setDb, "INSERT INTO telegram_subscriptions", [frozen.id])).toBe(false);

    const snoozeDb = makeMiniAppDb();
    const snoozeResponse = await handleTelegramMiniAppMutation(snoozeDb, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-coin-snooze", stablecoinId: frozen.id, durationToken: "1h" },
    }), BOT_TOKEN);
    expect(await readJsonResponse(snoozeResponse, 400)).toMatchObject({ code: "unknown-coin" });
    expect(historyHas(snoozeDb, "INSERT INTO telegram_subscriptions", [frozen.id])).toBe(false);

    const clearDb = makeMiniAppDb(stateReadTables());
    const clearResponse = await handleTelegramMiniAppMutation(clearDb, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-coin-snooze", stablecoinId: frozen.id, durationToken: "clear" },
    }), BOT_TOKEN);
    expect(clearResponse.status).toBe(200);
    expect(historyHas(clearDb, "UPDATE telegram_subscriptions", ["42", frozen.id])).toBe(true);

    const removeDb = makeMiniAppDb(stateReadTables());
    const removeResponse = await handleTelegramMiniAppMutation(removeDb, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "remove-coin", stablecoinId: frozen.id },
    }), BOT_TOKEN);
    expect(removeResponse.status).toBe(200);
    expect(historyHas(removeDb, "DELETE FROM telegram_subscriptions", ["42", frozen.id])).toBe(true);
  });

  it("rejects set-coin-snooze with a stable unknown-coin code on unknown coin", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb();

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-coin-snooze", stablecoinId: "not-a-coin", durationToken: "1h" },
    }), BOT_TOKEN);

    expect(await readJsonResponse(response, 400)).toMatchObject({ error: "Unknown stablecoin", code: "unknown-coin" });
  });

  it("persists a valid IANA timezone via set-timezone", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-timezone", timezone: "Europe/Paris" },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(historyHas(db, "timezone = excluded.timezone", ["42", "alice", "Europe/Paris"])).toBe(true);
  });

  it("clears the timezone to UTC default when null is passed", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-timezone", timezone: null },
    }), BOT_TOKEN);

    expect(response.status).toBe(200);
    expect(historyHas(db, "timezone = excluded.timezone", ["42", "alice", null])).toBe(true);
  });

  it("rejects invalid IANA timezones with a stable invalid-timezone code", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb();

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "set-timezone", timezone: "Not/AZone" },
    }), BOT_TOKEN);

    expect(await readJsonResponse(response, 400)).toMatchObject({ error: "Unknown timezone", code: "invalid-timezone" });
  });

  it("unsubscribe-all clears subscriptions, presets, and global flags in one batch", async () => {
    const initData = await privateInitData();
    const db = makeMiniAppDb(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
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
    const db = makeMiniAppDb(stateReadTables());

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
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
    const db = makeMiniAppDb([
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

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
      initData,
      operation: { kind: "forget-me" },
    }), BOT_TOKEN);

    expect(await readJsonResponse(response, 429)).toMatchObject({ code: "rate-limited", retryAfterSec: 1 });
  });

  it("attaches a non-null latencyBucket to failed mutation analytics rows", async () => {
    // T-64: failed mutations also carry latency telemetry. With fake timers
    // `Date.now() - start === 0`, which buckets to "lt_250ms".
    const initData = await privateInitData();
    const db = makeMiniAppDb();

    const response = await handleTelegramMiniAppMutation(db, makeMiniAppRequest("/api/telegram-mini-app/mutate", {
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
      makeMiniAppDb(),
      makeMiniAppRequest("/api/telegram-mini-app/mutate", { initData: "x", operation: { kind: "clear-snooze" } }),
      undefined,
    );
    expect(await readJsonResponse(notConfigured, 503)).toMatchObject({ code: "not-configured" });

    // Oversized body: 413 body-too-large.
    const oversize = new Request("https://api.pharos.watch/api/telegram-mini-app/mutate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(20 * 1024) },
      body: JSON.stringify({ initData: "x", operation: { kind: "clear-snooze" } }),
    });
    const oversizeResponse = await handleTelegramMiniAppMutation(makeMiniAppDb(), oversize, BOT_TOKEN);
    expect(await readJsonResponse(oversizeResponse, 413)).toMatchObject({ code: "body-too-large" });

    // Stale auth: 5-minute boundary.
    const staleInitData = await signedInitData({
      auth_date: String(NOW_SEC - 301),
      chat_type: "private",
      user: JSON.stringify({ id: 42 }),
    });
    const staleResponse = await handleTelegramMiniAppMutation(
      makeMiniAppDb(),
      makeMiniAppRequest("/api/telegram-mini-app/mutate", { initData: staleInitData, operation: { kind: "clear-snooze" } }),
      BOT_TOKEN,
    );
    expect(await readJsonResponse(staleResponse, 401)).toMatchObject({ code: "stale-auth" });

    // Validation error: strict-mode unknown field.
    const validInitData = await privateInitData();
    const validationResponse = await handleTelegramMiniAppMutation(
      makeMiniAppDb(),
      makeMiniAppRequest("/api/telegram-mini-app/mutate", { initData: validInitData, operation: { kind: "clear-snooze", evil: 1 } }),
      BOT_TOKEN,
    );
    expect(await readJsonResponse(validationResponse, 400)).toMatchObject({ code: "validation-error" });

    // Group chat: 403 not-private.
    const groupInitData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      chat_type: "group",
      user: JSON.stringify({ id: 42 }),
    });
    const groupResponse = await handleTelegramMiniAppMutation(
      makeMiniAppDb(),
      makeMiniAppRequest("/api/telegram-mini-app/mutate", { initData: groupInitData, operation: { kind: "clear-snooze" } }),
      BOT_TOKEN,
    );
    expect(await readJsonResponse(groupResponse, 403)).toMatchObject({ code: "not-private" });

    // Fresh auth remains reusable within the same Mini App launch.
    const reusableInitData = await privateInitData();
    const reusableDb = makeMiniAppDb(stateReadTables());
    const reusableResponse = await handleTelegramMiniAppMutation(
      reusableDb,
      makeMiniAppRequest("/api/telegram-mini-app/mutate", { initData: reusableInitData, operation: { kind: "clear-snooze" } }),
      BOT_TOKEN,
    );
    expect(reusableResponse.status).toBe(200);
  });
});

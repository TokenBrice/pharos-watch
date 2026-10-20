import { afterEach, describe, expect, it } from "vitest";
import { TELEGRAM_MINI_APP_CATALOG_VERSION } from "@shared/lib/telegram-mini-app-contract";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import type { SqliteD1Options } from "@shared/test-utils/sqlite-d1";
import {
  encodeWatchlistTokenV3,
  type WatchlistTokenDirectState,
  type WatchlistTokenPresetState,
} from "../watchlist-token";
import type { TelegramMiniAppAuthContext } from "../mini-app-auth";
import {
  TelegramMiniAppMutationError,
  applyTelegramMiniAppMutation,
  executeTelegramMiniAppBulkWatchlistPreview,
  executeTelegramMiniAppPortabilityOperation,
} from "../telegram-mini-app-mutations";

const NOW = 1_800_000_000;
const databases: Array<ReturnType<typeof createLatestSchemaSqlite>["sqlite"]> = [];

const AUTH: TelegramMiniAppAuthContext = {
  userId: "mini-app-portability",
  username: "alice",
  firstName: "Alice",
  chatType: "private",
  startParam: null,
  authDate: NOW,
  initDataHash: "test",
  canMutatePrivateChat: true,
};

function direct(stablecoinId: string, overrides: Partial<WatchlistTokenDirectState> = {}): WatchlistTokenDirectState {
  return {
    stablecoinId,
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
    dewsMinBand: "ALERT",
    safetyMode: null,
    depegWorseningBpsStep: null,
    ...overrides,
  };
}

function preset(presetId: "usd-top10" | "usd-top25" | "eur-top10", overrides: Partial<WatchlistTokenPresetState> = {}): WatchlistTokenPresetState {
  return {
    presetId,
    alertDews: true,
    alertDepeg: false,
    alertSafety: false,
    depegWorseningBpsStep: null,
    ...overrides,
  };
}

function setup(options: SqliteD1Options = {}) {
  const fixture = createLatestSchemaSqlite(options);
  databases.push(fixture.sqlite);
  const { sqlite } = fixture;
  sqlite.prepare(`
    INSERT INTO telegram_subscribers (
      chat_id, username, created_at, last_active_at, preference_generation,
      timezone, global_alert_dews
    ) VALUES (?, ?, ?, ?, 7, 'UTC', 1)
  `).run(AUTH.userId, AUTH.username, NOW, NOW);
  sqlite.prepare(`
    INSERT INTO telegram_subscriptions (
      chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety,
      alert_launch, alert_reserve, alert_freeze,
      alert_dews_override, alert_depeg_override, alert_safety_override,
      alert_launch_override, alert_reserve_override, alert_freeze_override,
      dews_min_band, safety_mode, depeg_worsening_bps_step, alert_snooze_until_ts
    ) VALUES
      (?, 'usdc-circle', 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 'ALERT', NULL, NULL, ?),
      (?, 'dai-makerdao', 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 'WARNING', NULL, NULL, NULL)
  `).run(AUTH.userId, NOW + 3_600, AUTH.userId);
  sqlite.prepare(`
    INSERT INTO telegram_preset_subscriptions (
      chat_id, preset_id, alert_dews, alert_depeg, alert_safety,
      depeg_worsening_bps_step, created_at, updated_at
    ) VALUES
      (?, 'usd-top25', 1, 0, 0, NULL, ?, ?),
      (?, 'eur-top10', 1, 0, 0, NULL, ?, ?)
  `).run(AUTH.userId, NOW, NOW, AUTH.userId, NOW, NOW);
  sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('stablecoins', ?, ?)").run(JSON.stringify({
    peggedAssets: [
      { id: "usdc-circle", symbol: "USDC", name: "USD Coin", circulating: { peggedUSD: 1_000_000_000 } },
      { id: "usdt-tether", symbol: "USDT", name: "Tether", circulating: { peggedUSD: 2_000_000_000 } },
      { id: "dai-makerdao", symbol: "DAI", name: "Dai", circulating: { peggedUSD: 100_000_000 } },
    ],
  }), NOW);
  return fixture;
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe("Telegram Mini App portable watchlist lifecycle", () => {
  it.each(["remove", "bulk"] as const)("fences a later write after the %s snapshot and restores only the newer settings", async (mode) => {
    let armed = false;
    const { db, sqlite } = setup({
      onAll: () => {
        if (!armed) return;
        armed = false;
        // Interleave after the first read statement, not inside a simulated D1 batch.
        // Separate row/generation reads would capture DANGER with the newer generation.
        sqlite.exec("BEGIN");
        sqlite.prepare(`
          UPDATE telegram_subscriptions SET dews_min_band = 'WARNING', alert_snooze_until_ts = ?
          WHERE chat_id = ? AND stablecoin_id = 'usdc-circle'
        `).run(NOW + 7_200, AUTH.userId);
        sqlite.prepare("UPDATE telegram_subscribers SET preference_generation = preference_generation + 1 WHERE chat_id = ?")
          .run(AUTH.userId);
        sqlite.exec("COMMIT");
      },
    });
    sqlite.prepare("UPDATE telegram_subscriptions SET dews_min_band = 'DANGER' WHERE chat_id = ? AND stablecoin_id = 'usdc-circle'")
      .run(AUTH.userId);
    armed = true;
    const bulkTargets = { addStablecoinIds: [], removeStablecoinIds: ["usdc-circle"] };
    let undo;
    if (mode === "remove") {
      await expect(applyTelegramMiniAppMutation(db, AUTH, { kind: "remove-coin", stablecoinId: "usdc-circle" }))
        .rejects.toMatchObject({ code: "stale-bulk-preview" });
    } else {
      const stale = await executeTelegramMiniAppBulkWatchlistPreview(db, AUTH, {
        kind: "preview-bulk-watchlist", ...bulkTargets,
      });
      expect(stale.result).toMatchObject({
        expectedPreferenceGeneration: 7,
        undo: { restoreDirectRows: [{ stablecoinId: "usdc-circle", dewsMinBand: "DANGER", snoozeUntilTs: NOW + 3_600 }] },
      });
      await expect(applyTelegramMiniAppMutation(db, AUTH, {
        kind: "confirm-bulk-watchlist", ...bulkTargets,
        expectedPreferenceGeneration: stale.result.expectedPreferenceGeneration,
        previewFingerprint: stale.result.previewFingerprint,
      })).rejects.toMatchObject({ code: "stale-bulk-preview" });
    }
    const latest = { dews_min_band: "WARNING", alert_snooze_until_ts: NOW + 7_200 };
    const readCoin = () => sqlite.prepare(`
      SELECT dews_min_band, alert_snooze_until_ts FROM telegram_subscriptions
      WHERE chat_id = ? AND stablecoin_id = 'usdc-circle'
    `).get(AUTH.userId);
    expect(readCoin()).toEqual(latest);
    expect(sqlite.prepare("SELECT preference_generation FROM telegram_subscribers WHERE chat_id = ?").get(AUTH.userId))
      .toEqual({ preference_generation: 8 });
    if (mode === "remove") {
      undo = await applyTelegramMiniAppMutation(db, AUTH, { kind: "remove-coin", stablecoinId: "usdc-circle" });
    } else {
      const fresh = await executeTelegramMiniAppBulkWatchlistPreview(db, AUTH, {
        kind: "preview-bulk-watchlist", ...bulkTargets,
      });
      await applyTelegramMiniAppMutation(db, AUTH, {
        kind: "confirm-bulk-watchlist", ...bulkTargets,
        expectedPreferenceGeneration: fresh.result.expectedPreferenceGeneration,
        previewFingerprint: fresh.result.previewFingerprint,
      });
      undo = fresh.result.undo;
    }
    if (!undo) throw new Error("Expected fresh removal undo");
    expect(undo).toMatchObject({
      expectedPreferenceGeneration: 9,
      restoreDirectRows: [{ stablecoinId: "usdc-circle", dewsMinBand: "WARNING", snoozeUntilTs: NOW + 7_200 }],
    });
    expect(readCoin()).toBeUndefined();
    await applyTelegramMiniAppMutation(db, AUTH, { kind: "undo-bulk-watchlist", ...undo });
    expect(readCoin()).toEqual(latest);
  });

  it("enables preset depeg from a step-only edit while retaining omitted families", async () => {
    const { db, sqlite } = setup();
    await applyTelegramMiniAppMutation(db, AUTH, {
      kind: "follow-preset", presetId: "usd-top25", alertTypes: {}, depegStepBps: 250,
    });
    expect(sqlite.prepare(`
      SELECT alert_dews, alert_depeg, alert_safety, depeg_worsening_bps_step
      FROM telegram_preset_subscriptions WHERE chat_id = ? AND preset_id = 'usd-top25'
    `).get(AUTH.userId)).toEqual({ alert_dews: 1, alert_depeg: 1, alert_safety: 0, depeg_worsening_bps_step: 250 });
  });

  it.each(["tuned", "inherited-off"] as const)("keeps all three families enabled when %s tuning resets to Default or Any", async (scenario) => {
    const { db, sqlite } = setup();
    sqlite.prepare(`
      UPDATE telegram_subscriptions SET
        alert_dews = ?, alert_depeg = ?, alert_safety = ?,
        alert_dews_override = ?, alert_depeg_override = ?, alert_safety_override = ?,
        dews_min_band = 'DANGER', safety_mode = 'downgrade-only', depeg_worsening_bps_step = 250
      WHERE chat_id = ? AND stablecoin_id = 'usdc-circle'
    `).run(...Array(6).fill(scenario === "tuned" ? 1 : 0), AUTH.userId);
    await applyTelegramMiniAppMutation(db, AUTH, {
      kind: "set-coin", stablecoinId: "usdc-circle",
      patch: { dewsMinBand: null, safetyMode: null, depegStepBps: null },
    });
    expect(sqlite.prepare(`
      SELECT alert_dews, alert_depeg, alert_safety,
        alert_dews_override, alert_depeg_override, alert_safety_override,
        dews_min_band, safety_mode, depeg_worsening_bps_step, alert_snooze_until_ts
      FROM telegram_subscriptions WHERE chat_id = ? AND stablecoin_id = 'usdc-circle'
    `).get(AUTH.userId)).toEqual({
      alert_dews: 1, alert_depeg: 1, alert_safety: 1,
      alert_dews_override: 1, alert_depeg_override: 1, alert_safety_override: 1,
      dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null,
      alert_snooze_until_ts: NOW + 3_600,
    });
  });

  it("keeps explicit Off authoritative over null tuning and marks inherited families off", async () => {
    const { db, sqlite } = setup();
    await applyTelegramMiniAppMutation(db, AUTH, {
      kind: "set-coin", stablecoinId: "usdc-circle",
      patch: {
        alertTypes: { dews: false, depeg: false, safety: false },
        dewsMinBand: null, depegStepBps: null, safetyMode: null,
      },
    });
    expect(sqlite.prepare(`
      SELECT alert_dews, alert_depeg, alert_safety,
        alert_dews_override, alert_depeg_override, alert_safety_override,
        dews_min_band, safety_mode, depeg_worsening_bps_step
      FROM telegram_subscriptions WHERE chat_id = ? AND stablecoin_id = 'usdc-circle'
    `).get(AUTH.userId)).toEqual({
      alert_dews: 0, alert_depeg: 0, alert_safety: 0,
      alert_dews_override: 1, alert_depeg_override: 1, alert_safety_override: 1,
      dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null,
    });
  });

  it("keeps snooze-only rows outside portability while allowing exact direct undo", async () => {
    const { db, sqlite } = setup();
    sqlite.prepare("DELETE FROM telegram_subscriptions WHERE chat_id = ?").run(AUTH.userId);
    sqlite.prepare("DELETE FROM telegram_preset_subscriptions WHERE chat_id = ?").run(AUTH.userId);
    sqlite.prepare(`
      INSERT INTO telegram_subscriptions (
        chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_snooze_until_ts
      ) VALUES (?, 'usdc-circle', 0, 0, 0, ?)
    `).run(AUTH.userId, NOW + 3_600);
    await expect(executeTelegramMiniAppPortabilityOperation(db, AUTH, { kind: "export-watchlist" }))
      .rejects.toMatchObject({ code: "empty-portable-state" });
    const before = sqlite.prepare("SELECT * FROM telegram_subscriptions WHERE chat_id = ?").all(AUTH.userId);
    const undo = await applyTelegramMiniAppMutation(db, AUTH, { kind: "remove-coin", stablecoinId: "usdc-circle" });
    if (!undo) throw new Error("Expected snooze-only undo");
    await applyTelegramMiniAppMutation(db, AUTH, { kind: "undo-bulk-watchlist", ...undo });
    expect(sqlite.prepare("SELECT * FROM telegram_subscriptions WHERE chat_id = ?").all(AUTH.userId)).toEqual(before);
    await expect(executeTelegramMiniAppPortabilityOperation(db, AUTH, { kind: "export-watchlist" }))
      .rejects.toMatchObject({ code: "empty-portable-state" });
    const token = await encodeWatchlistTokenV3({
      registryVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
      direct: [direct("usdt-tether")],
      presets: [],
    });
    const preview = await executeTelegramMiniAppPortabilityOperation(db, AUTH, {
      kind: "preview-watchlist-import", token,
    });
    expect(preview).toMatchObject({
      result: { preview: { directAdds: ["usdt-tether"], directRemoves: [], directChanges: [] } },
    });
  });

  it.each([null, "private", "sender"])("exports, previews, and atomically confirms a versioned watchlist import (%s)", async (chatType) => {
    const { db, sqlite } = setup();
    const auth = { ...AUTH, chatType };
    const exported = await executeTelegramMiniAppPortabilityOperation(db, auth, { kind: "export-watchlist" });
    expect(exported).toMatchObject({ result: { kind: "watchlist-export", directCount: 2, presetCount: 2 } });
    sqlite.prepare("UPDATE telegram_subscriptions SET alert_snooze_until_ts = ? WHERE chat_id = ? AND stablecoin_id = 'usdc-circle'")
      .run(NOW + 7_200, AUTH.userId);
    expect(await executeTelegramMiniAppPortabilityOperation(db, auth, { kind: "export-watchlist" })).toEqual(exported);

    const token = await encodeWatchlistTokenV3({
      registryVersion: exported!.catalogVersion,
      direct: [
        direct("usdc-circle", { alertFreeze: true, overrideFreeze: true, dewsMinBand: "DANGER" }),
        direct("usdt-tether", { alertDepeg: false, overrideDepeg: false }),
      ],
      presets: [
        preset("usd-top25", { alertDepeg: true, depegWorseningBpsStep: 250 }),
        preset("usd-top10"),
      ],
    });
    const preview = await executeTelegramMiniAppPortabilityOperation(db, auth, {
      kind: "preview-watchlist-import",
      token,
    });
    expect(preview).toMatchObject({
      result: {
        kind: "watchlist-import-preview",
        expectedPreferenceGeneration: 7,
        preview: {
          directAdds: ["usdt-tether"], directRemoves: ["dai-makerdao"], directChanges: ["usdc-circle"],
          presetAdds: ["usd-top10"], presetRemoves: ["eur-top10"], presetChanges: ["usd-top25"],
        },
      },
    });
    if (!preview) throw new Error("expected watchlist import preview");
    const details = preview.result as Extract<typeof preview.result, { kind: "watchlist-import-preview" }>;

    await expect(executeTelegramMiniAppPortabilityOperation(db, auth, {
      kind: "confirm-watchlist-import",
      token,
      expectedPreferenceGeneration: 6,
      previewFingerprint: details.previewFingerprint,
    })).rejects.toMatchObject({ code: "stale-import-preview" } satisfies Partial<TelegramMiniAppMutationError>);

    await expect(executeTelegramMiniAppPortabilityOperation(db, auth, {
      kind: "confirm-watchlist-import",
      token,
      expectedPreferenceGeneration: details.expectedPreferenceGeneration,
      previewFingerprint: details.previewFingerprint,
    })).resolves.toBeNull();
    expect(sqlite.prepare("SELECT preference_generation FROM telegram_subscribers WHERE chat_id = ?").get(AUTH.userId))
      .toEqual({ preference_generation: 8 });
    expect(sqlite.prepare("SELECT stablecoin_id, alert_freeze FROM telegram_subscriptions WHERE chat_id = ? ORDER BY stablecoin_id").all(AUTH.userId))
      .toEqual([{ stablecoin_id: "usdc-circle", alert_freeze: 1 }, { stablecoin_id: "usdt-tether", alert_freeze: 0 }]);
    expect(sqlite.prepare("SELECT preset_id, alert_depeg FROM telegram_preset_subscriptions WHERE chat_id = ? ORDER BY preset_id").all(AUTH.userId))
      .toEqual([{ preset_id: "usd-top10", alert_depeg: 0 }, { preset_id: "usd-top25", alert_depeg: 1 }]);
  });

  it.each(["group", "supergroup", "channel"])("keeps portability unavailable in %s contexts", async (chatType) => {
    const { db, sqlite } = setup();
    const auth = { ...AUTH, chatType, canMutatePrivateChat: false };
    const readState = () => ({
      subscriber: sqlite.prepare("SELECT * FROM telegram_subscribers").all(),
      direct: sqlite.prepare("SELECT * FROM telegram_subscriptions").all(),
      presets: sqlite.prepare("SELECT * FROM telegram_preset_subscriptions").all(),
    });
    const before = readState();
    for (const operation of [
      { kind: "export-watchlist" },
      { kind: "preview-watchlist-import", token: "legacy-token" },
      { kind: "confirm-watchlist-import", token: "legacy-token", expectedPreferenceGeneration: 7, previewFingerprint: "preview" },
    ] as const) {
      await expect(executeTelegramMiniAppPortabilityOperation(db, auth, operation))
        .rejects.toMatchObject({ code: "not-private" });
      expect(readState()).toEqual(before);
    }
  });

  it("rejects empty exports and no-op or invalid portable confirmations", async () => {
    const { db, sqlite } = setup();
    sqlite.prepare("DELETE FROM telegram_subscriptions WHERE chat_id = ?").run(AUTH.userId);
    sqlite.prepare("DELETE FROM telegram_preset_subscriptions WHERE chat_id = ?").run(AUTH.userId);
    await expect(executeTelegramMiniAppPortabilityOperation(db, AUTH, { kind: "export-watchlist" }))
      .rejects.toMatchObject({ code: "empty-portable-state" } satisfies Partial<TelegramMiniAppMutationError>);
    await expect(executeTelegramMiniAppPortabilityOperation(db, AUTH, { kind: "preview-watchlist-import", token: "not-a-watchlist" }))
      .rejects.toMatchObject({ code: "invalid-portable-token" } satisfies Partial<TelegramMiniAppMutationError>);

    sqlite.prepare(`
      INSERT INTO telegram_subscriptions (
        chat_id, stablecoin_id, alert_dews, alert_depeg,
        alert_dews_override, alert_depeg_override, dews_min_band
      ) VALUES (?, 'usdc-circle', 1, 1, 1, 1, 'ALERT')
    `).run(AUTH.userId);
    const unchanged = await encodeWatchlistTokenV3({
      registryVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
      direct: [direct("usdc-circle")],
      presets: [],
    });
    const preview = await executeTelegramMiniAppPortabilityOperation(db, AUTH, { kind: "preview-watchlist-import", token: unchanged });
    if (!preview) throw new Error("expected watchlist import preview");
    const details = preview.result as Extract<typeof preview.result, { kind: "watchlist-import-preview" }>;
    await expect(executeTelegramMiniAppPortabilityOperation(db, AUTH, {
      kind: "confirm-watchlist-import",
      token: unchanged,
      expectedPreferenceGeneration: details.expectedPreferenceGeneration,
      previewFingerprint: details.previewFingerprint,
    })).rejects.toMatchObject({ code: "stale-import-preview" } satisfies Partial<TelegramMiniAppMutationError>);
  });

  it("previews, confirms, and undoes a bounded direct bulk edit without touching presets", async () => {
    const { db, sqlite } = setup();
    const preview = await executeTelegramMiniAppBulkWatchlistPreview(db, AUTH, {
      kind: "preview-bulk-watchlist",
      addStablecoinIds: ["usdt-tether"],
      removeStablecoinIds: ["usdc-circle", "dai-makerdao", "eurc-circle"],
    });
    expect(preview.result).toMatchObject({
      expectedPreferenceGeneration: 7,
      adds: ["usdt-tether"],
      removes: ["dai-makerdao", "usdc-circle"],
      unchanged: ["eurc-circle"],
      sourceImpact: expect.arrayContaining([
        expect.objectContaining({ stablecoinId: "usdt-tether", action: "add", inheritedSourcesAfter: expect.arrayContaining(["global", "preset"]) }),
        expect.objectContaining({ stablecoinId: "usdc-circle", action: "remove", inheritedSourcesAfter: expect.arrayContaining(["global", "preset"]) }),
      ]),
      undo: expect.objectContaining({ expectedPreferenceGeneration: 8, removeStablecoinIds: ["usdt-tether"] }),
    });

    await expect(applyTelegramMiniAppMutation(db, AUTH, {
      kind: "confirm-bulk-watchlist",
      addStablecoinIds: ["usdt-tether"],
      removeStablecoinIds: ["usdc-circle", "dai-makerdao", "eurc-circle"],
      expectedPreferenceGeneration: preview.result.expectedPreferenceGeneration,
      previewFingerprint: preview.result.previewFingerprint,
    })).resolves.toBeUndefined();
    expect(sqlite.prepare("SELECT stablecoin_id FROM telegram_subscriptions WHERE chat_id = ? ORDER BY stablecoin_id").all(AUTH.userId))
      .toEqual([{ stablecoin_id: "usdt-tether" }]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_preset_subscriptions WHERE chat_id = ?").get(AUTH.userId))
      .toEqual({ count: 2 });

    const legacyRestoreRows = preview.result.undo.restoreDirectRows.map(({ alertFreeze: _alertFreeze, overrideFreeze: _overrideFreeze, ...row }) => row);
    await expect(applyTelegramMiniAppMutation(db, AUTH, {
      kind: "undo-bulk-watchlist",
      restoreDirectRows: legacyRestoreRows,
      removeStablecoinIds: preview.result.undo.removeStablecoinIds,
      expectedPreferenceGeneration: preview.result.undo.expectedPreferenceGeneration,
      expectedFingerprint: "preview-v1-1-deadbeef",
    })).rejects.toMatchObject({ code: "stale-bulk-preview" } satisfies Partial<TelegramMiniAppMutationError>);
    await expect(applyTelegramMiniAppMutation(db, AUTH, {
      kind: "undo-bulk-watchlist",
      restoreDirectRows: legacyRestoreRows,
      removeStablecoinIds: preview.result.undo.removeStablecoinIds,
      expectedPreferenceGeneration: preview.result.undo.expectedPreferenceGeneration,
      expectedFingerprint: preview.result.undo.expectedFingerprint,
    })).resolves.toBeUndefined();
    expect(sqlite.prepare("SELECT stablecoin_id, alert_snooze_until_ts FROM telegram_subscriptions WHERE chat_id = ? ORDER BY stablecoin_id").all(AUTH.userId))
      .toEqual([
        { stablecoin_id: "dai-makerdao", alert_snooze_until_ts: null },
        { stablecoin_id: "usdc-circle", alert_snooze_until_ts: NOW + 3_600 },
      ]);
  });

  it("rejects no-op bulk previews and applies every explicit direct alert disable", async () => {
    const { db, sqlite } = setup();
    sqlite.prepare("UPDATE telegram_subscriptions SET alert_safety = 1, alert_launch = 1, alert_reserve = 1 WHERE chat_id = ? AND stablecoin_id = 'usdc-circle'").run(AUTH.userId);
    await expect(executeTelegramMiniAppBulkWatchlistPreview(db, AUTH, {
      kind: "preview-bulk-watchlist",
      addStablecoinIds: ["dai-makerdao"],
      removeStablecoinIds: ["eurc-circle"],
    })).rejects.toMatchObject({ code: "stale-bulk-preview" } satisfies Partial<TelegramMiniAppMutationError>);
    await expect(applyTelegramMiniAppMutation(db, AUTH, {
      kind: "set-coin",
      stablecoinId: "usdc-circle",
      patch: {
        alertTypes: { safety: false, launch: false, reserve: false },
        dewsMinBand: "DANGER",
        freeze: true,
      },
    })).resolves.toBeUndefined();
    expect(sqlite.prepare("SELECT alert_safety, alert_launch, alert_reserve, alert_freeze, dews_min_band FROM telegram_subscriptions WHERE chat_id = ? AND stablecoin_id = 'usdc-circle'").get(AUTH.userId))
      .toEqual({ alert_safety: 0, alert_launch: 0, alert_reserve: 0, alert_freeze: 1, dews_min_band: "DANGER" });
    await expect(applyTelegramMiniAppMutation(db, AUTH, {
      kind: "unfollow-preset",
      presetId: "unknown-preset",
    } as never)).rejects.toMatchObject({ code: "unknown-preset" } satisfies Partial<TelegramMiniAppMutationError>);
  });
});

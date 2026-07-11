import { afterEach, describe, expect, it } from "vitest";
import { TELEGRAM_MINI_APP_CATALOG_VERSION } from "@shared/lib/telegram-mini-app-contract";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import {
  encodeWatchlistTokenV3,
  type WatchlistTokenDirectState,
  type WatchlistTokenPresetState,
} from "../../lib/telegram-watchlist-token";
import type { TelegramMiniAppAuthContext } from "../../lib/telegram-mini-app-auth";
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

function setup(): ReturnType<typeof createLatestSchemaSqlite> {
  const fixture = createLatestSchemaSqlite();
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
  it("exports, previews, and atomically confirms a versioned watchlist import", async () => {
    const { db, sqlite } = setup();
    const exported = await executeTelegramMiniAppPortabilityOperation(db, AUTH, { kind: "export-watchlist" });
    expect(exported).toMatchObject({ result: { kind: "watchlist-export", directCount: 2, presetCount: 2 } });

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
    const preview = await executeTelegramMiniAppPortabilityOperation(db, AUTH, {
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

    await expect(executeTelegramMiniAppPortabilityOperation(db, AUTH, {
      kind: "confirm-watchlist-import",
      token,
      expectedPreferenceGeneration: 6,
      previewFingerprint: details.previewFingerprint,
    })).rejects.toMatchObject({ code: "stale-import-preview" } satisfies Partial<TelegramMiniAppMutationError>);

    await expect(executeTelegramMiniAppPortabilityOperation(db, AUTH, {
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
    const { db } = setup();
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
    await expect(applyTelegramMiniAppMutation(db, AUTH, {
      kind: "unfollow-preset",
      presetId: "unknown-preset",
    } as never)).rejects.toMatchObject({ code: "unknown-preset" } satisfies Partial<TelegramMiniAppMutationError>);
  });
});

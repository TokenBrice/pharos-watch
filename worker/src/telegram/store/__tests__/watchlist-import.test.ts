import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { packWatchlistDirectState, type WatchlistDirectState } from "../../mini-app/watchlist-state";
import { persistPendingConfirmBulk } from "../disambiguation";
import { prepareEnsureSubscriberExists } from "../subscribers";
import { applyWatchlistDirectPatch, loadWatchlistPortableState } from "../watchlist-import";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { isSubscribableCoin } from "../subscription-eligibility";

const NOW = 1_783_680_000;


function openLatestSchema(): { sqlite: DatabaseSync; db: D1Database } {
  return createLatestSchemaSqlite();
}

function direct(stablecoinId: string, alertDews: boolean): WatchlistDirectState {
  return {
    stablecoinId,
    alertDews,
    alertDepeg: true,
    alertSafety: alertDews,
    alertLaunch: alertDews,
    alertReserve: !alertDews,
    alertFreeze: alertDews,
    overrideDews: true,
    overrideDepeg: true,
    overrideSafety: true,
    overrideLaunch: true,
    overrideReserve: true,
    overrideFreeze: true,
    dewsMinBand: alertDews ? "WARNING" : null,
    safetyMode: "downgrade-only",
    depegWorseningBpsStep: 250,
  };
}

function seed(
  sqlite: DatabaseSync,
  payload: object,
  options: { updateId?: number; generation?: number; activeSnoozeUntilTs?: number } = {},
): void {
  const updateId = options.updateId ?? 7001;
  const generation = options.generation ?? 5;
  const activeSnoozeUntilTs = options.activeSnoozeUntilTs ?? NOW + 100_000;
  sqlite.prepare(`
    INSERT INTO telegram_subscribers (
      chat_id, username, created_at, last_active_at, preference_generation,
      quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc,
      alert_snooze_until_ts
    ) VALUES ('chat', 'alice', ?, ?, ?, 1, 22, 6, ?)
  `).run(NOW, NOW, generation, NOW + 200_000);
  sqlite.prepare(`
    INSERT INTO telegram_subscriptions (
      chat_id, stablecoin_id, alert_dews, alert_depeg,
      alert_dews_override, alert_depeg_override,
      dews_min_band, depeg_worsening_bps_step, alert_snooze_until_ts
    ) VALUES
      ('chat', 'usdc-circle', 1, 1, 1, 1, 'ALERT', 100, ?),
      ('chat', 'dai-makerdao', 1, 0, 1, 1, 'WARNING', NULL, ?),
      ('chat', 'usdt-tether', 0, 0, 0, 0, NULL, NULL, ?),
      ('chat', 'frax-frax', 0, 0, 0, 0, NULL, NULL, ?)
  `).run(activeSnoozeUntilTs, activeSnoozeUntilTs, NOW - 1, activeSnoozeUntilTs);
  sqlite.prepare(`
    INSERT INTO telegram_preset_subscriptions (
      chat_id, preset_id, alert_dews, alert_depeg, alert_safety,
      depeg_worsening_bps_step, created_at, updated_at
    ) VALUES
      ('chat', 'usd-top25', 1, 0, 0, NULL, ?, ?),
      ('chat', 'eur-top10', 1, 1, 0, 250, ?, ?)
  `).run(NOW, NOW, NOW, NOW);
  sqlite.prepare(`
    INSERT INTO telegram_pending_disambiguation (
      chat_id, alert_types, resolved_ids, ambiguous_ticker, candidates,
      remaining_tickers, expires_at, action_type, action_payload, initiator_user_id
    ) VALUES ('chat', '[]', '[]', '', '[]', '[]', ?, 'confirm-bulk', ?, 'actor')
  `).run(NOW + 300, JSON.stringify(payload));
  sqlite.prepare(`
    INSERT INTO telegram_processed_updates (
      update_id, received_at, update_type, chat_id, status, effect_state,
      claim_owner, claim_generation, intent_version, intent_kind,
      intent_mutates, intent_payload, intent_recorded_at
    ) VALUES (?, ?, 'callback_query', 'chat', 'processing', 'planned',
      'owner', 1, 1, 'callback:confirm', 1, '{}', ?)
  `).run(updateId, NOW, NOW);
}

function readState(sqlite: DatabaseSync): unknown {
  return {
    subscriber: sqlite.prepare(`
      SELECT preference_generation, quiet_hours_enabled, quiet_hours_start_utc,
             quiet_hours_end_utc, alert_snooze_until_ts
        FROM telegram_subscribers WHERE chat_id = 'chat'
    `).get(),
    direct: sqlite.prepare(`
      SELECT stablecoin_id, alert_dews, alert_depeg, dews_min_band,
             depeg_worsening_bps_step, alert_snooze_until_ts
        FROM telegram_subscriptions WHERE chat_id = 'chat' ORDER BY stablecoin_id
    `).all(),
    presets: sqlite.prepare(`
      SELECT preset_id, alert_dews, alert_depeg, alert_safety, depeg_worsening_bps_step
        FROM telegram_preset_subscriptions WHERE chat_id = 'chat' ORDER BY preset_id
    `).all(),
  };
}

describe("generation-fenced watchlist direct patch", () => {
  it("distinguishes an absent subscriber from a retained empty generation-zero subscriber", async () => {
    const { sqlite, db } = openLatestSchema();
    try {
      const absent = await loadWatchlistPortableState(db, "chat", "catalog-test", true);
      expect(absent).toEqual({
        state: { registryVersion: "catalog-test", direct: [], presets: [] },
        preferenceGeneration: null,
        directSnoozes: new Map(),
      });
      sqlite.prepare(`
        INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at, preference_generation)
        VALUES ('chat', ?, ?, 0)
      `).run(NOW, NOW);
      expect(await loadWatchlistPortableState(db, "chat", "catalog-test", true))
        .toEqual({ ...absent, preferenceGeneration: 0 });
    } finally {
      sqlite.close();
    }
  });

  it("completes a 20-coin direct bulk patch atomically without changing preset intent", async () => {
    const { sqlite, db } = openLatestSchema();
    const ids = [...TRACKED_META_BY_ID.keys()].filter(isSubscribableCoin).slice(0, 20);
    expect(ids).toHaveLength(20);
    try {
      sqlite.prepare(`
        INSERT INTO telegram_subscribers (chat_id, username, created_at, last_active_at, preference_generation)
        VALUES ('bulk-chat', 'alice', ?, ?, 9)
      `).run(NOW, NOW);
      sqlite.prepare(`
        INSERT INTO telegram_preset_subscriptions (
          chat_id, preset_id, alert_dews, alert_depeg, alert_safety, created_at, updated_at
        ) VALUES ('bulk-chat', 'usd-top25', 1, 1, 0, ?, ?)
      `).run(NOW, NOW);
      const outcome = await applyWatchlistDirectPatch(db, {
        chatId: "bulk-chat",
        expectedPreferenceGeneration: 9,
        generationLease: 4_100_000_000_000_020,
        directEntriesToUpsert: ids.map((stablecoinId) => packWatchlistDirectState(direct(stablecoinId, true))),
        directRemoveIds: [],
      });
      expect(outcome).toBe("applied");
      expect(sqlite.prepare("SELECT preference_generation FROM telegram_subscribers WHERE chat_id = 'bulk-chat'").get()).toEqual({ preference_generation: 10 });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_subscriptions WHERE chat_id = 'bulk-chat'").get()).toEqual({ count: 20 });
      expect(sqlite.prepare("SELECT alert_dews, alert_depeg FROM telegram_preset_subscriptions WHERE chat_id = 'bulk-chat'").get()).toEqual({ alert_dews: 1, alert_depeg: 1 });
      await expect(applyWatchlistDirectPatch(db, {
        chatId: "bulk-chat",
        expectedPreferenceGeneration: 9,
        generationLease: 4_100_000_000_000_021,
        directEntriesToUpsert: [],
        directRemoveIds: ids,
      })).resolves.toBe("stale");
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_subscriptions WHERE chat_id = 'bulk-chat'").get()).toEqual({ count: 20 });
    } finally {
      sqlite.close();
    }
  });

  it("creates a new subscriber before the pending preview inside the same batch", async () => {
    const { sqlite, db } = openLatestSchema();
    try {
      sqlite.exec(`
        CREATE TRIGGER require_import_subscriber_before_pending
        BEFORE INSERT ON telegram_pending_disambiguation
        WHEN NOT EXISTS (
          SELECT 1 FROM telegram_subscribers WHERE chat_id = NEW.chat_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'subscriber must precede pending preview');
        END;
      `);
      const persisted = await persistPendingConfirmBulk(db, {
        chatId: "new-chat",
        initiatorUserId: "actor",
        expiresAt: NOW + 300,
        payload: {
          kind: "subscribe",
          alertTypes: ["dews"],
          presetIds: [],
          coinIds: ["usdc-circle"],
          subscribeAll: false,
        },
        beforePendingStatements: [prepareEnsureSubscriberExists(db, "new-chat", "alice", NOW)],
      });
      expect(persisted).toBe(true);
      expect(sqlite.prepare("SELECT preference_generation FROM telegram_subscribers WHERE chat_id = 'new-chat'").get()).toEqual({ preference_generation: 0 });
      expect(sqlite.prepare("SELECT action_type FROM telegram_pending_disambiguation WHERE chat_id = 'new-chat'").get()).toEqual({ action_type: "confirm-bulk" });
    } finally {
      sqlite.close();
    }
  });

  it("creates a first-time Mini App subscriber inside the guarded batch", async () => {
    const { sqlite, db } = openLatestSchema();
    const desired = [direct("usdc-circle", true)];
    try {
      const outcome = await applyWatchlistDirectPatch(db, {
        chatId: "mini-app-chat",
        ensureSubscriber: { username: "alice" },
        expectedPreferenceGeneration: 0,
        generationLease: 4_100_000_000_000_010,
        directEntriesToUpsert: desired.map(packWatchlistDirectState),
        directRemoveIds: [],
      });
      expect(outcome).toBe("applied");
      expect(sqlite.prepare("SELECT preference_generation FROM telegram_subscribers WHERE chat_id = 'mini-app-chat'").get()).toEqual({ preference_generation: 1 });
      expect(sqlite.prepare("SELECT stablecoin_id FROM telegram_subscriptions WHERE chat_id = 'mini-app-chat'").get()).toEqual({ stablecoin_id: "usdc-circle" });
    } finally {
      sqlite.close();
    }
  });

  it("rejects stale preferences without touching pending state", async () => {
    const { sqlite, db } = openLatestSchema();
    const desired = [direct("usdc-circle", false)];
    const payload = { kind: "watchlist-import-v2", directEntries: desired.map(packWatchlistDirectState) };
    try {
      seed(sqlite, payload);
      const before = readState(sqlite);
      const outcome = await applyWatchlistDirectPatch(db, {
        chatId: "chat",
        expectedPreferenceGeneration: 4,
        generationLease: 4_100_000_000_000_002,
        directEntriesToUpsert: desired.map(packWatchlistDirectState),
        directRemoveIds: ["dai-makerdao"],
      });
      expect(outcome).toBe("stale");
      expect(readState(sqlite)).toEqual(before);
      expect(sqlite.prepare("SELECT 1 FROM telegram_pending_disambiguation WHERE chat_id = 'chat'").get()).toEqual({ 1: 1 });
    } finally {
      sqlite.close();
    }
  });

  it("rolls every guarded write back when the batch tail fails", async () => {
    const { sqlite, db } = openLatestSchema();
    const desired = [direct("usdc-circle", false)];
    const payload = { kind: "watchlist-import-v2", directEntries: desired.map(packWatchlistDirectState) };
    try {
      seed(sqlite, payload);
      const before = readState(sqlite);
      sqlite.exec(`
        CREATE TRIGGER fail_generation_restore BEFORE UPDATE OF preference_generation ON telegram_subscribers
        WHEN NEW.preference_generation = 6
        BEGIN SELECT RAISE(ABORT, 'generation restore failed'); END;
      `);
      await expect(applyWatchlistDirectPatch(db, {
        chatId: "chat",
        expectedPreferenceGeneration: 5,
        generationLease: 4_100_000_000_000_003,
        directEntriesToUpsert: desired.map(packWatchlistDirectState),
        directRemoveIds: ["dai-makerdao"],
      })).rejects.toThrow();
      expect(readState(sqlite)).toEqual(before);
    } finally {
      sqlite.close();
    }
  });

  it("revalidates packed ids before touching durable state", async () => {
    const { sqlite, db } = openLatestSchema();
    try {
      seed(sqlite, {});
      const before = readState(sqlite);
      await expect(applyWatchlistDirectPatch(db, {
        chatId: "chat",
        expectedPreferenceGeneration: 5,
        generationLease: 4_100_000_000_000_004,
        directEntriesToUpsert: ["retired-stablecoin~1"],
        directRemoveIds: ["dai-makerdao"],
      })).rejects.toThrow("failed validation");
      expect(readState(sqlite)).toEqual(before);
    } finally {
      sqlite.close();
    }
  });

  it("does not load expired snooze-only rows as watchlist intent", async () => {
    const { sqlite, db } = openLatestSchema();
    try {
      seed(sqlite, {});
      sqlite.exec(`
        INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_freeze_override)
        VALUES ('chat', 'pyusd-paypal', 1);
        INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, safety_mode)
        VALUES ('chat', 'lusd-liquity', 'upgrade-only');
      `);
      const { state, preferenceGeneration, directSnoozes } = await loadWatchlistPortableState(db, "chat", "catalog-test");
      expect(preferenceGeneration).toBe(5);
      const empty = {
        alertDews: false, alertDepeg: false, alertSafety: false, alertLaunch: false,
        alertReserve: false, alertFreeze: false, overrideDews: false, overrideDepeg: false,
        overrideSafety: false, overrideLaunch: false, overrideReserve: false, overrideFreeze: false,
        dewsMinBand: null, safetyMode: null, depegWorseningBpsStep: null,
      };
      expect(state.direct).toEqual([
        { ...empty, stablecoinId: "dai-makerdao", alertDews: true, overrideDews: true, overrideDepeg: true, dewsMinBand: "WARNING" },
        { ...empty, stablecoinId: "lusd-liquity", safetyMode: "upgrade-only" },
        { ...empty, stablecoinId: "pyusd-paypal", overrideFreeze: true },
        { ...empty, stablecoinId: "usdc-circle", alertDews: true, alertDepeg: true, overrideDews: true, overrideDepeg: true, dewsMinBand: "ALERT", depegWorseningBpsStep: 100 },
      ]);
      expect(state.presets).toEqual([
        { presetId: "eur-top10", alertDews: true, alertDepeg: true, alertSafety: false, depegWorseningBpsStep: 250 },
        { presetId: "usd-top25", alertDews: true, alertDepeg: false, alertSafety: false, depegWorseningBpsStep: null },
      ]);
      expect([...directSnoozes]).toEqual([
        ["dai-makerdao", NOW + 100_000], ["frax-frax", NOW + 100_000],
        ["lusd-liquity", null], ["pyusd-paypal", null],
        ["usdc-circle", NOW + 100_000], ["usdt-tether", NOW - 1],
      ]);
    } finally {
      sqlite.close();
    }
  });
});

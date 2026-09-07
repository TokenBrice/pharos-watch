import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createSqliteD1 } from "../../../test-helpers/sqlite-d1";
import {
  packWatchlistDirectState,
  packWatchlistPresetState,
  type WatchlistTokenDirectState,
} from "../../../lib/telegram/watchlist-token";
import { prepareTelegramProcessedUpdateMutationApplied } from "../../../lib/telegram/processed-updates";
import { persistPendingConfirmBulk } from "../disambiguation";
import { prepareEnsureSubscriberExists } from "../subscribers";
import { applyWatchlistDirectPatch, applyWatchlistImportV2, loadWatchlistPortableState } from "../watchlist-import";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { isSubscribableCoin } from "../../../lib/telegram/subscription-eligibility";

const NOW = 1_783_680_000;

function migrationDirectory(): string {
  return process.cwd().endsWith("/worker")
    ? join(process.cwd(), "migrations")
    : join(process.cwd(), "worker/migrations");
}

function openLatestSchema(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  const dir = migrationDirectory();
  for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, file), "utf8"));
  }
  return { sqlite, db: createSqliteD1(sqlite) };
}

function direct(stablecoinId: string, alertDews: boolean): WatchlistTokenDirectState {
  return {
    stablecoinId,
    alertDews,
    alertDepeg: true,
    alertSafety: false,
    alertLaunch: false,
    alertReserve: false,
    overrideDews: true,
    overrideDepeg: true,
    overrideSafety: true,
    overrideLaunch: false,
    overrideReserve: false,
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

function marker(db: D1Database, updateId = 7001): D1PreparedStatement {
  return prepareTelegramProcessedUpdateMutationApplied(db, {
    updateId,
    nowSec: NOW,
    claimOwner: "owner",
    claimGeneration: 1,
  });
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

describe("watchlist v2 atomic replacement", () => {
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

  it("applies exact provenance atomically, preserves retained snoozes, and removes snoozes with removed rows", async () => {
    const { sqlite, db } = openLatestSchema();
    const desiredDirect = [direct("usdc-circle", false), direct("pyusd-paypal", true)];
    const desiredPresets = [{
      presetId: "usd-top25",
      alertDews: false,
      alertDepeg: true,
      alertSafety: true,
      depegWorseningBpsStep: 500 as const,
    }];
    const payload = { kind: "watchlist-import-v2", directEntries: desiredDirect.map(packWatchlistDirectState) };
    const activeSnoozeUntilTs = Math.floor(Date.now() / 1000) + 100_000;
    try {
      seed(sqlite, payload, { activeSnoozeUntilTs });
      const outcome = await applyWatchlistImportV2(db, {
        chatId: "chat",
        expectedPreferenceGeneration: 5,
        generationLease: 4_100_000_000_000_001,
        directEntries: desiredDirect.map(packWatchlistDirectState),
        presetEntries: desiredPresets.map(packWatchlistPresetState),
        directRemoveIds: ["dai-makerdao"],
        presetRemoveIds: ["eur-top10"],
        pendingExpiresAt: NOW + 300,
        pendingActionPayload: JSON.stringify(payload),
        operationStatements: [marker(db)],
      });
      expect(outcome).toBe("applied");
      expect(readState(sqlite)).toEqual({
        subscriber: {
          preference_generation: 6,
          quiet_hours_enabled: 1,
          quiet_hours_start_utc: 22,
          quiet_hours_end_utc: 6,
          alert_snooze_until_ts: NOW + 200_000,
        },
        direct: [
          {
            stablecoin_id: "frax-frax",
            alert_dews: 0,
            alert_depeg: 0,
            dews_min_band: null,
            depeg_worsening_bps_step: null,
            alert_snooze_until_ts: activeSnoozeUntilTs,
          },
          {
            stablecoin_id: "pyusd-paypal",
            alert_dews: 1,
            alert_depeg: 1,
            dews_min_band: "WARNING",
            depeg_worsening_bps_step: 250,
            alert_snooze_until_ts: null,
          },
          {
            stablecoin_id: "usdc-circle",
            alert_dews: 0,
            alert_depeg: 1,
            dews_min_band: null,
            depeg_worsening_bps_step: 250,
            alert_snooze_until_ts: activeSnoozeUntilTs,
          },
        ],
        presets: [{
          preset_id: "usd-top25",
          alert_dews: 0,
          alert_depeg: 1,
          alert_safety: 1,
          depeg_worsening_bps_step: 500,
        }],
      });
      expect(sqlite.prepare("SELECT 1 FROM telegram_pending_disambiguation WHERE chat_id = 'chat'").get()).toBeUndefined();
      expect(sqlite.prepare("SELECT applied_at FROM telegram_webhook_operation_mutations WHERE update_id = 7001").get()).toEqual({ applied_at: NOW });
      // The expired snooze-only row is cleaned; the active snooze-only row remains until expiry.
      expect(sqlite.prepare("SELECT 1 FROM telegram_subscriptions WHERE stablecoin_id = 'usdt-tether'").get()).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  it("creates a first-time Mini App subscriber inside the guarded replacement batch", async () => {
    const { sqlite, db } = openLatestSchema();
    const desired = [direct("usdc-circle", true)];
    try {
      const outcome = await applyWatchlistImportV2(db, {
        chatId: "mini-app-chat",
        ensureSubscriber: { username: "alice" },
        expectedPreferenceGeneration: 0,
        generationLease: 4_100_000_000_000_010,
        directEntries: desired.map(packWatchlistDirectState),
        presetEntries: [],
        directRemoveIds: [],
        presetRemoveIds: [],
        pendingExpiresAt: 0,
        pendingActionPayload: "mini-app-portability-preview",
      });
      expect(outcome).toBe("applied");
      expect(sqlite.prepare("SELECT preference_generation FROM telegram_subscribers WHERE chat_id = 'mini-app-chat'").get()).toEqual({ preference_generation: 1 });
      expect(sqlite.prepare("SELECT stablecoin_id FROM telegram_subscriptions WHERE chat_id = 'mini-app-chat'").get()).toEqual({ stablecoin_id: "usdc-circle" });
    } finally {
      sqlite.close();
    }
  });

  it("consumes a stale preview and commits only the webhook marker, never portable preferences", async () => {
    const { sqlite, db } = openLatestSchema();
    const desired = [direct("usdc-circle", false)];
    const payload = { kind: "watchlist-import-v2", directEntries: desired.map(packWatchlistDirectState) };
    try {
      seed(sqlite, payload);
      const before = readState(sqlite);
      const outcome = await applyWatchlistImportV2(db, {
        chatId: "chat",
        expectedPreferenceGeneration: 4,
        generationLease: 4_100_000_000_000_002,
        directEntries: desired.map(packWatchlistDirectState),
        presetEntries: [],
        directRemoveIds: ["dai-makerdao"],
        presetRemoveIds: ["eur-top10", "usd-top25"],
        pendingExpiresAt: NOW + 300,
        pendingActionPayload: JSON.stringify(payload),
        operationStatements: [marker(db)],
      });
      expect(outcome).toBe("stale");
      expect(readState(sqlite)).toEqual(before);
      expect(sqlite.prepare("SELECT 1 FROM telegram_pending_disambiguation WHERE chat_id = 'chat'").get()).toBeUndefined();
      expect(sqlite.prepare("SELECT applied_at FROM telegram_webhook_operation_mutations WHERE update_id = 7001").get()).toEqual({ applied_at: NOW });
    } finally {
      sqlite.close();
    }
  });

  it("rolls every guarded write and pending deletion back when the final operation statement fails", async () => {
    const { sqlite, db } = openLatestSchema();
    const desired = [direct("usdc-circle", false)];
    const payload = { kind: "watchlist-import-v2", directEntries: desired.map(packWatchlistDirectState) };
    try {
      seed(sqlite, payload);
      const before = readState(sqlite);
      const failure = db.prepare(`
        INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at)
        VALUES ('chat', ?, ?)
      `).bind(NOW, NOW);
      await expect(applyWatchlistImportV2(db, {
        chatId: "chat",
        expectedPreferenceGeneration: 5,
        generationLease: 4_100_000_000_000_003,
        directEntries: desired.map(packWatchlistDirectState),
        presetEntries: [],
        directRemoveIds: ["dai-makerdao"],
        presetRemoveIds: ["eur-top10", "usd-top25"],
        pendingExpiresAt: NOW + 300,
        pendingActionPayload: JSON.stringify(payload),
        operationStatements: [failure],
      })).rejects.toThrow();
      expect(readState(sqlite)).toEqual(before);
      expect(sqlite.prepare("SELECT 1 FROM telegram_pending_disambiguation WHERE chat_id = 'chat'").get()).toEqual({ 1: 1 });
      expect(sqlite.prepare("SELECT 1 FROM telegram_webhook_operation_mutations WHERE update_id = 7001").get()).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  it("revalidates packed ids at confirmation before touching durable state", async () => {
    const { sqlite, db } = openLatestSchema();
    const payload = { kind: "watchlist-import-v2", directEntries: ["retired-stablecoin~1"] };
    try {
      seed(sqlite, payload);
      const before = readState(sqlite);
      await expect(applyWatchlistImportV2(db, {
        chatId: "chat",
        expectedPreferenceGeneration: 5,
        generationLease: 4_100_000_000_000_004,
        directEntries: ["retired-stablecoin~1"],
        presetEntries: [],
        directRemoveIds: ["dai-makerdao"],
        presetRemoveIds: ["eur-top10", "usd-top25"],
        pendingExpiresAt: NOW + 300,
        pendingActionPayload: JSON.stringify(payload),
        operationStatements: [marker(db)],
      })).rejects.toThrow("failed confirmation validation");
      expect(readState(sqlite)).toEqual(before);
      expect(sqlite.prepare("SELECT 1 FROM telegram_pending_disambiguation WHERE chat_id = 'chat'").get()).toEqual({ 1: 1 });
      expect(sqlite.prepare("SELECT 1 FROM telegram_webhook_operation_mutations WHERE update_id = 7001").get()).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  it("does not export expired snooze-only rows as portable intent", async () => {
    const { sqlite, db } = openLatestSchema();
    try {
      seed(sqlite, {});
      const { state } = await loadWatchlistPortableState(db, "chat", "catalog-test");
      expect(state.direct.map((row) => row.stablecoinId)).not.toContain("usdt-tether");
      expect(state.direct.map((row) => row.stablecoinId)).not.toContain("frax-frax");
    } finally {
      sqlite.close();
    }
  });
});

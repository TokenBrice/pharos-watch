import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StablecoinsCacheLoadResult } from "../../lib/stablecoins-cache";
import {
  serializePendingAlertScope,
  serializePendingMarkupPolicy,
  type PendingAlertScopeItem,
} from "../../lib/telegram-pending-provenance";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import {
  revalidatePendingAlertPreferences,
  type PendingPreferenceRevalidation,
} from "../telegram-pending/preference-revalidation";
import type { PendingAlertRow } from "../telegram-pending/types";
import { emptyAlerts, expandSubscriberChunks } from "../dispatch-telegram-routing";
import type { SafetyScorePublicationIdentity } from "@shared/types/safety-score-publication";
import { insertTelegramSubscriber } from "./telegram-subscriber.test-support";

const NOW = 1_800_000_000;
const CHAT_ID = "42";
const COIN_ID = "usdc-circle";

let sqlite: DatabaseSync;
let db: D1Database;

beforeEach(() => {
  sqlite = createLatestSchemaSqlite().sqlite;
  db = createSqliteD1(sqlite);
});

afterEach(() => sqlite.close());

function insertSubscriber(options: {
  generation?: number;
  chatSnoozeUntil?: number | null;
  globalDews?: number;
} = {}): void {
  insertTelegramSubscriber(sqlite, {
    chatId: CHAT_ID,
    createdAt: 0,
    lastActiveAt: 0,
    preferenceGeneration: options.generation ?? 1,
    snoozeUntil: options.chatSnoozeUntil,
    global: { dews: options.globalDews === 1 },
  });
}

function insertDirect(options: {
  enabled?: number;
  override?: number;
  coinSnoozeUntil?: number | null;
} = {}): void {
  sqlite.prepare(
    `INSERT INTO telegram_subscriptions (
       chat_id, stablecoin_id, alert_dews, alert_dews_override, alert_snooze_until_ts
     ) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    CHAT_ID,
    COIN_ID,
    options.enabled ?? 1,
    options.override ?? 1,
    options.coinSnoozeUntil ?? null,
  );
}

function insertPreset(presetId = "usd-top10"): void {
  sqlite.prepare(
    `INSERT INTO telegram_preset_subscriptions
       (chat_id, preset_id, alert_dews, created_at, updated_at)
     VALUES (?, ?, 1, 0, 0)`,
  ).run(CHAT_ID, presetId);
}

function pendingRow(options: {
  generation?: number;
  scope?: PendingAlertScopeItem[];
  legacy?: boolean;
  safetyScoreIdentity?: SafetyScorePublicationIdentity | null;
} = {}): PendingAlertRow {
  const scope = options.scope ?? [{ stablecoinId: COIN_ID, family: "dews" }];
  return {
    id: 1,
    chat_id: CHAT_ID,
    message_html: "alert",
    disable_notification: 0,
    created_at: NOW - 60,
    expires_at: NOW + 3_000,
    attempts: 0,
    not_before_at: null,
    priority: 10,
    source_type: "risk_alert",
    alert_type: "dews",
    last_error_class: null,
    dedupe_key: "target-1",
    chunk_index: 0,
    source_event_id: options.legacy ? null : "source-1",
    alert_scope_json: options.legacy
      ? null
      : serializePendingAlertScope(scope, options.safetyScoreIdentity),
    preference_generation: options.legacy ? null : options.generation ?? 1,
    markup_policy_json: options.legacy ? null : serializePendingMarkupPolicy({}),
    delivery_state: "pending",
    delivery_owner: null,
    delivery_generation: 0,
    delivery_started_at: null,
    delivery_completed_at: null,
    delivery_claim_expires_at: null,
    alert_snooze_until_ts: null,
    quiet_hours_enabled: 0,
    quiet_hours_start_utc: null,
    quiet_hours_end_utc: null,
    timezone: null,
  };
}

function recapRow(options: { generation?: number; markupPolicyJson?: string | null } = {}): PendingAlertRow {
  return {
    ...pendingRow(),
    source_type: "personalized_recap",
    alert_type: null,
    dedupe_key: "recap:42:2026-07-11:v1",
    source_event_id: "recap:42:2026-07-11:v1",
    alert_scope_json: null,
    preference_generation: options.generation ?? 1,
    markup_policy_json: options.markupPolicyJson ?? serializePendingMarkupPolicy({
      replyMarkup: { inline_keyboard: [[{ text: "View watchlist", web_app: { url: "https://pharos.watch/pharoswatchbot" } }]] },
    }),
  };
}

function insertRecapTarget(generation = 1, enabled = 1): void {
  sqlite.prepare(
    `INSERT INTO telegram_recap_preferences (chat_id, chat_kind, enabled, created_at, updated_at)
     VALUES (?, 'private', ?, 0, 0)`,
  ).run(CHAT_ID, enabled);
  sqlite.prepare(
    `INSERT INTO telegram_recap_targets
       (recap_key, chat_id, local_date, window_start_at, window_end_at, preference_generation,
        watchlist_fingerprint, pending_dedupe_key, status, created_at, updated_at)
     VALUES (?, ?, '2026-07-11', 0, 0, ?, 'fingerprint-v1', ?, 'queued', 0, 0)`,
  ).run("recap:42:2026-07-11:v1", CHAT_ID, generation, "recap:42:2026-07-11:v1");
}

function stablecoinsResult(): StablecoinsCacheLoadResult {
  return {
    kind: "ok",
    updatedAt: NOW,
    payload: {
      peggedAssets: [{
        id: COIN_ID,
        symbol: "USDC",
        name: "USD Coin",
        pegType: "peggedUSD",
        price: 1,
        circulating: { peggedUSD: 50_000_000_000 },
      }],
    },
  } as unknown as StablecoinsCacheLoadResult;
}

async function evaluate(row = pendingRow()): Promise<PendingPreferenceRevalidation> {
  const outcomes = await revalidatePendingAlertPreferences(db, [row], NOW, {
    getStablecoinsCacheResult: async () => stablecoinsResult(),
  });
  expect(outcomes).toHaveLength(1);
  return outcomes[0];
}

describe("pending Telegram preference revalidation", () => {
  it("carries one identical conservative target-group scope on every split chunk", () => {
    const scope: PendingAlertScopeItem[] = [
      { stablecoinId: COIN_ID, family: "dews" },
      { stablecoinId: "tether", family: "depeg" },
    ];
    const messages = expandSubscriberChunks([{
      chatId: CHAT_ID,
      lastActiveAt: NOW,
      alerts: emptyAlerts(),
      canonicalHtml: "whole target group",
      chunks: ["chunk 1", "chunk 2"],
      disableNotification: false,
      alertType: "dews",
      sourceEventId: "source-1",
      preferenceGeneration: 3,
      alertScope: scope,
    }]);

    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.alertScope)).toEqual([scope, scope]);
  });

  it("allows an unchanged direct subscription", async () => {
    insertSubscriber({ generation: 4 });
    insertDirect();
    await expect(evaluate(pendingRow({ generation: 4 }))).resolves.toMatchObject({
      kind: "eligible",
      validatedPreferenceGeneration: 4,
    });
  });

  it("allows a stale generation when the exact scope is still eligible", async () => {
    insertSubscriber({ generation: 9 });
    insertDirect();
    await expect(evaluate(pendingRow({ generation: 2 }))).resolves.toMatchObject({
      kind: "eligible",
      validatedPreferenceGeneration: 9,
    });
  });

  it("cancels an explicit local off even when global and preset paths are on", async () => {
    insertSubscriber({ generation: 2, globalDews: 1 });
    insertDirect({ enabled: 0, override: 1 });
    insertPreset();
    await expect(evaluate()).resolves.toMatchObject({ kind: "cancel", reason: "scope_disabled" });
  });

  it("cancels after global disable when no direct or preset path remains", async () => {
    insertSubscriber({ generation: 2, globalDews: 0 });
    await expect(evaluate()).resolves.toMatchObject({ kind: "cancel", reason: "scope_disabled" });
  });

  it("cancels after a preset unfollow", async () => {
    insertSubscriber({ generation: 2 });
    await expect(evaluate()).resolves.toMatchObject({ kind: "cancel", reason: "scope_disabled" });
  });

  it("allows a still-followed preset whose current membership contains the coin", async () => {
    insertSubscriber({ generation: 2 });
    insertPreset();
    await expect(evaluate()).resolves.toMatchObject({
      kind: "eligible",
      validatedPreferenceGeneration: 2,
    });
  });

  it("defers rather than cancels when required preset membership is unavailable", async () => {
    insertSubscriber({ generation: 2 });
    insertPreset();
    const [outcome] = await revalidatePendingAlertPreferences(db, [pendingRow()], NOW, {
      getStablecoinsCacheResult: async () => ({ kind: "error", reason: "missing-cache", updatedAt: null }),
    });
    expect(outcome).toMatchObject({ kind: "defer", reason: "preference_preset_unavailable" });
  });

  it("cancels a forgotten or otherwise missing subscriber", async () => {
    await expect(evaluate()).resolves.toMatchObject({ kind: "cancel", reason: "subscriber_missing" });
  });

  it("cancels a block-disabled direct subscription", async () => {
    insertSubscriber({ generation: 2 });
    insertDirect({ enabled: 0, override: 1 });
    await expect(evaluate()).resolves.toMatchObject({ kind: "cancel", reason: "scope_disabled" });
  });

  it("defers the whole immutable target group for chat or coin snooze", async () => {
    insertSubscriber({ generation: 2, chatSnoozeUntil: NOW + 300 });
    insertDirect({ coinSnoozeUntil: NOW + 600 });
    await expect(evaluate()).resolves.toMatchObject({
      kind: "defer",
      reason: "preference_snoozed",
      notBeforeAt: NOW + 600,
    });
  });

  it("preserves rolling compatibility for all-null legacy provenance", async () => {
    await expect(evaluate(pendingRow({ legacy: true }))).resolves.toMatchObject({
      kind: "eligible",
      validatedPreferenceGeneration: null,
      markupPolicy: null,
    });
  });

  it("defers partially present provenance instead of silently treating it as legacy", async () => {
    const row = pendingRow();
    row.markup_policy_json = null;
    await expect(evaluate(row)).resolves.toMatchObject({
      kind: "defer",
      reason: "preference_provenance_incomplete",
    });
  });

  it("revalidates a private enabled recap and preserves its exact persisted markup", async () => {
    insertSubscriber({ generation: 4 });
    insertRecapTarget(4);
    const row = recapRow({ generation: 4 });
    await expect(evaluate(row)).resolves.toMatchObject({
      kind: "eligible",
      validatedPreferenceGeneration: 4,
      markupPolicy: expect.objectContaining({ replyMarkup: expect.any(Object) }),
    });
  });

  it("cancels a paused recap instead of deferring it to the pause sentinel", async () => {
    insertSubscriber({ generation: 1, chatSnoozeUntil: 4_102_444_800 });
    insertRecapTarget();
    await expect(evaluate(recapRow())).resolves.toMatchObject({ kind: "cancel", reason: "recap_paused" });
  });

  it("defers a recap during a timed snooze until the subscriber becomes eligible", async () => {
    insertSubscriber({ generation: 1, chatSnoozeUntil: NOW + 300 });
    insertRecapTarget();

    await expect(evaluate(recapRow())).resolves.toMatchObject({
      kind: "defer",
      reason: "recap_snoozed",
      notBeforeAt: NOW + 300,
    });
  });

  it("cancels a recap when the preference has been disabled", async () => {
    insertSubscriber({ generation: 1 });
    insertRecapTarget(1, 0);

    await expect(evaluate(recapRow())).resolves.toMatchObject({ kind: "cancel", reason: "recap_disabled" });
  });

  it("cancels a recap whose durable preference or target has been removed", async () => {
    insertSubscriber({ generation: 1 });

    await expect(evaluate(recapRow())).resolves.toMatchObject({
      kind: "cancel",
      reason: "recap_preference_missing",
    });
  });

  it("defers recap rows with invalid immutable provenance", async () => {
    const row = recapRow();
    row.markup_policy_json = null;

    await expect(evaluate(row)).resolves.toMatchObject({
      kind: "defer",
      reason: "recap_markup_policy_missing",
      notBeforeAt: NOW + 15 * 60,
    });
  });

  it("cancels a recap when its target generation no longer matches the subscriber", async () => {
    insertSubscriber({ generation: 2 });
    insertRecapTarget(1);
    await expect(evaluate(recapRow())).resolves.toMatchObject({
      kind: "cancel",
      reason: "recap_generation_changed",
    });
  });

  it("cancels a preset route after the preset no longer contains its coin", async () => {
    insertSubscriber({ generation: 2 });
    insertPreset("mcap-ge-1b");
    const [outcome] = await revalidatePendingAlertPreferences(db, [pendingRow()], NOW, {
      getStablecoinsCacheResult: async () => ({
        kind: "ok",
        updatedAt: NOW,
        payload: {
          peggedAssets: [{
            id: "tether",
            symbol: "USDT",
            name: "Tether",
            pegType: "peggedUSD",
            price: 1,
            circulating: { peggedUSD: 100_000_000_000 },
          }],
        },
      }) as unknown as StablecoinsCacheLoadResult,
    });

    expect(outcome).toMatchObject({ kind: "cancel", reason: "scope_disabled" });
  });
});

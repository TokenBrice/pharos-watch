import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinsCacheLoadResult } from "../../../../lib/stablecoins-cache";
import {
  serializePendingAlertScope,
  serializePendingMarkupPolicy,
  type PendingAlertScopeItem,
} from "../../../../telegram/outbox/pending-provenance";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import {
  revalidatePendingAlertPreferences,
  type PendingPreferenceRevalidation,
} from "../preference-revalidation";
import type { PendingAlertRow } from "../types";
import { emptyAlerts, expandSubscriberChunks } from "../../dispatch/dispatch-telegram-routing";
import type { SafetyScorePublicationIdentity } from "@shared/types/safety-score-publication";
import { insertTelegramSubscriber } from "../../dispatch/__tests__/telegram-subscriber.test-support";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { buildAlertSafetyV9SourceEnvelopeFromParts } from "../../../../lib/alert-safety-source-cache";
import { makeWorkerReportCardsV9Response } from "../../../../test-helpers/report-cards-v9";
import { TELEGRAM_ALERT_TYPES } from "@shared/types/status";

const NOW = 1_800_000_000;
const CHAT_ID = "42";
const COIN_ID = "usdc-circle";

let sqlite: DatabaseSync;
let db: D1Database;


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

describe("pending Telegram chunk scope", () => {
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
});

describe("pending Telegram preference revalidation", () => {
  beforeEach(() => {
    sqlite = createLatestSchemaSqlite().sqlite;
    db = createSqliteD1(sqlite);
  });
  afterEach(() => sqlite.close());

  it.each(TELEGRAM_ALERT_TYPES)("revalidates %s global/direct enablement and explicit off", async (family) => {
    insertTelegramSubscriber(sqlite, {
      chatId: CHAT_ID, createdAt: 0, lastActiveAt: 0, global: { [family]: true },
    });
    const response = makeWorkerReportCardsV9Response({ updatedAt: NOW });
    const insert = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
    insert.run("alert-safety-v9-source", JSON.stringify(buildAlertSafetyV9SourceEnvelopeFromParts({ cards: response.cards, safetyScoreIdentity: response.safetyScoreIdentity, publishedAt: response.updatedAt })), NOW);
    insert.run("report-cards:v9:publication-health", stableJsonStringifyV1(response.publicationHealth), NOW);
    const row = pendingRow({
      scope: [{ stablecoinId: COIN_ID, family }], safetyScoreIdentity: response.safetyScoreIdentity,
    });
    expect(await evaluate(row)).toMatchObject({ kind: "eligible" });
    sqlite.prepare(`INSERT INTO telegram_subscriptions
      (chat_id, stablecoin_id, alert_${family}, alert_${family}_override) VALUES (?, ?, 1, 1)`).run(CHAT_ID, COIN_ID);
    sqlite.prepare(`UPDATE telegram_subscribers SET global_alert_${family} = 0 WHERE chat_id = ?`).run(CHAT_ID);
    expect(await evaluate(row)).toMatchObject({ kind: "eligible" });
    sqlite.prepare(`UPDATE telegram_subscriptions SET alert_${family} = 0 WHERE chat_id = ?`).run(CHAT_ID);
    expect(await evaluate(row)).toMatchObject({ kind: "cancel", reason: "scope_disabled" });
  });

  it.each(["missing", "held", "stale", "health-read"] as const)(
    "defers %s safety evidence and admits unchanged-identity recovery",
    async (failure) => {
      insertTelegramSubscriber(sqlite, {
        chatId: CHAT_ID, createdAt: 0, lastActiveAt: 0, global: { safety: true },
      });
      const response = makeWorkerReportCardsV9Response({ updatedAt: NOW });
      const envelope = buildAlertSafetyV9SourceEnvelopeFromParts({ cards: response.cards, safetyScoreIdentity: response.safetyScoreIdentity, publishedAt: response.updatedAt })!;
      const insert = sqlite.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
      const seedHealthy = () => {
        insert.run("alert-safety-v9-source", JSON.stringify(envelope), NOW);
        insert.run("report-cards:v9:publication-health", stableJsonStringifyV1(response.publicationHealth), NOW);
      };
      seedHealthy();
      if (failure === "missing") sqlite.prepare("DELETE FROM cache WHERE key = 'alert-safety-v9-source'").run();
      if (failure === "held") insert.run("report-cards:v9:publication-health", stableJsonStringifyV1({
        ...response.publicationHealth, status: "held", heldSinceSec: NOW, reasons: [{ code: "dex-stale" }],
      }), NOW);
      if (failure === "stale") insert.run("alert-safety-v9-source", JSON.stringify({
        ...envelope, publishedAt: NOW - 6 * 3600 - 1,
      }), NOW);
      const prepare = db.prepare.bind(db);
      const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        const bind = statement.bind.bind(statement);
        statement.bind = (...args: unknown[]) => {
          const bound = bind(...args);
          if (failure === "health-read" && args[0] === "report-cards:v9:publication-health") {
            bound.first = async () => { throw new Error("transient health read"); };
          }
          return bound;
        };
        return statement;
      });
      const row = pendingRow({
        scope: [{ stablecoinId: COIN_ID, family: "safety" }],
        safetyScoreIdentity: response.safetyScoreIdentity,
      });
      try {
        expect(await evaluate(row)).toMatchObject({
          kind: "defer", notBeforeAt: NOW + 300,
          reason: failure === "missing" ? "v9-snapshot-unavailable"
            : failure === "held" ? "v9-publication-held"
            : failure === "stale" ? "v9-snapshot-stale" : "v9-snapshot-read-failed",
        });
      } finally { spy.mockRestore(); }
      seedHealthy();
      expect(await evaluate(row)).toMatchObject({ kind: "eligible" });
      expect(row.expires_at).toBe(NOW + 3_000);
    },
  );

  it("cancels proven incompatible safety build identity", async () => {
    const response = makeWorkerReportCardsV9Response({ updatedAt: NOW });
    const insert = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
    insert.run("alert-safety-v9-source", JSON.stringify(buildAlertSafetyV9SourceEnvelopeFromParts({ cards: response.cards, safetyScoreIdentity: response.safetyScoreIdentity, publishedAt: response.updatedAt })), NOW);
    insert.run("report-cards:v9:publication-health", stableJsonStringifyV1(response.publicationHealth), NOW);
    expect(await evaluate(pendingRow({
      scope: [{ stablecoinId: COIN_ID, family: "safety" }],
      safetyScoreIdentity: { ...response.safetyScoreIdentity, evaluationBuildDigest: "f".repeat(64) },
    }))).toMatchObject({ kind: "cancel", reason: "safety_identity_changed" });
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

  it.each(["personalized_recap", "unsupported"])("cancels unsupported source %s without reading retired feature tables", async (sourceType) => {
    const row = { ...pendingRow(), source_type: sourceType, alert_type: null };
    await expect(evaluate(row)).resolves.toMatchObject({ kind: "cancel", reason: "unsupported_source_type" });
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

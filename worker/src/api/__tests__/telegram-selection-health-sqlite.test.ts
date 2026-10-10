import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { TelegramWebhookOperationIntent } from "../telegram-webhook-store";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { TELEGRAM_ALERT_TYPES } from "@shared/types/status";
import { TELEGRAM_ALERT_PERSISTENCE } from "@shared/lib/telegram-alert-families";
import { TelegramWebhookEffectFence, buildMutationOperations, createTelegramWebhookIntent } from "../telegram-webhook-effect-fence";
import { parseStoredCommandSelectionIntent } from "../telegram-webhook-disambiguation-selection";
import { parseSetCommand } from "../telegram-webhook-parsing";
import { handleSetupBranch } from "../telegram-webhook-setup";
import { loadTelegramMiniAppState } from "../telegram-mini-app-state";
import { applySettingToSubscriptions, loadSubscriptionRowsByChat, upsertSubscriberAndSubscriptions } from "../telegram-store/subscriptions";
import { describeSubscriptionSettings } from "../telegram-webhook-messages";
import { buildPendingAlertEnqueueStatement } from "../../lib/telegram/pending-queue";
import { revalidatePendingAlertPreferences } from "../../cron/telegram-pending/preference-revalidation";
import type { PendingAlertRow } from "../../cron/telegram-pending/types";
import {
  fetchSpy, handleTelegramWebhook, makeCallbackRequest, makeWebhookRequest,
  resetTelegramWebhookTest, sentMessageBody,
} from "./telegram-webhook.test-support";

const NOW = 1_800_000_000;
const fixtures = createLatestSchemaFixtureTracker();
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
  resetTelegramWebhookTest();
});
afterEach(() => {
  fixtures.closeAll();
  vi.useRealTimers();
});

function claim(sqlite: DatabaseSync, updateId = 1): void {
  sqlite.prepare(`INSERT INTO telegram_processed_updates
    (update_id, received_at, update_type, chat_id, status, effect_state, effect_key, claim_owner, claim_generation)
    VALUES (?, ?, 'callback_query', '42', 'processing', 'unstarted', ?, 'old', 1)`)
    .run(updateId, NOW - 600, `telegram-update:${updateId}`);
}

async function recoverSelection(intent: TelegramWebhookOperationIntent): Promise<void> {
  const { sqlite, db } = fixtures.open();
  claim(sqlite);
  const fence = new TelegramWebhookEffectFence(db, 1, { owner: "old", generation: 1 }, undefined, null);
  await fence.plan(intent);
  const normalized = parseStoredCommandSelectionIntent(intent);
  if (!normalized) throw new Error("Invalid regression selection intent");
  const operationStatements = [fence.prepareMutationAppliedStatement()];
  if (normalized.actionType === "subscribe") {
    await upsertSubscriberAndSubscriptions(db, "42", null, new Set(normalized.alertTypes), normalized.initialCoinIds, {
      clearPending: true, operationStatements,
    });
  } else if (normalized.actionType === "set") {
    await applySettingToSubscriptions(db, "42", null, [{ id: "usdc-circle", symbol: "USDC", name: "USD Coin" }],
      normalized.command, { clearPending: true, operationStatements });
  }
  sqlite.prepare(`UPDATE telegram_processed_updates
    SET status = 'failed', mutation_applied_at = ?, received_at = ? WHERE update_id = 1`).run(NOW - 599, NOW - 600);
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_disambiguation").get()).toEqual({ count: 0 });
  const response = await handleTelegramWebhook(db,
    makeCallbackRequest("select:1", { chatId: 42, fromId: 42, updateId: 1 }), "test-secret", "bot-token");
  expect(response.status).toBe(200);
  const calls = fetchSpy.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as { text?: string });
  expect(calls.some((body) => body.text?.includes("Selection expired"))).toBe(false);
  expect(sentMessageBody().text).toContain("USDC");
  expect(sqlite.prepare("SELECT status FROM telegram_processed_updates WHERE update_id = 1").get()).toEqual({ status: "processed" });
}

describe("stored selection family recovery", () => {
  it.each(TELEGRAM_ALERT_TYPES)("recovers applied %s subscribe confirmation after pending deletion", async (family) => {
    const intent = createTelegramWebhookIntent("command:subscribe", {
      coinIds: ["usdc-circle"], alertTypes: [family], presetIds: [], depegWorseningBpsStep: null,
      initiatorUserId: "42", clearPending: true,
    }, "required");
    expect(parseStoredCommandSelectionIntent(intent)).toMatchObject({ alertTypes: [family], initialCoinIds: ["usdc-circle"] });
    await recoverSelection(intent);
  });

  it.each(["dews WARNING", "safety downgrade-only", "depeg off", "launch on", "reserve on", "freeze off", "depeg-step 250"])(
    "recovers applied set %s with original normalized parameters", async (settingArgs) => {
      const parsed = parseSetCommand(`USDC ${settingArgs}`);
      if ("error" in parsed) throw new Error(parsed.error);
      const { ticker: _ticker, ...setting } = parsed;
      const intent = createTelegramWebhookIntent("command:set", {
        coinIds: ["usdc-circle"], setting, initiatorUserId: "42", clearPending: true,
      }, "required");
      expect(parseStoredCommandSelectionIntent(intent)).toMatchObject({ command: { ticker: "USDC", ...setting } });
      await recoverSelection(intent);
    },
  );
});

describe("setup atomic refused transition", () => {
  it.each([false, true])("does not mark or prompt a refused transition after owner replacement (replaced=%s)", async (replaced) => {
    const { sqlite, db } = fixtures.open();
    claim(sqlite);
    const original = { step: "branch" as const, alertTypes: [], target: null, initiatorUserId: "42" };
    sqlite.prepare(`INSERT INTO telegram_pending_disambiguation
      (chat_id, action_type, action_payload, alert_types, resolved_ids, ambiguous_ticker, candidates, remaining_tickers, expires_at, initiator_user_id)
      VALUES ('42', 'setup-step', ?, '[]', '[]', '', '[]', '[]', ?, '42')`)
      .run(JSON.stringify({ step: "branch", alertTypes: [], target: null }), NOW + 300);
    const fence = new TelegramWebhookEffectFence(db, 1, { owner: "old", generation: 1 }, undefined, null);
    const effects = buildMutationOperations(fence, {
      beforeIrreversibleEffect: (kind) => fence.beforeIrreversibleEffect(kind),
    });
    const response = await handleSetupBranch({
      db, chatId: "42", actorUserId: "42", username: null, botToken: "bot-token", ...effects,
      planIntent: async (intent) => {
        // Interleave the replacement after owner validation and before the atomic write.
        if (replaced) sqlite.prepare("UPDATE telegram_pending_disambiguation SET initiator_user_id = '99' WHERE chat_id = '42'").run();
        await effects.planIntent(intent);
      },
    }, "custom", original);
    const row = sqlite.prepare("SELECT initiator_user_id, action_payload FROM telegram_pending_disambiguation WHERE chat_id = '42'").get();
    expect(row?.initiator_user_id).toBe(replaced ? "99" : "42");
    expect(JSON.parse(String(row?.action_payload)).step).toBe(replaced ? "branch" : "custom-types");
    expect(sqlite.prepare("SELECT mutation_applied_at FROM telegram_processed_updates WHERE update_id = 1").get())
      .toEqual({ mutation_applied_at: replaced ? null : NOW });
    if (replaced) {
      expect(response.text).toContain("Setup changed");
      expect(fetchSpy).not.toHaveBeenCalled();
    } else {
      expect(response.text).toBe("Pick alert types.");
      expect(fetchSpy).toHaveBeenCalledOnce();
    }
  });
});

describe("chat queued health", () => {
  it.each([0, 2])("counts only pending work on health and Mini App with %s pending rows", async (pendingCount) => {
    const { sqlite, db } = fixtures.open();
    sqlite.prepare("INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('42', ?, ?)").run(NOW, NOW);
    for (const state of [...Array<string>(pendingCount).fill("pending"), "sending", "sent", "execution_unknown"]) {
      sqlite.prepare(`INSERT INTO telegram_pending_alerts
        (chat_id, message_html, created_at, expires_at, delivery_state) VALUES ('42', 'x', ?, ?, ?)`)
        .run(NOW, NOW + 3600, state);
    }
    await handleTelegramWebhook(db, makeWebhookRequest(42, "/health"), "test-secret", "bot-token");
    expect(sentMessageBody().text).toContain(`Queued alerts for this chat: ${pendingCount}`);
    const state = await loadTelegramMiniAppState(db, {
      userId: "42", username: null, firstName: null, chatType: "private", startParam: null,
      authDate: NOW, initDataHash: "test", canMutatePrivateChat: true,
    }, { nowSec: NOW, mutationMaxAgeSec: 300 });
    expect(state.health.queuedAlerts).toBe(pendingCount);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts").get()).toEqual({ count: pendingCount + 3 });
  });
});

describe("list override projection", () => {
  it.each(["snooze-only", "unmarked", "depeg-off", "all-off"])("matches post-snooze inherited eligibility for %s", async (mode) => {
    const { sqlite, db } = fixtures.open();
    sqlite.prepare(`INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at, global_alert_depeg, global_alert_freeze)
      VALUES ('42', ?, ?, 1, 1)`).run(NOW, NOW);
    sqlite.prepare(`INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_snooze_until_ts)
      VALUES ('42', 'usdc-circle', ?)`).run(mode === "snooze-only" ? NOW + 3600 : null);
    if (mode === "depeg-off" || mode === "all-off") {
      const columns = mode === "all-off"
        ? TELEGRAM_ALERT_TYPES.map((family) => TELEGRAM_ALERT_PERSISTENCE[family].overrideColumn)
        : [TELEGRAM_ALERT_PERSISTENCE.depeg.overrideColumn];
      sqlite.prepare(`UPDATE telegram_subscriptions SET ${columns.map((column) => `${column} = 1`).join(", ")} WHERE chat_id = '42'`).run();
    }
    const [row] = await loadSubscriptionRowsByChat(db, "42");
    const description = describeSubscriptionSettings(row, NOW, { perCoinTag: true });
    if (mode === "all-off") expect(description).toBe("Muted (overrides defaults)");
    else {
      expect(description).toContain("Inherits preset/global defaults");
      expect(description).not.toContain("Muted");
    }
    if (mode === "depeg-off") expect(description).toContain("off: Depeg");
    if (mode === "snooze-only") expect(description).toContain("snoozed for 1 h");
    for (const family of ["depeg", "freeze"] as const) {
      await buildPendingAlertEnqueueStatement(db, {
        chatId: "42", html: family, canonicalHtml: family, chunkIndex: 0,
        disableNotification: false, replyMarkup: undefined, linkPreviewOptions: undefined,
        alertType: family, sourceEventId: `event-${family}`,
        preferenceGeneration: 0, alertScope: [{ stablecoinId: "usdc-circle", family }],
      }, NOW, { ttlSec: 7200 }).run();
    }
    const pending = await db.prepare(`SELECT p.*, s.alert_snooze_until_ts, s.quiet_hours_enabled,
      s.quiet_hours_start_utc, s.quiet_hours_end_utc, s.timezone
      FROM telegram_pending_alerts p JOIN telegram_subscribers s ON p.chat_id = s.chat_id ORDER BY p.id`).all<PendingAlertRow>();
    const outcomes = await revalidatePendingAlertPreferences(db, pending.results, NOW + 3600);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual([
      mode === "depeg-off" || mode === "all-off" ? "cancel" : "eligible",
      mode === "all-off" ? "cancel" : "eligible",
    ]);
  });
});

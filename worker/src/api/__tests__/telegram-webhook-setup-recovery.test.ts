import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { handleCallbackQuery } from "../telegram-webhook-callbacks";
import { handleSetupTickerInput, handleSetupTypeToggle, parseSetupState } from "../telegram-webhook-setup";
import { buildMutationOperations, TelegramWebhookEffectFence } from "../telegram-webhook-effect-fence";
import { claimTelegramProcessedUpdate } from "../telegram-webhook-store";
import {
  fetchSpy, handleTelegramWebhook, latestSendMessageBody, makeCallbackRequest,
  makeStablecoinsCacheValue, makeWebhookRequest, resetTelegramWebhookTest,
} from "./telegram-webhook.test-support";

const fixtures = createLatestSchemaFixtureTracker();
const now = () => Math.floor(Date.now() / 1000);
const interrupted = async () => { throw new Error("interrupted before effect-start persistence"); };
const cases = [
  { data: "setup:branch:custom", step: "branch", alerts: [], target: null, ack: "Pick alert types.", reply: "Pick alert types, then tap Next." },
  { data: "setup:branch:recommended", step: "branch", alerts: [], target: null, ack: "Review and confirm.", reply: "get DEWS and Depeg alerts" },
  { data: "setup:branch:skip", step: "branch", alerts: [], target: null, ack: "OK.", reply: "Command reference" },
  { data: "setup:type-toggle:safety", step: "custom-types", alerts: ["dews"], target: null, ack: "Safety", reply: "Selected: DEWS, Safety" },
  { data: "setup:type-toggle:dews", step: "custom-types", alerts: ["dews", "safety"], target: null, ack: "DEWS", reply: "Selected: Safety" },
  { data: "setup:next", step: "custom-types", alerts: ["dews"], target: null, ack: "Pick a target.", reply: "Pick a target watchlist:" },
  { data: "setup:target:type", step: "custom-target", alerts: ["dews"], target: null, ack: "Type a ticker.", reply: "Reply with a ticker" },
  { data: "setup:target:all", step: "custom-target", alerts: ["dews"], target: null, ack: "Review and confirm.", reply: "across all tracked coins" },
  { data: "setup:target:usd-top25", step: "custom-target", alerts: ["dews"], target: null, ack: "Review and confirm.", reply: "get DEWS alerts for these" },
  { data: "setup:confirm", step: "confirm-custom", alerts: ["dews"], target: { kind: "all" }, ack: "Subscribed.", reply: "Subscribed: DEWS on all tracked coins." },
  { data: "setup:confirm", step: "confirm-recommended", alerts: ["dews", "depeg"], target: { kind: "preset", presetId: "usd-top25" }, ack: "Subscribed.", reply: "USD Top 25" },
  { data: "setup:confirm", step: "confirm-custom", alerts: ["dews"], target: { kind: "ticker", coinId: "usdc-circle", symbol: "USDC" }, ack: "Subscribed.", reply: "Subscribed for USDC." },
  { data: "setup:cancel", step: "custom-types", alerts: ["dews"], target: null, ack: "Cancelled.", reply: "Setup cancelled." },
];

beforeEach(resetTelegramWebhookTest);
afterEach(fixtures.closeAll);

describe("stored setup transition recovery", () => {
  it.each(cases)("resumes $data ($step) after mutation but before effect start", async ({ data, step, alerts, target, ack, reply }) => {
    const { sqlite, db } = fixtures.open();
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/start", "test-secret", { updateId: 1 }), "test-secret", "bot-token");
    sqlite.prepare("UPDATE telegram_pending_disambiguation SET action_payload = ? WHERE chat_id = '123'")
      .run(JSON.stringify({ step, alertTypes: alerts, target }));
    sqlite.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES ('stablecoins', ?, ?)")
      .run(makeStablecoinsCacheValue({}), now());
    sqlite.exec(`
      CREATE TABLE setup_mutation_audit (kind TEXT NOT NULL);
      CREATE TRIGGER setup_pending_insert AFTER INSERT ON telegram_pending_disambiguation BEGIN INSERT INTO setup_mutation_audit VALUES ('pending-insert'); END;
      CREATE TRIGGER setup_pending_update AFTER UPDATE ON telegram_pending_disambiguation BEGIN INSERT INTO setup_mutation_audit VALUES ('pending-update'); END;
      CREATE TRIGGER setup_pending_delete AFTER DELETE ON telegram_pending_disambiguation BEGIN INSERT INTO setup_mutation_audit VALUES ('pending-delete'); END;
      CREATE TRIGGER setup_subscriber_update AFTER UPDATE ON telegram_subscribers BEGIN INSERT INTO setup_mutation_audit VALUES ('subscriber-update'); END;
      CREATE TRIGGER setup_subscriber_insert AFTER INSERT ON telegram_subscribers BEGIN INSERT INTO setup_mutation_audit VALUES ('subscriber-insert'); END;
      CREATE TRIGGER setup_direct_insert AFTER INSERT ON telegram_subscriptions BEGIN INSERT INTO setup_mutation_audit VALUES ('direct-insert'); END;
      CREATE TRIGGER setup_preset_insert AFTER INSERT ON telegram_preset_subscriptions BEGIN INSERT INTO setup_mutation_audit VALUES ('preset-insert'); END;
    `);
    const claim = await claimTelegramProcessedUpdate(db, { updateId: 2, nowSec: now(), updateType: "callback_query", chatId: "123" });
    if (claim.status !== "claimed") throw new Error("Expected first update claim");
    if (claim.claimOwner == null || claim.claimGeneration == null) throw new Error("Expected claimed update fence identity");
    const fence = new TelegramWebhookEffectFence(db, 2, { owner: claim.claimOwner, generation: claim.claimGeneration }, undefined, null);
    const cb = { id: "cb1", data, from: { id: 999, username: "requester" }, message: { chat: { id: 123, type: "private" }, message_id: 1 } };
    resetTelegramWebhookTest();
    await expect(handleCallbackQuery(db, "bot-token", cb, buildMutationOperations(fence, { beforeIrreversibleEffect: interrupted })))
      .rejects.toThrow("interrupted before effect-start persistence");
    expect(fetchSpy).not.toHaveBeenCalled();
    const before = sqlite.prepare("SELECT intent_payload, mutation_applied_at, effect_state FROM telegram_processed_updates WHERE update_id = 2").get();
    expect(before).toMatchObject({ mutation_applied_at: expect.any(Number), effect_state: "planned" });
    const mutations = sqlite.prepare("SELECT COUNT(*) AS count FROM setup_mutation_audit").get();
    expect(Number(mutations?.count)).toBeGreaterThan(0);
    sqlite.prepare("UPDATE telegram_processed_updates SET received_at = ? WHERE update_id = 2").run(now() - 600);
    // A later wizard must not become the source of this update's original response.
    sqlite.prepare("UPDATE telegram_pending_disambiguation SET expires_at = 0 WHERE chat_id = '123'").run();
    const baseline = sqlite.prepare("SELECT COUNT(*) AS count FROM setup_mutation_audit").get();

    const response = await handleTelegramWebhook(db, makeCallbackRequest(data, { updateId: 2 }), "test-secret", "bot-token");
    expect(response.status).toBe(200);
    expect(latestSendMessageBody().text).toContain(reply);
    const ackCall = fetchSpy.mock.calls.find((call) => String(call[0]).includes("answerCallbackQuery"));
    expect(JSON.parse(String(ackCall?.[1]?.body)).text).toBe(ack);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM setup_mutation_audit").get()).toEqual(baseline);
    expect(sqlite.prepare("SELECT intent_payload, mutation_applied_at FROM telegram_processed_updates WHERE update_id = 2").get())
      .toEqual({ intent_payload: before?.intent_payload, mutation_applied_at: before?.mutation_applied_at });
    expect(sqlite.prepare("SELECT status, claim_generation FROM telegram_processed_updates WHERE update_id = 2").get())
      .toEqual({ status: "processed", claim_generation: 2 });
  });

  it("resumes a stored type toggle from message dispatch without a callback argument", async () => {
    const { sqlite, db } = fixtures.open();
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/start", "test-secret", { updateId: 1 }), "test-secret", "bot-token");
    const state = parseSetupState(JSON.stringify({ step: "custom-types", alertTypes: ["dews"], target: null }), "999");
    if (!state) throw new Error("Expected custom types setup state");
    const claim = await claimTelegramProcessedUpdate(db, { updateId: 2, nowSec: now(), updateType: "message", chatId: "123" });
    if (claim.status !== "claimed" || claim.claimOwner == null || claim.claimGeneration == null) {
      throw new Error("Expected claimed update fence identity");
    }
    const fence = new TelegramWebhookEffectFence(db, 2, { owner: claim.claimOwner, generation: claim.claimGeneration }, undefined, null);
    resetTelegramWebhookTest();
    await expect(handleSetupTypeToggle({
      db, botToken: "bot-token", chatId: "123", actorUserId: "999", username: "requester",
      ...buildMutationOperations(fence, { beforeIrreversibleEffect: interrupted }),
    }, "safety", state)).rejects.toThrow("interrupted before effect-start persistence");
    expect(fetchSpy).not.toHaveBeenCalled();
    const before = sqlite.prepare("SELECT intent_payload, mutation_applied_at FROM telegram_processed_updates WHERE update_id = 2").get();
    sqlite.prepare("UPDATE telegram_processed_updates SET received_at = ? WHERE update_id = 2").run(now() - 600);
    sqlite.prepare("DELETE FROM telegram_pending_disambiguation WHERE chat_id = '123'").run();

    const response = await handleTelegramWebhook(db, makeWebhookRequest(123, "continue setup", "test-secret", { updateId: 2 }), "test-secret", "bot-token");
    expect(response.status).toBe(200);
    expect(latestSendMessageBody().text).toBe("Selected: DEWS, Safety");
    expect(sqlite.prepare("SELECT intent_payload, mutation_applied_at FROM telegram_processed_updates WHERE update_id = 2").get()).toEqual(before);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_disambiguation WHERE chat_id = '123'").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT status FROM telegram_processed_updates WHERE update_id = 2").get()).toEqual({ status: "processed" });
  });

  it.each(["", "not-an-alert"])("rejects the fresh type toggle argument %j without effects", async (arg) => {
    const { sqlite, db } = fixtures.open();
    const state = parseSetupState(JSON.stringify({ step: "custom-types", alertTypes: ["dews"], target: null }), "999");
    const result = await handleSetupTypeToggle({
      db, botToken: "bot-token", chatId: "123", actorUserId: "999", username: "requester",
    }, arg, state);
    expect(result).toEqual({ text: "Action not recognized." });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_disambiguation").get()).toEqual({ count: 0 });
  });

  it("resumes a ticker message's stored target after its pending step advanced", async () => {
    const { sqlite, db } = fixtures.open();
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/start", "test-secret", { updateId: 1 }), "test-secret", "bot-token");
    const state = parseSetupState(JSON.stringify({ step: "awaiting-ticker", alertTypes: ["dews"], target: null }), "999");
    if (!state) throw new Error("Expected ticker setup state");
    const claim = await claimTelegramProcessedUpdate(db, { updateId: 2, nowSec: now(), updateType: "message", chatId: "123" });
    if (claim.status !== "claimed") throw new Error("Expected first update claim");
    if (claim.claimOwner == null || claim.claimGeneration == null) throw new Error("Expected claimed update fence identity");
    const fence = new TelegramWebhookEffectFence(db, 2, { owner: claim.claimOwner, generation: claim.claimGeneration }, undefined, null);
    resetTelegramWebhookTest();
    await expect(handleSetupTickerInput({ db, botToken: "bot-token", chatId: "123", actorUserId: "999", username: "requester", ...buildMutationOperations(fence, { beforeIrreversibleEffect: interrupted }) }, "USDC", state))
      .rejects.toThrow("interrupted before effect-start persistence");
    const before = sqlite.prepare("SELECT intent_payload, mutation_applied_at FROM telegram_processed_updates WHERE update_id = 2").get();
    sqlite.prepare("UPDATE telegram_processed_updates SET received_at = ? WHERE update_id = 2").run(now() - 600);
    sqlite.prepare("DELETE FROM telegram_pending_disambiguation WHERE chat_id = '123'").run();
    const response = await handleTelegramWebhook(db, makeWebhookRequest(123, "USDC", "test-secret", { updateId: 2 }), "test-secret", "bot-token");
    expect(response.status).toBe(200);
    expect(latestSendMessageBody().text).toContain("get DEWS alerts for USDC.");
    expect(sqlite.prepare("SELECT intent_payload, mutation_applied_at FROM telegram_processed_updates WHERE update_id = 2").get()).toEqual(before);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_disambiguation WHERE chat_id = '123'").get()).toEqual({ count: 0 });
  });
});

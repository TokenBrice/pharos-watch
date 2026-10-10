import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { telegramAdoptionEntryForPlacement } from "@shared/lib/telegram-adoption-analytics";
import { writeTelegramAdoptionEvent } from "../../lib/telegram/adoption-analytics";
import { parseSetupState } from "../telegram-webhook-setup";
import {
  handleTelegramWebhook, inlineButtons, latestSendMessageBody, makeCallbackRequest,
  makeStablecoinsCacheValue, makeWebhookRequest, resetTelegramWebhookTest,
} from "./telegram-webhook.test-support";

const fixtures = createLatestSchemaFixtureTracker();
beforeEach(resetTelegramWebhookTest);
afterEach(fixtures.closeAll);

describe("setup adoption state", () => {
  it("preserves only an allowlisted setup token through the short-lived wizard state", () => {
    const base = { step: "branch", alertTypes: [], target: null };
    expect(parseSetupState(JSON.stringify({ ...base, adoptionToken: "pw1_landing_hero" }), "42"))
      .toMatchObject({ adoptionToken: "pw1_landing_hero", initiatorUserId: "42" });
    expect(parseSetupState(JSON.stringify({ ...base, adoptionToken: "pw1_landing_arbitrary" }), "42"))
      .toMatchObject({ adoptionToken: null, initiatorUserId: "42" });
    expect(parseSetupState(JSON.stringify({ ...base, adoptionToken: "pw1_landing_miniapp_home" }), "42"))
      .toMatchObject({ adoptionToken: null, initiatorUserId: "42" });
  });

  it("keeps landing/setup attribution from click through immediate recommended confirmation and first follow", async () => {
    const { sqlite, db } = fixtures.open();
    const nowSec = Math.floor(Date.now() / 1_000);
    const entry = telegramAdoptionEntryForPlacement("setup");
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('stablecoins', ?, ?)")
      .run(makeStablecoinsCacheValue({}), nowSec);
    await writeTelegramAdoptionEvent(db, { campaign: entry.campaign, placement: entry.placement, stage: "cta_click", nowSec });
    await handleTelegramWebhook(db, makeWebhookRequest(123, `/start ${entry.token}`, "test-secret", { updateId: 1 }), "test-secret", "bot-token");

    const pending = sqlite.prepare("SELECT action_type, action_payload, initiator_user_id FROM telegram_pending_disambiguation WHERE chat_id = '123'").get();
    expect(pending?.action_type).toBe("setup-step");
    const state = parseSetupState(String(pending?.action_payload), String(pending?.initiator_user_id));
    expect(state).toMatchObject({
      step: "confirm-recommended",
      alertTypes: ["dews", "depeg"],
      target: { kind: "preset", presetId: "usd-top25" },
      adoptionToken: entry.token,
    });
    const buttons = inlineButtons(latestSendMessageBody());
    expect(buttons.map((button) => button.callback_data)).toEqual(["setup:confirm", "setup:cancel"]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_preset_subscriptions").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_subscriptions").get()).toEqual({ count: 0 });

    await handleTelegramWebhook(db, makeCallbackRequest("setup:confirm", { updateId: 2 }), "test-secret", "bot-token");
    expect(sqlite.prepare("SELECT preset_id, alert_dews, alert_depeg, alert_safety FROM telegram_preset_subscriptions WHERE chat_id = '123'").get())
      .toEqual({ preset_id: "usd-top25", alert_dews: 1, alert_depeg: 1, alert_safety: 0 });
    expect(sqlite.prepare("SELECT campaign, placement, stage, count FROM telegram_adoption_daily ORDER BY stage").all()).toEqual([
      { campaign: "landing", placement: "setup", stage: "bot_start", count: 1 },
      { campaign: "landing", placement: "setup", stage: "cta_click", count: 1 },
      { campaign: "landing", placement: "setup", stage: "first_follow", count: 1 },
      { campaign: "landing", placement: "setup", stage: "setup_complete", count: 1 },
    ]);
  });

  it("keeps a generic sub link organic rather than inferring landing attribution", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('stablecoins', ?, ?)")
      .run(makeStablecoinsCacheValue({}), Math.floor(Date.now() / 1_000));
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/start sub_dews-depeg_usd-top25", "test-secret", { updateId: 1 }), "test-secret", "bot-token");
    expect(sqlite.prepare("SELECT campaign, placement, stage FROM telegram_adoption_daily").all())
      .toEqual([{ campaign: "organic", placement: "unknown", stage: "bot_start" }]);
    expect(sqlite.prepare("SELECT action_type FROM telegram_pending_disambiguation WHERE chat_id = '123'").get())
      .toEqual({ action_type: "confirm-bulk" });
    await handleTelegramWebhook(db, makeCallbackRequest("confirm:bulk", { updateId: 2 }), "test-secret", "bot-token");
    expect(sqlite.prepare("SELECT campaign, placement, stage FROM telegram_adoption_daily ORDER BY stage").all()).toEqual([
      { campaign: "organic", placement: "unknown", stage: "bot_start" },
    ]);
    expect(sqlite.prepare("SELECT preset_id FROM telegram_preset_subscriptions WHERE chat_id = '123'").get())
      .toEqual({ preset_id: "usd-top25" });
  });
});

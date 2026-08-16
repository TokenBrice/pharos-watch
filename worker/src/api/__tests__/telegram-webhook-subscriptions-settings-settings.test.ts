import { beforeEach, describe, expect, it, vi } from "vitest";


import {
  handleTelegramWebhook,
  resolveTicker,
  makeWebhookRequest,
  sentMessageBody,
  expectMiniAppButton,
  resetTelegramWebhookTest,
  fixtureMockD1 as baseFixtureMockD1,
} from "./telegram-webhook.test-support";

function fixtureMockD1(
  tables: Parameters<typeof baseFixtureMockD1>[0] = [],
  options: Parameters<typeof baseFixtureMockD1>[1] = {},
) {
  return baseFixtureMockD1([
    ...tables,
    { match: "FROM telegram_subscribers", rows: [], first: null },
    { match: "FROM telegram_subscriptions", rows: [] },
    { match: "FROM telegram_preset_subscriptions", rows: [] },
    { match: "FROM telegram_pending_disambiguation", rows: [], first: null },
    { match: "FROM telegram_pending_alerts", rows: [], first: null },
    { match: "FROM telegram_recap_preferences", rows: [], first: null },
    { match: "FROM telegram_recap_targets", rows: [] },
    { match: "FROM cache", rows: [], first: null },
    { match: "FROM dex_liquidity", rows: [], first: null },
    { match: "FROM yield_data", rows: [], first: null },
    { match: "INSERT INTO telegram_subscribers", rows: [] },
    { match: "UPDATE telegram_subscribers", rows: [] },
    { match: "DELETE FROM telegram_subscribers", rows: [] },
    { match: "INSERT INTO telegram_subscriptions", rows: [] },
    { match: "UPDATE telegram_subscriptions", rows: [] },
    { match: "DELETE FROM telegram_subscriptions", rows: [] },
    { match: "INSERT INTO telegram_preset_subscriptions", rows: [] },
    { match: "DELETE FROM telegram_preset_subscriptions", rows: [] },
    { match: "INSERT INTO telegram_pending_disambiguation", rows: [] },
    { match: "UPDATE telegram_pending_disambiguation", rows: [] },
    { match: "DELETE FROM telegram_pending_disambiguation", rows: [] },
    { match: "INSERT INTO telegram_pending_alerts", rows: [] },
    { match: "DELETE FROM telegram_pending_alerts", rows: [] },
    { match: "INSERT INTO telegram_recap_preferences", rows: [] },
    { match: "UPDATE telegram_recap_preferences", rows: [] },
    { match: "DELETE FROM telegram_recap_preferences", rows: [] },
    { match: "DELETE FROM telegram_recap_targets", rows: [] },
    { match: "INSERT INTO telegram_usage_daily", rows: [] },
    { match: "INSERT OR IGNORE INTO telegram_processed_updates", rows: [], runMeta: { changes: 1 } },
    { match: "UPDATE telegram_processed_updates", rows: [], runMeta: { changes: 1 } },
    { match: "INSERT INTO cache", rows: [] },
    { match: "INSERT OR REPLACE INTO cache", rows: [] },
    { match: "UPDATE cache", rows: [] },
    { match: "DELETE FROM cache", rows: [] },
  ], options);
}

// Webhook tests exercise command routing, so stub the canonical V9 loader with
// one matching card (the fail-closed paths have their own focused tests).
vi.mock("../../lib/safety-score-active-source", async () => {
  const { makeWorkerReportCardsV9Response, makeWorkerV9Card } = await import(
    "../../test-helpers/report-cards-v9"
  );
  const snapshot = makeWorkerReportCardsV9Response({
    updatedAt: 1_700_000_000,
    cards: [makeWorkerV9Card({ id: "usdc-circle", grade: "A", score: 85 })],
  });
  return {
    loadActiveSafetyScoreSource: vi.fn(async () => ({
      kind: "v9",
      snapshot,
    })),
  };
});

describe("handleTelegramWebhook", () => {
  beforeEach(resetTelegramWebhookTest);

  it("handles /set for a unique ticker", async () => {
    const db = fixtureMockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM telegram_subscriptions",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            alert_dews: 1,
            alert_depeg: 0,
            alert_safety: 0,
            dews_min_band: "WARNING",
            safety_mode: null,
            depeg_worsening_bps_step: null,
          },
        ],
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/set USDC dews WARNING"), "test-secret", "bot-token");

    const body = sentMessageBody();
    expect(body.text).toContain("Updated settings");
    expect(body.text).toContain("DEWS&gt;=WARNING");
    expectMiniAppButton(body, "Open in app", "coin_usdc-circle");
  });

  it("handles /set all for global alert flags", async () => {
    const db = fixtureMockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM telegram_subscribers",
        rows: [],
        first: {
          alert_dews: 0,
          alert_depeg: 0,
          alert_safety: 0,
          global_alert_dews: 1,
          global_alert_depeg: 0,
          global_alert_safety: 0,
          quiet_hours_enabled: 0,
          quiet_hours_start_utc: null,
          quiet_hours_end_utc: null,
        },
      },
      {
        match: "FROM telegram_subscribers",
        matchBinds: ["123"],
        rows: [],
        first: {
          alert_dews: 0,
          alert_depeg: 0,
          alert_safety: 0,
          global_alert_dews: 1,
          global_alert_depeg: 0,
          global_alert_safety: 0,
          quiet_hours_enabled: 0,
          quiet_hours_start_utc: null,
          quiet_hours_end_utc: null,
        },
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/set all depeg off"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("global_alert_depeg = excluded.global_alert_depeg"))).toBe(true);
    const body = sentMessageBody();
    expect(body.text).toContain("Updated all-stablecoin alerts");
    expectMiniAppButton(body, "Open in app", "watchlist");
  });

  it("handles /set all depeg-step for global worsening alerts", async () => {
    const db = fixtureMockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM telegram_subscribers",
        rows: [],
        first: {
          alert_dews: 0,
          alert_depeg: 0,
          alert_safety: 0,
          alert_launch: 0,
          global_alert_dews: 0,
          global_alert_depeg: 1,
          global_alert_safety: 0,
          global_alert_launch: 0,
          global_depeg_worsening_bps_step: 250,
          quiet_hours_enabled: 0,
          quiet_hours_start_utc: null,
          quiet_hours_end_utc: null,
        },
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/set all depeg-step 250"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("global_alert_depeg"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("global_depeg_worsening_bps_step = ?"))).toBe(true);
    expect(history.some((entry) => entry.binds.includes(250))).toBe(true);
    expect(sentMessageBody().text).toContain("Updated all-stablecoin alerts");
    expect(sentMessageBody().text).toContain("Depeg +250bps");
  });

  it("shows global alert coverage in /list", async () => {
    const db = fixtureMockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM telegram_subscribers",
        rows: [],
        first: {
          alert_dews: 0,
          alert_depeg: 0,
          alert_safety: 0,
          global_alert_dews: 0,
          global_alert_depeg: 1,
          global_alert_safety: 1,
          quiet_hours_enabled: 0,
          quiet_hours_start_utc: null,
          quiet_hours_end_utc: null,
        },
      },
      { match: "FROM telegram_subscriptions", rows: [] },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/list"), "test-secret", "bot-token");

    const text = sentMessageBody().text;
    expect(text).toContain("All stablecoins: Depeg, Safety (downgrades; 3-point drop when scored)");
    expect(text).toContain("Coins (0):");
  });

  it("handles /mute quiet hours", async () => {
    const db = fixtureMockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/mute 22-07"), "test-secret", "bot-token");

    const text = sentMessageBody().text;
    expect(text).toContain("Quiet hours enabled");
    expect(text).toContain("22:00–07:00 UTC");
  });

  it("/unsnooze clears alert snooze and offers private Mini App controls", async () => {
    const db = fixtureMockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/unsnooze"), "test-secret", "bot-token");

    expect(
      db.getHistory().some((entry) => entry.sql.includes("alert_snooze_until_ts = NULL") && entry.binds[0] === "123"),
    ).toBe(true);
    const body = sentMessageBody();
    expect(body.text).toContain("Alert snooze cleared");
    expectMiniAppButton(body, "Open in app", "snooze");
  });

  it("/timezone <zone> persists a valid IANA zone", async () => {
    const db = fixtureMockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/timezone Europe/Paris"),
      "test-secret",
      "bot-token",
    );
    expect(res.status).toBe(200);

    const upsert = db
      .getHistory()
      .find((h) => /INSERT INTO telegram_subscribers/.test(h.sql) && h.binds.includes("Europe/Paris"));
    expect(upsert).toBeDefined();
    const body = sentMessageBody();
    expect(body.text).toContain("Timezone set to Europe/Paris");
    expectMiniAppButton(body, "Open in app", "quiet-hours");
  });

  it("/timezone rejects unknown zones without writing to D1", async () => {
    const db = fixtureMockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/timezone Mars/Olympus_Mons"),
      "test-secret",
      "bot-token",
    );
    expect(res.status).toBe(200);
    const wrote = db
      .getHistory()
      .some((h) => /INSERT INTO telegram_subscribers/.test(h.sql) && h.binds.includes("Mars/Olympus_Mons"));
    expect(wrote).toBe(false);
    expect(sentMessageBody().text).toContain("Unknown timezone");
  });

  it("/timezone with no argument shows current zone and an inline keyboard", async () => {
    const db = fixtureMockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM telegram_subscribers",
        rows: [],
        first: {
          alert_dews: 0,
          alert_depeg: 0,
          alert_safety: 0,
          alert_launch: 0,
          global_alert_dews: 0,
          global_alert_depeg: 0,
          global_alert_safety: 0,
          global_alert_launch: 0,
          global_depeg_worsening_bps_step: null,
          quiet_hours_enabled: 0,
          quiet_hours_start_utc: null,
          quiet_hours_end_utc: null,
          timezone: "Europe/Paris",
          alert_snooze_until_ts: null,
          consecutive_block_count: 0,
          consecutive_block_first_at: null,
        },
      },
    ]);
    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/timezone"), "test-secret", "bot-token");
    expect(res.status).toBe(200);
    const sent = sentMessageBody() as {
      text: string;
      reply_markup?: {
        inline_keyboard?: Array<Array<{ text: string; callback_data?: string; web_app?: { url: string } }>>;
      };
    };
    expect(sent.text).toContain("Current timezone: Europe/Paris");
    const flat = (sent.reply_markup?.inline_keyboard ?? []).flat();
    expect(flat.some((btn) => btn.callback_data === "tz:UTC")).toBe(true);
    expect(flat.some((btn) => btn.callback_data === "tz:Europe/Paris")).toBe(true);
    expectMiniAppButton(sent, "Open in app", "quiet-hours");
  });

  it("finalizes pending /set disambiguation with the shared completion handler", async () => {
    const ambiguous = resolveTicker("USDF");
    const usdc = resolveTicker("USDC");
    if (ambiguous.status !== "ambiguous" || usdc.status !== "unique") {
      throw new Error("Expected fixed ticker fixtures for telegram set disambiguation flow test");
    }

    const db = fixtureMockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "set",
          action_payload: JSON.stringify({ ticker: "USDF", setting: "dews", enabled: true, minBand: "WARNING" }),
          alert_types: JSON.stringify([]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "USDF",
          candidates: JSON.stringify(ambiguous.matches),
          remaining_tickers: JSON.stringify(["USDC"]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
        },
      },
      {
        match: "FROM telegram_subscriptions",
        matchBinds: ["123", ambiguous.matches[0].id, usdc.matches[0].id],
        rows: [
          {
            stablecoin_id: ambiguous.matches[0].id,
            alert_dews: 1,
            alert_depeg: 0,
            alert_safety: 0,
            dews_min_band: "WARNING",
            safety_mode: null,
            depeg_worsening_bps_step: null,
          },
          {
            stablecoin_id: usdc.matches[0].id,
            alert_dews: 1,
            alert_depeg: 0,
            alert_safety: 0,
            dews_min_band: "WARNING",
            safety_mode: null,
            depeg_worsening_bps_step: null,
          },
        ],
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "1"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
    expect(
      history
        .filter((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))
        .map((entry) => entry.binds[1]),
    ).toEqual([ambiguous.matches[0].id, usdc.matches[0].id]);

    const text = sentMessageBody().text;
    expect(text).toContain("Updated settings");
    expect(text).toContain("DEWS&gt;=WARNING");
  });

  it("/mute does not overwrite alert flags on ON CONFLICT", async () => {
    const db = fixtureMockD1([{ match: "SELECT action_type, action_payload", rows: [], first: null }]);
    const res = await handleTelegramWebhook(db, makeWebhookRequest(42, "/mute 22-07"), "test-secret", "bot-token");
    expect(res.status).toBe(200);
    const subscriberUpsert = db
      .getHistory()
      .find((h) => /INSERT INTO telegram_subscribers/.test(h.sql) && /ON CONFLICT\(chat_id\)/.test(h.sql));
    expect(subscriberUpsert).toBeDefined();
    const updateClause = subscriberUpsert!.sql.split("DO UPDATE SET")[1] ?? "";
    expect(updateClause).not.toMatch(/\balert_dews\s*=\s*excluded\.alert_dews\b/);
    expect(updateClause).not.toMatch(/\balert_depeg\s*=\s*excluded\.alert_depeg\b/);
    expect(updateClause).not.toMatch(/\balert_safety\s*=\s*excluded\.alert_safety\b/);
    expect(updateClause).not.toMatch(/\balert_launch\s*=\s*excluded\.alert_launch\b/);
    expect(updateClause).not.toMatch(/\bglobal_alert_safety\s*=\s*excluded\./);
    expect(updateClause).toContain("quiet_hours_enabled = excluded.quiet_hours_enabled");
  });
});

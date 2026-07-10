import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { TELEGRAM_MESSAGE_CHUNK_LIMIT } from "../../lib/telegram-constants";
import { MAX_WATCHLIST_TOKEN_CHARS } from "../../lib/telegram-watchlist-token";
import {
  fetchSpy,
  handleTelegramWebhook,
  resolveTicker,
  FROZEN_STABLECOINS,
  encodeWatchlistToken,
  makeWebhookRequest,
  makeCallbackRequest,
  sentMessageBody,
  expectMiniAppButton,
  makeStablecoinsCacheValue,
  resetTelegramWebhookTest,
  fixtureMockD1,
} from "./telegram-webhook.test-support";

describe("handleTelegramWebhook", () => {
  beforeEach(resetTelegramWebhookTest);
  it("handles /subscribe happy path with unique ticker", async () => {
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
            dews_min_band: null,
            safety_mode: null,
            depeg_worsening_bps_step: null,
          },
        ],
      },
    ]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe dews USDC"), "test-secret", "bot-token");

    expect(sentMessageBody().text).toContain("Updated subscriptions");
    expect(sentMessageBody().text).toContain("USDC");
  });

  it("handles /subscribe launch for a pre-launch ticker and includes Launch in the summary", async () => {
    const launchTarget = resolveTicker("USDPT");
    if (launchTarget.status !== "unique") {
      throw new Error("Expected USDPT to resolve uniquely for launch subscription test");
    }

    const db = fixtureMockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM telegram_subscriptions",
        rows: [
          {
            stablecoin_id: launchTarget.matches[0].id,
            alert_dews: 0,
            alert_depeg: 0,
            alert_safety: 0,
            alert_launch: 1,
            dews_min_band: null,
            safety_mode: null,
            depeg_worsening_bps_step: null,
          },
        ],
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe launch USDPT"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(
      history.some(
        (entry) =>
          entry.sql.includes("INSERT INTO telegram_subscriptions") && entry.binds[1] === launchTarget.matches[0].id,
      ),
    ).toBe(true);
    const subscriptionsQuery = history.find((entry) => entry.sql.includes("FROM telegram_subscriptions"));
    expect(subscriptionsQuery?.sql).toContain("alert_launch");
    expect(sentMessageBody().text).toContain("Launch");
    expect(sentMessageBody().text).toContain("USDPT");
  });

  it("gates /subscribe ... all behind a confirmation prompt", async () => {
    const db = fixtureMockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe dews safety all"), "test-secret", "bot-token");

    const history = db.getHistory();
    // No global_alert_* upsert happens until the user taps Confirm.
    expect(history.some((entry) => /UPDATE.*global_alert_dews/.test(entry.sql))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(false);
    const confirmInsert = history.find((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    expect(confirmInsert).toBeDefined();
    expect(confirmInsert!.binds).toContain("confirm-bulk");
    const pending = JSON.parse(confirmInsert!.binds[2] as string) as { coinIds: string[]; presetIds: string[] };
    expect(pending.coinIds).toEqual([]);
    expect(pending.presetIds).toEqual([]);
    const body = sentMessageBody();
    expect(body.text).toContain("Confirm?");
    expect(body.text).toMatch(/subscribe \d+ coins/);
    expect(body.reply_markup).toBeDefined();
  });

  it("subscribe reserve all (after Confirm) writes the global reserve flag", async () => {
    const db = fixtureMockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "confirm-bulk",
          action_payload: JSON.stringify({
            kind: "subscribe",
            alertTypes: ["reserve"],
            coinIds: [],
            presetIds: [],
            subscribeAll: true,
          }),
          alert_types: JSON.stringify([]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "",
          candidates: JSON.stringify([]),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "999",
        },
      },
    ]);

    await handleTelegramWebhook(
      db,
      makeCallbackRequest("confirm:bulk", { chatId: 123, fromId: 999, fromUsername: "requester" }),
      "test-secret",
      "bot-token",
    );

    const subscriberUpsert = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO telegram_subscribers"));
    expect(subscriberUpsert).toBeDefined();
    expect(subscriberUpsert!.sql).toContain("global_alert_reserve = MAX");
    expect(subscriberUpsert!.binds[11]).toBe(1);
  });

  it("gates /subscribe with a >10-coin preset behind a confirmation prompt", async () => {
    const db = fixtureMockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["stablecoins"],
        rows: [],
        first: {
          value: makeStablecoinsCacheValue({
            "usdt-tether": 100_000_000_000,
            "usdc-circle": 90_000_000_000,
            "dai-makerdao": 5_000_000_000,
          }),
          updated_at: 1_700_000_000,
        },
      },
    ]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe dews usd-top25"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("FROM cache WHERE key = ?"))).toBe(true);
    // Deferred — no subscription rows are written until the user taps Confirm.
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(false);
    const confirmInsert = history.find((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    expect(confirmInsert).toBeDefined();
    expect(confirmInsert!.binds).toContain("confirm-bulk");
    const pending = JSON.parse(confirmInsert!.binds[2] as string) as { coinIds: string[]; presetIds: string[] };
    expect(pending.coinIds).toEqual([]);
    expect(pending.presetIds).toEqual(["usd-top25"]);
    const body = sentMessageBody();
    expect(body.text).toContain("Confirm?");
    expect(body.reply_markup).toBeDefined();
  });

  it("includes preset work in preset-only /import confirmation copy", async () => {
    const token = encodeWatchlistToken({
      coinIds: [],
      alertTypes: ["dews", "reserve"],
      presetIds: ["usd-top25"],
    });
    const db = fixtureMockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, `/import ${token}`), "test-secret", "bot-token");

    const history = db.getHistory();
    const confirmInsert = history.find((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    expect(confirmInsert).toBeDefined();
    const payload = JSON.parse(String(confirmInsert?.binds[2] ?? "{}")) as {
      coinIds: string[];
      presetIds: string[];
      alertTypes: string[];
    };
    expect(payload.coinIds).toEqual([]);
    expect(payload.presetIds).toEqual(["usd-top25"]);
    expect(payload.alertTypes).toEqual(["dews", "reserve"]);

    const body = sentMessageBody();
    expect(body.text).toContain("1 preset");
    expect(body.text).toContain("Presets: USD Top 25");
    expect(body.text).not.toContain("0 coins");
    expect(body.reply_markup).toBeDefined();
  });

  it("counts unavailable ids in /import copy while deduping subscribable ids", async () => {
    const token = encodeWatchlistToken({
      coinIds: ["usdc-circle", "usdc-circle", "retired-stablecoin"],
      alertTypes: ["dews"],
      presetIds: [],
    });
    const db = fixtureMockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, `/import ${token}`), "test-secret", "bot-token");

    const confirmInsert = db
      .getHistory()
      .find((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    expect(confirmInsert).toBeDefined();
    const payload = JSON.parse(String(confirmInsert?.binds[2] ?? "{}")) as {
      coinIds: string[];
      presetIds: string[];
      alertTypes: string[];
    };
    expect(payload.coinIds).toEqual(["usdc-circle"]);
    expect(payload.presetIds).toEqual([]);
    expect(payload.alertTypes).toEqual(["dews"]);

    const body = sentMessageBody();
    expect(body.text).toContain("Confirm?");
    expect(body.text).toContain("USDC");
    expect(body.text).toContain("(1 coin is not available for new alerts and was skipped.)");
    expect(body.text).not.toContain("(2 coins are not available");
    expect(body.reply_markup).toBeDefined();
  });

  it("filters frozen ids from /import without staging subscription writes", async () => {
    const frozen = FROZEN_STABLECOINS[0];
    if (!frozen) throw new Error("Expected a frozen stablecoin fixture");
    const token = encodeWatchlistToken({
      coinIds: ["usdc-circle", frozen.id],
      alertTypes: ["dews"],
      presetIds: [],
    });
    const db = fixtureMockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, `/import ${token}`), "test-secret", "bot-token");

    const confirmInsert = db
      .getHistory()
      .find((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    expect(confirmInsert).toBeDefined();
    const payload = JSON.parse(String(confirmInsert?.binds[2] ?? "{}")) as { coinIds: string[] };
    expect(payload.coinIds).toEqual(["usdc-circle"]);
    expect(sentMessageBody().text).toContain("1 coin is not available for new alerts");
    expect(sentMessageBody().text).not.toContain(frozen.symbol);
  });

  it("rejects a frozen-only /import without creating pending state", async () => {
    const frozen = FROZEN_STABLECOINS[0];
    if (!frozen) throw new Error("Expected a frozen stablecoin fixture");
    const token = encodeWatchlistToken({
      coinIds: [frozen.id],
      alertTypes: ["dews"],
      presetIds: [],
    });
    const db = fixtureMockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, `/import ${token}`), "test-secret", "bot-token");

    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"))).toBe(false);
    expect(sentMessageBody().text).toContain("No coins available for new alerts");
  });

  it("refuses a maximum-current-registry /export instead of emitting an unimportable token", async () => {
    const subscriptions = [...TRACKED_META_BY_ID.keys()].map((stablecoinId) => ({
      stablecoin_id: stablecoinId,
      alert_dews: 1,
      alert_depeg: 1,
      alert_safety: 0,
      alert_launch: 0,
      alert_reserve: 0,
      dews_min_band: null,
      safety_mode: null,
      depeg_worsening_bps_step: null,
      alert_snooze_until_ts: null,
    }));
    const unsafeToken = encodeWatchlistToken({
      coinIds: subscriptions.map((row) => row.stablecoin_id),
      alertTypes: ["dews", "depeg"],
      presetIds: [],
    });
    expect(unsafeToken.length).toBeGreaterThan(MAX_WATCHLIST_TOKEN_CHARS);

    const db = fixtureMockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "FROM telegram_subscriptions", rows: subscriptions },
      { match: "FROM telegram_preset_subscriptions", rows: [] },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/export"), "test-secret", "bot-token");

    const body = sentMessageBody();
    expect(body.text).toContain("too large for the current copy-paste export format");
    expect(body.text).toContain(`${subscriptions.length} explicit coin follows`);
    expect(body.text).toContain("no token was sent");
    expect(body.text).not.toContain("<pre>");
  });

  it("refuses a decodable token when its copyable /export block would be split", async () => {
    const stablecoinId = "x".repeat(2_960);
    const token = encodeWatchlistToken({ coinIds: [stablecoinId], alertTypes: ["dews"], presetIds: [] });
    expect(token.length).toBeLessThanOrEqual(MAX_WATCHLIST_TOKEN_CHARS);
    expect(token.length + "<pre></pre>".length).toBeGreaterThan(TELEGRAM_MESSAGE_CHUNK_LIMIT);

    const db = fixtureMockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM telegram_subscriptions",
        rows: [{
          stablecoin_id: stablecoinId,
          alert_dews: 1,
          alert_depeg: 0,
          alert_safety: 0,
          alert_launch: 0,
          alert_reserve: 0,
          dews_min_band: null,
          safety_mode: null,
          depeg_worsening_bps_step: null,
          alert_snooze_until_ts: null,
        }],
      },
      { match: "FROM telegram_preset_subscriptions", rows: [] },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/export"), "test-secret", "bot-token");

    const body = sentMessageBody();
    expect(body.text).toContain("too large for the current copy-paste export format");
    expect(body.text).not.toContain(token);
  });

  it("gates /subscribe with a >10-coin preset and depeg-step modifier behind a confirmation prompt", async () => {
    const db = fixtureMockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["stablecoins"],
        rows: [],
        first: {
          value: makeStablecoinsCacheValue({
            "usdt-tether": 100_000_000_000,
            "usdc-circle": 90_000_000_000,
            "dai-makerdao": 5_000_000_000,
          }),
          updated_at: 1_700_000_000,
        },
      },
    ]);
    await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/subscribe usd-top-50 depeg-step 250"),
      "test-secret",
      "bot-token",
    );

    const history = db.getHistory();
    // Deferred — the depeg-step modifier is preserved in the pending payload.
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(false);
    const confirmInsert = history.find((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    expect(confirmInsert).toBeDefined();
    const payload = JSON.parse(confirmInsert!.binds[2] as string) as {
      kind: string;
      depegWorseningBpsStep: number;
      coinIds: string[];
    };
    expect(payload.kind).toBe("subscribe");
    expect(payload.depegWorseningBpsStep).toBe(250);
    expect(payload.coinIds).toEqual([]);
    expect(sentMessageBody().text).toContain("Confirm?");
  });

  it("handles /subscribe with a dashed preset alias (still gated above threshold)", async () => {
    const db = fixtureMockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["stablecoins"],
        rows: [],
        first: {
          value: makeStablecoinsCacheValue({
            "usdt-tether": 100_000_000_000,
            "usdc-circle": 90_000_000_000,
            "dai-makerdao": 5_000_000_000,
          }),
          updated_at: 1_700_000_000,
        },
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe dews usd-top-25"), "test-secret", "bot-token");

    expect(sentMessageBody().text).toContain("Confirm?");
    // The dashed alias was canonicalized before being stored in the pending payload.
    const confirmInsert = db
      .getHistory()
      .find((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    expect(confirmInsert).toBeDefined();
    const payload = JSON.parse(confirmInsert!.binds[2] as string) as { presetIds: string[]; coinIds: string[] };
    expect(payload.presetIds).toEqual(["usd-top25"]);
    expect(payload.coinIds).toEqual([]);
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(false);
  });

  it("rejects preset watchlists for launch alerts", async () => {
    const db = fixtureMockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe launch usd-top25"), "test-secret", "bot-token");

    expect(sentMessageBody().text).toContain("Preset watchlists support dews, depeg, and safety only");
  });

  it("rejects mixing all with preset targets", async () => {
    const db = fixtureMockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/subscribe dews all usd-top25"),
      "test-secret",
      "bot-token",
    );

    expect(sentMessageBody().text).toContain("Use either &quot;all&quot; or specific tickers/presets");
  });

  it("handles /subscribe with unknown ticker", async () => {
    const db = fixtureMockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe dews XYZZY"), "test-secret", "bot-token");

    const text = sentMessageBody().text;
    expect(text).toContain("Ticker");
    expect(text.toLowerCase()).toContain("not found");
    expect(text).toContain("/presets");
  });

  it("handles /subscribe with ambiguous ticker (disambiguation)", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to be ambiguous for disambiguation test");
    }

    const db = fixtureMockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe dews USDF"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"))).toBe(true);
    const pendingInsert = history.find((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    expect(pendingInsert?.binds).toContain("999");
    const body = sentMessageBody() as {
      text: string;
      reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> };
    };
    expect(body.text).toContain("matches");
    const buttons = (body.reply_markup?.inline_keyboard ?? []).flat();
    expect(buttons.some((button) => button.text.startsWith("1.") && button.callback_data === "select:1")).toBe(true);
  });

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

  it("finalizes pending disambiguation and continues remaining tickers", async () => {
    const ambiguous = resolveTicker("USDF");
    const usdc = resolveTicker("USDC");
    if (ambiguous.status !== "ambiguous" || usdc.status !== "unique") {
      throw new Error("Expected fixed ticker fixtures for telegram disambiguation flow test");
    }

    const db = fixtureMockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          alert_types: JSON.stringify(["dews"]),
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
            dews_min_band: null,
            safety_mode: null,
            depeg_worsening_bps_step: null,
          },
          {
            stablecoin_id: usdc.matches[0].id,
            alert_dews: 1,
            alert_depeg: 0,
            alert_safety: 0,
            dews_min_band: null,
            safety_mode: null,
            depeg_worsening_bps_step: null,
          },
        ],
      },
    ]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "1"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);

    const insertedIds = history
      .filter((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))
      .map((entry) => String(entry.binds[1]))
      .sort();
    expect(insertedIds).toEqual([ambiguous.matches[0].id, usdc.matches[0].id].sort());

    const text = sentMessageBody().text;
    expect(text).toContain("Updated subscriptions");
    expect(text).toContain(ambiguous.matches[0].id);
    expect(text).toContain(usdc.matches[0].id);
  });

  it("preserves depeg-step when completing a pending subscribe disambiguation", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to be ambiguous for depeg-step disambiguation flow test");
    }

    const db = fixtureMockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: JSON.stringify({
            alertTypes: ["depeg"],
            presetIds: [],
            depegWorseningBpsStep: 250,
          }),
          alert_types: JSON.stringify(["depeg"]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "USDF",
          candidates: JSON.stringify(ambiguous.matches),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "999",
        },
      },
      {
        match: "FROM telegram_subscriptions",
        rows: [
          {
            stablecoin_id: ambiguous.matches[0].id,
            alert_dews: 0,
            alert_depeg: 1,
            alert_safety: 0,
            alert_launch: 0,
            dews_min_band: null,
            safety_mode: null,
            depeg_worsening_bps_step: 250,
          },
        ],
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "1"), "test-secret", "bot-token");

    const insert = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"));
    expect(insert?.binds).toContain(250);
    expect(sentMessageBody().text).toContain("Depeg +250bps");
  });

  it("blocks another group member from completing a pending selection", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to be ambiguous for group ownership test");
    }

    const db = fixtureMockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: JSON.stringify({ alertTypes: ["dews"] }),
          alert_types: JSON.stringify(["dews"]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "USDF",
          candidates: JSON.stringify(ambiguous.matches),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "111",
        },
      },
    ]);

    await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "1", "test-secret", { chatType: "supergroup", fromId: 222 }),
      "test-secret",
      "bot-token",
    );

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(false);
    expect(sentMessageBody().text).toContain("Only the user who started this pending selection can complete it");
  });

  it("allows /sample to run while a pending selection remains active", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to be ambiguous for sample passthrough test");
    }

    const db = fixtureMockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: JSON.stringify({ alertTypes: ["dews"] }),
          alert_types: JSON.stringify(["dews"]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "USDF",
          candidates: JSON.stringify(ambiguous.matches),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "999",
        },
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/sample"), "test-secret", "bot-token");

    expect(sentMessageBody().text).toContain("This was a sample alert");
    expect(sentMessageBody().text).not.toContain("pending selection");
    expect(db.getHistory().some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(
      false,
    );
  });

  it("atomically replaces a same-initiator pending selection with /forget confirmation", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to be ambiguous for forget clear-and-run test");
    }

    const db = fixtureMockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: JSON.stringify({ alertTypes: ["dews"] }),
          alert_types: JSON.stringify(["dews"]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "USDF",
          candidates: JSON.stringify(ambiguous.matches),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "999",
        },
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/forget"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(false);
    const forgetInsert = history.find(
      (entry) =>
        entry.sql.includes("INSERT INTO telegram_pending_disambiguation") && entry.binds.includes("forget-confirm"),
    );
    expect(forgetInsert).toBeDefined();
    expect(sentMessageBody().text).toContain("permanently delete your Pharos subscriber data");
  });

  it("counts group pending-selection replies against the actor flood cap", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to be ambiguous for pending reply flood test");
    }

    const db = fixtureMockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: JSON.stringify({ alertTypes: ["dews"] }),
          alert_types: JSON.stringify(["dews"]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "USDF",
          candidates: JSON.stringify(ambiguous.matches),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "111",
        },
      },
      {
        match: "RETURNING value",
        rows: [{ value: "21" }],
      },
    ]);

    await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "1", "test-secret", { chatType: "supergroup", fromId: 222 }),
      "test-secret",
      "bot-token",
    );

    expect(sentMessageBody().text).toContain("Too many Telegram actions");
    expect(sentMessageBody().text).not.toContain("Only the user who started");
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(false);
    nowSpy.mockRestore();
  });

  it("ignores unrelated group text from non-initiators while a pending selection exists", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to be ambiguous for group ownership noise test");
    }

    const db = fixtureMockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: JSON.stringify({ alertTypes: ["dews"] }),
          alert_types: JSON.stringify(["dews"]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "USDF",
          candidates: JSON.stringify(ambiguous.matches),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "111",
        },
      },
    ]);

    await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "thanks, looks good", "test-secret", { chatType: "supergroup", fromId: 222 }),
      "test-secret",
      "bot-token",
    );

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reminds the initiating user when a pending selection reply is invalid", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to be ambiguous for invalid selection reminder test");
    }

    const db = fixtureMockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: JSON.stringify({ alertTypes: ["dews"] }),
          alert_types: JSON.stringify(["dews"]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "USDF",
          candidates: JSON.stringify(ambiguous.matches),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "999",
        },
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "not a number"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(false);
    const text = sentMessageBody().text;
    expect(text).toContain("I could not parse");
    expect(text).toContain("&quot;not&quot;");
    expect(text).toContain("numbers only");
    expect(text).toContain("USDF");
  });

  it("allows the initiating group member to complete a pending selection", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to be ambiguous for group ownership test");
    }

    const db = fixtureMockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: JSON.stringify({ alertTypes: ["dews"] }),
          alert_types: JSON.stringify(["dews"]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "USDF",
          candidates: JSON.stringify(ambiguous.matches),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "111",
        },
      },
      {
        match: "FROM telegram_subscriptions",
        rows: [
          {
            stablecoin_id: ambiguous.matches[0].id,
            alert_dews: 1,
            alert_depeg: 0,
            alert_safety: 0,
            dews_min_band: null,
            safety_mode: null,
            depeg_worsening_bps_step: null,
          },
        ],
      },
    ]);

    await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "1", "test-secret", { chatType: "supergroup", fromId: 111 }),
      "test-secret",
      "bot-token",
    );

    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(true);
    expect(sentMessageBody().text).toContain("Updated subscriptions");
  });

  it("finalizes pending /unsubscribe disambiguation with the shared completion handler", async () => {
    const ambiguous = resolveTicker("USDF");
    const usdc = resolveTicker("USDC");
    if (ambiguous.status !== "ambiguous" || usdc.status !== "unique") {
      throw new Error("Expected fixed ticker fixtures for telegram unsubscribe disambiguation flow test");
    }

    const db = fixtureMockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "unsubscribe",
          action_payload: JSON.stringify({}),
          alert_types: JSON.stringify([]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "USDF",
          candidates: JSON.stringify(ambiguous.matches),
          remaining_tickers: JSON.stringify(["USDC"]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
        },
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "1"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_subscriptions"))).toBe(true);
    expect(sentMessageBody().text).toContain("Removed 2 coin subscriptions");
    expect(sentMessageBody().text).toContain(ambiguous.matches[0].id);
    expect(sentMessageBody().text).toContain(usdc.matches[0].id);
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

  it("keeps a pending subscribe flow alive when a non-critical stored field is malformed", async () => {
    const ambiguous = resolveTicker("USDF");
    const usdc = resolveTicker("USDC");
    if (ambiguous.status !== "ambiguous" || usdc.status !== "unique") {
      throw new Error("Expected fixed ticker fixtures for telegram malformed pending-row test");
    }

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const db = fixtureMockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: "{bad-json",
          alert_types: JSON.stringify(["dews"]),
          resolved_ids: "{bad-json",
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
            dews_min_band: null,
            safety_mode: null,
            depeg_worsening_bps_step: null,
          },
          {
            stablecoin_id: usdc.matches[0].id,
            alert_dews: 1,
            alert_depeg: 0,
            alert_safety: 0,
            dews_min_band: null,
            safety_mode: null,
            depeg_worsening_bps_step: null,
          },
        ],
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "1"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
    expect(sentMessageBody().text).toContain("Updated subscriptions");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("field=action_payload"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("field=resolved_ids"));
  });

  it("clears malformed active pending selections with a recovery message", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = fixtureMockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: JSON.stringify({ alertTypes: ["dews"] }),
          alert_types: JSON.stringify(["dews"]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "USDF",
          candidates: "{bad-json",
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "999",
        },
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "1"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
    expect(sentMessageBody().text).toContain("pending selection could not be restored");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("field=candidates"));
  });

  it("gates /unsubscribe all behind a confirmation prompt", async () => {
    const db = fixtureMockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/unsubscribe all"), "test-secret", "bot-token");

    const history = db.getHistory();
    // No DELETE happens until the user taps Confirm.
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_subscriptions"))).toBe(false);
    const confirmInsert = history.find((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    expect(confirmInsert).toBeDefined();
    const payload = JSON.parse(confirmInsert!.binds[2] as string) as { kind: string; unsubscribeAll: boolean };
    expect(payload.kind).toBe("unsubscribe");
    expect(payload.unsubscribeAll).toBe(true);
    const text = sentMessageBody().text.toLowerCase();
    expect(text).toContain("confirm?");
  });

  it("gates /unsubscribe with a >10-coin preset behind a confirmation prompt", async () => {
    const db = fixtureMockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["stablecoins"],
        rows: [],
        first: {
          value: makeStablecoinsCacheValue({
            "usdt-tether": 100_000_000_000,
            "usdc-circle": 90_000_000_000,
            "dai-makerdao": 5_000_000_000,
          }),
          updated_at: 1_700_000_000,
        },
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/unsubscribe usd-top25"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_subscriptions"))).toBe(false);
    const confirmInsert = history.find((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    expect(confirmInsert).toBeDefined();
    const pending = JSON.parse(confirmInsert!.binds[2] as string) as { coinIds: string[]; presetIds: string[] };
    expect(pending.coinIds).toEqual([]);
    expect(pending.presetIds).toEqual(["usd-top25"]);
    expect(sentMessageBody().text).toContain("Confirm?");
  });

  it("allows legacy frozen coin subscriptions to be removed by exact id", async () => {
    const frozen = FROZEN_STABLECOINS[0];
    if (!frozen) {
      throw new Error("Expected at least one frozen stablecoin fixture");
    }

    const db = fixtureMockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, `/unsubscribe ${frozen.id}`), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_subscriptions"))).toBe(true);
    expect(history.find((entry) => entry.sql.includes("DELETE FROM telegram_subscriptions"))?.binds).toEqual([
      "123",
      frozen.id,
    ]);
    expect(sentMessageBody().text).toContain(frozen.id);
  });

  it("uses disambiguation for ambiguous /unsubscribe instead of deleting all matches", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to be ambiguous for unsubscribe disambiguation test");
    }

    const db = fixtureMockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/unsubscribe USDF"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_subscriptions"))).toBe(false);
    const body = sentMessageBody() as {
      text: string;
      reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    };
    expect(body.text).toContain("matches");
    expect(
      (body.reply_markup?.inline_keyboard ?? []).flat().some((button) => button.callback_data === "select:1"),
    ).toBe(true);
  });

  it("cancels pending disambiguation with /cancel", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to be ambiguous for cancel test");
    }

    const db = fixtureMockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: JSON.stringify({ alertTypes: ["dews"] }),
          alert_types: JSON.stringify(["dews"]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "USDF",
          candidates: JSON.stringify(ambiguous.matches),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
        },
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/cancel"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
    expect(sentMessageBody().text).toContain("Pending selection cancelled");
  });

  it("unsubscribe all (after Confirm) clears launch alert flags", async () => {
    const db = fixtureMockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "confirm-bulk",
          action_payload: JSON.stringify({
            kind: "unsubscribe",
            presetIds: [],
            coinIds: [],
            unsubscribeAll: true,
          }),
          alert_types: JSON.stringify([]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "",
          candidates: JSON.stringify([]),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "999",
        },
      },
    ]);

    const request = makeCallbackRequest("confirm:bulk");
    await handleTelegramWebhook(db, request, "test-secret", "bot-token");

    const history = db.getHistory();
    const updateSql = history.find((e) => e.sql.includes("UPDATE telegram_subscribers"));
    expect(updateSql).toBeDefined();
    expect(updateSql!.sql).toContain("alert_launch = 0");
    expect(updateSql!.sql).toContain("alert_reserve = 0");
    expect(updateSql!.sql).toContain("global_alert_launch = 0");
    expect(updateSql!.sql).toContain("global_alert_reserve = 0");
    expect(updateSql!.sql).toContain("global_depeg_worsening_bps_step = NULL");
  });

  it("handles D1 error gracefully", async () => {
    const db = fixtureMockD1([]);
    vi.spyOn(db, "prepare").mockImplementationOnce(() => {
      throw new Error("D1 error");
    });

    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/list"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    expect(sentMessageBody().text).toContain("Something went wrong");
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

  it("/status USDC replies with a compact card", async () => {
    const db = fixtureMockD1([
      { match: "SELECT action_type, action_payload", rows: [], first: null },
      { match: "FROM stress_signals", rows: [{ band: "CALM", score: 15, computed_at: 1700000000 }] },
      { match: "FROM safety_grade_history", rows: [{ grade: "A", score: 85, recorded_at: 1700000000 }] },
      { match: "FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL", rows: [] },
      { match: "FROM price_cache WHERE asset_id = ?", rows: [{ price: 0.9999, updated_at: 1700000000 }] },
    ]);
    const res = await handleTelegramWebhook(db, makeWebhookRequest(1, "/status USDC"), "test-secret", "bot-token");
    expect(res.status).toBe(200);
    const sent = sentMessageBody() as {
      text: string;
      reply_markup?: {
        inline_keyboard?: Array<Array<{ text: string; callback_data?: string; web_app?: { url: string } }>>;
      };
    };
    expect(sent.text).toContain("USDC");
    expect(sent.text).toContain("CALM");
    expect(sent.text).toContain("Safety: A");
    expect(sent.text).toContain("Depeg: stable");
    expect(sent.text).toContain("Price: $0.9999");
    // P1-U11: discoverability buttons attached to the status card.
    const buttons: Array<{ text: string; callback_data?: string; web_app?: { url: string } }> = (
      sent.reply_markup?.inline_keyboard ?? []
    ).flat();
    expect(buttons.map((b) => b.text)).toEqual(["Why?", "Coverage", "Subscribe", "Open in app"]);
    expect(buttons.slice(0, 3).map((b) => b.callback_data)).toEqual([
      "why:usdc-circle",
      "coverage:usdc-circle",
      "quicksub:usdc-circle",
    ]);
    expect(buttons[3]?.web_app?.url).toBe("https://pharos.watch/pharoswatchbot/app/?startapp=coin_usdc-circle");
    // Bot API limit: callback_data must stay ≤64 bytes.
    for (const button of buttons) {
      expect((button.callback_data ?? "").length).toBeLessThanOrEqual(64);
    }
  });

  it("/status ambiguous ticker asks for exact coin id instead of numeric reply", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to be ambiguous for status ambiguity test");
    }

    const db = fixtureMockD1([{ match: "SELECT action_type, action_payload", rows: [], first: null }]);
    const res = await handleTelegramWebhook(db, makeWebhookRequest(1, "/status USDF"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    const body = sentMessageBody().text;
    expect(body).toContain("Re-run /status with the exact Pharos coin id");
    expect(body).toContain(`/status ${ambiguous.matches[0].id}`);
    expect(body).not.toContain("Reply with the number");
  });

  it("replies with retry message when preset resolution cache is missing", async () => {
    const db = fixtureMockD1([
      { match: "SELECT action_type, action_payload", rows: [], first: null },
      { match: "FROM cache WHERE key = ?", matchBinds: ["stablecoins"], rows: [], first: null },
    ]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(42, "/subscribe dews usd-top25"),
      "test-secret",
      "bot-token",
    );
    expect(res.status).toBe(200);
    expect(sentMessageBody().text).toContain("temporarily unavailable");
  });

  it("allows preset unfollow when dynamic membership preview is unavailable", async () => {
    const db = fixtureMockD1([
      { match: "SELECT action_type, action_payload", rows: [], first: null },
      { match: "FROM cache WHERE key = ?", matchBinds: ["stablecoins"], rows: [], first: null },
    ]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(42, "/unsubscribe usd-top25"),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_preset_subscriptions"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_subscriptions"))).toBe(false);
    expect(sentMessageBody().text).toContain("current membership was unavailable for preview");
  });

  it("executes /subscribe with a small explicit ticker set without confirmation", async () => {
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
            alert_launch: 0,
            dews_min_band: null,
            safety_mode: null,
            depeg_worsening_bps_step: null,
          },
        ],
      },
    ]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe dews USDC"), "test-secret", "bot-token");

    const history = db.getHistory();
    // Single coin is below threshold — no confirmation gate.
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(true);
    expect(
      history.some(
        (entry) =>
          entry.sql.includes("INSERT INTO telegram_pending_disambiguation") &&
          (entry.binds as unknown[]).includes("confirm-bulk"),
      ),
    ).toBe(false);
  });
});

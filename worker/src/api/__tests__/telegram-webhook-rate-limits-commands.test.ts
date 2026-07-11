import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchSpy,
  handleTelegramWebhook,
  resolveTicker,
  makeWebhookRequest,
  sentMessageBody,
  latestSendMessageBody,
  expectMiniAppButton,
  makeStablecoinsCacheValue,
  resetTelegramWebhookTest,
  fixtureMockD1,
  fixtureLastSendMessageBody,
} from "./telegram-webhook.test-support";

describe("handleTelegramWebhook", () => {
  beforeEach(resetTelegramWebhookTest);
  it("rate-limits expensive commands per chat with a graceful reply", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const db = fixtureMockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "INSERT INTO cache (key, value, updated_at)",
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "SELECT updated_at FROM cache WHERE key = ?",
        rows: [],
        first: { updated_at: 1_700_000_000 },
      },
    ]);

    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/brief"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    expect(sentMessageBody().text).toContain("Please try /brief again");
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM daily_digest"))).toBe(false);
    nowSpy.mockRestore();
  });

  it("rate-limits /status before loading coin status rows", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const db = fixtureMockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "INSERT INTO cache (key, value, updated_at)",
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "SELECT updated_at FROM cache WHERE key = ?",
        rows: [],
        first: { updated_at: 1_700_000_000 },
      },
    ]);

    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/status USDC"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    expect(sentMessageBody().text).toContain("Please try /status again");
    expect(db.getHistory().some((entry) => entry.binds.includes("telegram:command-cooldown:123:/status"))).toBe(true);
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM stress_signals"))).toBe(false);
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM price_cache"))).toBe(false);
    nowSpy.mockRestore();
  });

  it("records cooldown-store-error when the command cooldown write fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = fixtureMockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "INSERT INTO cache (key, value, updated_at)",
        rows: [],
        throwError: new Error("d1 cooldown boom"),
      },
    ]);

    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/brief"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    expect(sentMessageBody().text).toContain("Command traffic is busy");
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM daily_digest"))).toBe(false);
    const usageRow = db
      .getHistory()
      .find(
        (entry) =>
          entry.sql.includes("INSERT INTO telegram_usage_daily") &&
          entry.binds[1] === "command" &&
          entry.binds[3] === "/brief",
      );
    expect(usageRow).toBeDefined();
    expect(usageRow!.binds[4]).toBe("failure");
    expect(usageRow!.binds[6]).toBe("cooldown-store-error");
    warn.mockRestore();
  });

  it("releases an acquired command cooldown when the handler throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = fixtureMockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "FROM daily_digest", rows: [], throwError: new Error("digest read failed") },
    ]);

    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/brief"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    expect(sentMessageBody().text).toContain("Something went wrong");
    expect(
      db
        .getHistory()
        .some(
          (entry) =>
            entry.sql.includes("DELETE FROM cache WHERE key = ?") &&
            entry.binds.includes("telegram:command-cooldown:123:/brief"),
        ),
    ).toBe(true);
    warn.mockRestore();
  });

  it("drops commands over the per-chat flood cap and replies once at first exceed", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    // 21st command inside the window: counter row already at the limit of 20.
    const db = fixtureMockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "RETURNING value",
        rows: [{ value: "21" }],
      },
    ]);

    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/help"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    expect(sentMessageBody().text).toContain("Too many commands at once");
    const usageRow = db
      .getHistory()
      .find(
        (entry) =>
          entry.sql.includes("INSERT INTO telegram_usage_daily") &&
          entry.binds[1] === "command" &&
          entry.binds[3] === "/help",
      );
    expect(usageRow).toBeDefined();
    expect(usageRow!.binds[4]).toBe("rate_limited");
    expect(usageRow!.binds[6]).toBe("chat-flood");
    nowSpy.mockRestore();
  });

  it("drops flooded commands silently after the first-exceed notice", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const db = fixtureMockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "RETURNING value",
        rows: [{ value: "26" }],
      },
    ]);

    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/help"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });

  it("uses actor-scoped flood keys in groups before the chat-wide ceiling", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const db = fixtureMockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "RETURNING value",
        matchBinds: ["telegram:command-flood:-123:actor:222", 1_700_000_000, 1_699_999_940, 1_699_999_940],
        rows: [{ value: "1" }],
      },
      {
        match: "RETURNING value",
        matchBinds: ["telegram:command-flood:-123", 1_700_000_000, 1_699_999_940, 1_699_999_940],
        rows: [{ value: "1" }],
      },
    ]);

    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/help@PharosWatchBot", "test-secret", {
        chatType: "supergroup",
        fromId: 222,
      }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(sentMessageBody().text).toContain("Commands");
    const history = db.getHistory();
    expect(history.some((entry) => entry.binds.includes("telegram:command-flood:-123:actor:222"))).toBe(true);
    expect(history.some((entry) => entry.binds.includes("telegram:command-flood:-123"))).toBe(true);
    nowSpy.mockRestore();
  });

  it("drops flooded group commands for the actor that exceeded the cap", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const db = fixtureMockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "RETURNING value",
        rows: [{ value: "21" }],
      },
    ]);

    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/help@PharosWatchBot", "test-secret", {
        chatType: "supergroup",
        fromId: 222,
      }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(sentMessageBody().text).toContain("Too many commands at once");
    expect(db.getHistory().some((entry) => entry.binds.includes("actor-flood"))).toBe(true);
    nowSpy.mockRestore();
  });

  it("fails open when the chat flood counter store errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = fixtureMockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "RETURNING value",
        rows: [],
        throwError: new Error("d1 flood boom"),
      },
    ]);

    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/help"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    // /help still replied despite the flood-store failure.
    expect(sentMessageBody().text.length).toBeGreaterThan(0);
    warn.mockRestore();
  });

  it("uses the /brief cooldown bucket for the deprecated /market alias", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const db = fixtureMockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "INSERT INTO cache (key, value, updated_at)",
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "SELECT updated_at FROM cache WHERE key = ?",
        rows: [],
        first: { updated_at: 1_700_000_000 },
      },
    ]);

    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/market"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    expect(sentMessageBody().text).toContain("Please try /brief again");
    expect(db.getHistory().some((entry) => entry.binds.includes("telegram:command-cooldown:123:/brief"))).toBe(true);
    expect(db.getHistory().some((entry) => entry.binds.includes("telegram:command-cooldown:123:/market"))).toBe(false);
    nowSpy.mockRestore();
  });

  it("returns 200 for non-command text", async () => {
    const db = fixtureMockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "hello"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("replies to /start", async () => {
    const db = fixtureMockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/start"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    // `/start` now opens the setup wizard (P0-U2). The reply is the short
    // wizard intro plus the branch keyboard; the long-form onboarding lives
    // behind the "I'll type commands myself" branch and /help.
    expect(sentMessageBody().text).toContain("Welcome");
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("replies to /help", async () => {
    const db = fixtureMockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/help"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = sentMessageBody();
    expect(body.text).toContain("Commands");
    expect(body.text).toContain("/presets");
    expect(body.text).toContain("/sample");
    expect(body.text).toContain("/settings");
    expect(body.text).toContain("/coverage");
    expectMiniAppButton(body, "Open control panel", "settings");
  });

  it("records command replies without stamping alert delivery success", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const db = fixtureMockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/help"), "test-secret", "bot-token");

    const diagnosticInsert = db
      .getHistory()
      .find((entry) => entry.sql.includes("INSERT INTO telegram_chat_delivery_diagnostics"));
    expect(diagnosticInsert).toBeDefined();
    expect(diagnosticInsert!.sql).toContain("VALUES (?, NULL, ?, ?, ?, ?)");
    expect(diagnosticInsert!.binds).toEqual(["123", 1_700_000_000, 1_700_000_000, null, 1_700_000_000]);
    nowSpy.mockRestore();
  });

  it("replies to /health with chat delivery diagnostics", async () => {
    const db = fixtureMockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM telegram_subscribers",
        first: {
          alert_dews: 1,
          alert_depeg: 0,
          alert_safety: 0,
          alert_launch: 0,
          global_alert_dews: 1,
          global_alert_depeg: 0,
          global_alert_safety: 0,
          global_alert_launch: 0,
          quiet_hours_enabled: 1,
          quiet_hours_start_utc: 22,
          quiet_hours_end_utc: 7,
          timezone: null,
          alert_snooze_until_ts: null,
          consecutive_block_count: 0,
          consecutive_block_first_at: null,
        },
        rows: [],
      },
      {
        match: "FROM telegram_preset_subscriptions",
        rows: [
          { preset_id: "usd-top25", alert_dews: 1, alert_depeg: 1, alert_safety: 0, depeg_worsening_bps_step: null },
        ],
      },
      { match: "COUNT(*) AS active_count", first: { active_count: 3 }, rows: [] },
      { match: "SELECT last_error_class", first: { last_error_class: "rate_limit" }, rows: [] },
      { match: "COUNT(*) AS pending_count", first: { pending_count: 2 }, rows: [] },
      {
        match: "FROM telegram_chat_delivery_diagnostics",
        first: {
          last_successful_delivery_at: Math.floor(Date.now() / 1000) - 60,
          last_successful_reply_at: Math.floor(Date.now() / 1000) - 60,
          recent_failure_class: null,
        },
        rows: [],
      },
    ]);

    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/health"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    const text = latestSendMessageBody().text;
    expect(text).toContain("Bot Health");
    expect(text).toContain("Last successful alert delivery:");
    expect(text).toContain("Last successful command reply:");
    expect(text).toContain("Queued alerts for this chat: 2");
    expect(text).toContain("Recent failure class: rate_limit");
    expect(text).toContain("Alert readiness: 3 explicit coin follows; 1 dynamic preset");
  });

  it("lets /health pass through during pending disambiguation without clearing it", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to resolve ambiguously for health passthrough test");
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
      { match: "FROM telegram_subscribers", rows: [], first: null },
      { match: "FROM telegram_preset_subscriptions", rows: [] },
      { match: "COUNT(*) AS active_count", first: { active_count: 0 }, rows: [] },
      { match: "SELECT last_error_class", first: null, rows: [] },
      { match: "COUNT(*) AS pending_count", first: { pending_count: 0 }, rows: [] },
      { match: "FROM telegram_chat_delivery_diagnostics", first: null, rows: [] },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/health"), "test-secret", "bot-token");

    expect(latestSendMessageBody().text).toContain("Bot Health");
    expect(latestSendMessageBody().text).not.toContain("pending selection");
    expect(db.getHistory().some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(
      false,
    );
  });

  it("lets /health pass through during pending bulk confirmation without clearing it", async () => {
    const db = fixtureMockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "confirm-bulk",
          action_payload: JSON.stringify({
            kind: "subscribe",
            alertTypes: ["dews"],
            presetIds: [],
            coinIds: ["usdc-circle"],
            subscribeAll: false,
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
      { match: "FROM telegram_subscribers", rows: [], first: null },
      { match: "FROM telegram_preset_subscriptions", rows: [] },
      { match: "COUNT(*) AS active_count", first: { active_count: 0 }, rows: [] },
      { match: "SELECT last_error_class", first: null, rows: [] },
      { match: "COUNT(*) AS pending_count", first: { pending_count: 0 }, rows: [] },
      { match: "FROM telegram_chat_delivery_diagnostics", first: null, rows: [] },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/health"), "test-secret", "bot-token");

    expect(latestSendMessageBody().text).toContain("Bot Health");
    expect(latestSendMessageBody().text).not.toContain("pending bulk confirmation");
    expect(db.getHistory().some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(
      false,
    );
  });

  it("/settings sends the chat-level settings keyboard", async () => {
    const db = fixtureMockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "FROM telegram_subscribers WHERE chat_id = ?", rows: [], first: null },
    ]);
    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/settings"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    const body = sentMessageBody() as {
      text: string;
      reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> };
    };
    expect(body.text).toContain("<b>Settings</b>");
    const callbacks = body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    expect(callbacks).toEqual(expect.arrayContaining(["settings:gt:dews", "settings:gt:depeg"]));
  });

  it("ignores unaddressed commands in group chats", async () => {
    const db = fixtureMockD1([]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/subscribe dews USDC", "test-secret", { chatType: "supergroup" }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.getHistory()).toEqual([]);
  });

  it("/start opens the setup wizard with the branch keyboard", async () => {
    const db = fixtureMockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/start"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = sentMessageBody();
    expect(body.text).toContain("Welcome to PharosWatchBot");
    expect(body.text).toContain("@pharoswatch");
    expect(body.text).toContain("@pharoswatchers");
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const sent = JSON.parse((init?.body as string) ?? "{}") as {
      reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    };
    const callbacks = (sent.reply_markup?.inline_keyboard ?? []).flat().map((btn) => btn.callback_data);
    expect(callbacks).toContain("setup:branch:recommended");
    expect(callbacks).toContain("setup:branch:custom");
    expect(callbacks).toContain("setup:branch:skip");
    expect(
      db
        .getHistory()
        .some(
          (entry) =>
            entry.sql.includes("INSERT INTO telegram_pending_disambiguation") && entry.binds.includes("setup-step"),
        ),
    ).toBe(true);
  });

  it("/start setup deep-link opens the wizard", async () => {
    const db = fixtureMockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/start setup"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const sent = JSON.parse((init?.body as string) ?? "{}") as {
      reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    };
    const callbacks = (sent.reply_markup?.inline_keyboard ?? []).flat().map((btn) => btn.callback_data);
    expect(callbacks).toContain("setup:branch:recommended");
  });

  it("/start in a group gives non-admins the read-only start message", async () => {
    const db = fixtureMockD1([
      {
        match: "FROM cache WHERE key = ?",
        rows: [],
        first: null,
      },
    ]);
    fetchSpy.mockImplementation(async (url) => {
      if (String(url).includes("getChatMember")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: { user: { id: 7, is_bot: false, first_name: "member" }, status: "member" },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/start@PharosWatchBot", "test-secret", {
        chatType: "supergroup",
        fromId: 7,
      }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    const body = fixtureLastSendMessageBody<{ text: string }>(fetchSpy);
    expect(body.text).toContain("Quick start");
    expect(body.text).toContain("/sample");
    expect(body.text).toContain("/settings");
    expect(body.text).toContain("/coverage");
    expect(body.text).not.toContain("Pick a path below");
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"))).toBe(
      false,
    );
  });

  it("/start in a group does not overwrite another user's fresh setup state", async () => {
    const db = fixtureMockD1([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [
          {
            action_type: "setup-step",
            action_payload: JSON.stringify({ step: "branch", alertTypes: [], target: null }),
            alert_types: "[]",
            resolved_ids: "[]",
            ambiguous_ticker: "",
            candidates: "[]",
            remaining_tickers: "[]",
            expires_at: 9_999_999_999,
            initiator_user_id: "111",
          },
        ],
      },
      {
        match: "INSERT INTO telegram_pending_disambiguation",
        rows: [],
        runMeta: { changes: 0 },
      },
    ]);
    fetchSpy.mockImplementation(async (url) => {
      if (String(url).includes("getChatMember")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: { user: { id: 222, is_bot: false, first_name: "admin" }, status: "administrator" },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/start@PharosWatchBot", "test-secret", {
        chatType: "supergroup",
        fromId: 222,
      }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    const body = latestSendMessageBody();
    expect(body.text).toContain("Another user has a pending selection");
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"))).toBe(false);
  });

  it("/start sub_<types>_<targets> in a private chat dispatches into /subscribe", async () => {
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
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/start sub_dews-depeg_usd-top25"),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    const history = db.getHistory();
    // The subscribe path ran (preset cache was consulted); bulk-confirm gate caught the
    // >10-coin preset and queued a confirmation rather than writing subscriptions directly.
    expect(history.some((entry) => entry.sql.includes("FROM cache WHERE key = ?"))).toBe(true);
    const confirmInsert = history.find((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    expect(confirmInsert).toBeDefined();
    expect(confirmInsert!.binds).toContain("confirm-bulk");
    const payload = JSON.parse(confirmInsert!.binds[2] as string) as {
      kind: string;
      alertTypes: string[];
      presetIds: string[];
    };
    expect(payload.kind).toBe("subscribe");
    expect(payload.alertTypes.sort()).toEqual(["depeg", "dews"]);
    expect(payload.presetIds).toEqual(["usd-top25"]);
    expect(sentMessageBody().text).toContain("Confirm?");
  });

  it("/start sub_<types>_<targets> in a group chat falls back to START_MESSAGE", async () => {
    const db = fixtureMockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/start@PharosWatchBot sub_dews_usd-top25", "test-secret", {
        chatType: "supergroup",
      }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    const history = db.getHistory();
    // No subscribe machinery ran — no preset cache lookup, no confirm-bulk row.
    // (The per-chat command-flood counter also reads the cache table; exclude it.)
    expect(
      history.some(
        (entry) =>
          entry.sql.includes("FROM cache WHERE key = ?") &&
          !entry.binds.some((bind) => String(bind).startsWith("telegram:command-flood:")),
      ),
    ).toBe(false);
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"))).toBe(false);
    const body = sentMessageBody().text;
    // The long-form START_MESSAGE (not the short wizard intro) is returned for groups.
    expect(body).toContain("Alert types");
    expect(body).toContain("Quick start");
    expect(body).not.toContain("Pick a path below");
  });

  it("/start status_<coinId> dispatches into /status", async () => {
    const db = fixtureMockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "FROM stress_signals", rows: [{ band: "CALM", score: 15, computed_at: 1_700_000_000 }] },
      {
        match: "FROM safety_grade_history",
        rows: [{ grade: "A", score: 85, recorded_at: 1_700_000_000 }],
      },
      { match: "FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL", rows: [] },
      {
        match: "FROM price_cache WHERE asset_id = ?",
        rows: [{ price: 0.9999, updated_at: 1_700_000_000 }],
      },
    ]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(1, "/start status_usdc-circle"),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    const body = sentMessageBody().text;
    expect(body).toContain("USDC");
    expect(body).toContain("CALM");
    expect(body).toContain("Safety: A");
    expect(body).toContain("Price: $0.9999");
  });

  it("rate-limits /start status_<coinId> through the /status cooldown bucket", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const db = fixtureMockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "INSERT INTO cache (key, value, updated_at)",
        matchBinds: ["telegram:command-cooldown:1:/status", "1", 1_700_000_000, 1_699_999_980],
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "SELECT updated_at FROM cache WHERE key = ?",
        matchBinds: ["telegram:command-cooldown:1:/status"],
        rows: [{ updated_at: 1_700_000_000 }],
      },
    ]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(1, "/start status_usdc-circle"),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(sentMessageBody().text).toContain("Please try /status again");
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM stress_signals"))).toBe(false);
    expect(db.getHistory().some((entry) => entry.binds.includes("telegram:command-cooldown:1:/status"))).toBe(true);
    nowSpy.mockRestore();
  });

  it("/start why_<coinId> dispatches into /why", async () => {
    const db = fixtureMockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM safety_grade_history",
        rows: [{ grade: "A", score: 85, recorded_at: 1_700_000_000 }],
      },
    ]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(1, "/start why_usdc-circle"),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // /why renders the safety-grade explanation for USDC; no ticker-resolution error fires.
    const body = sentMessageBody().text;
    expect(body).not.toContain("not found");
    expect(body).not.toContain("Re-run /status");
  });

  it("/start coverage_<coinId> dispatches into /coverage", async () => {
    const db = fixtureMockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "FROM stress_signals", rows: [{ band: "CALM", score: 15, computed_at: 1_700_000_000 }] },
      {
        match: "FROM safety_grade_history",
        rows: [{ grade: "A", score: 85, recorded_at: 1_700_000_000 }],
      },
      { match: "FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL", rows: [] },
      {
        match: "FROM price_cache WHERE asset_id = ?",
        rows: [{ price: 0.9999, updated_at: 1_700_000_000 }],
      },
    ]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(1, "/start coverage_usdc-circle"),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    const body = sentMessageBody().text;
    expect(body).toContain("USDC");
    expect(body).not.toContain("not found");
  });

  it("handles direct /brief and deprecated /market commands", async () => {
    const db = fixtureMockD1([{ match: "FROM daily_digest", rows: [] }]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/brief"), "test-secret", "bot-token");
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/market"), "test-secret", "bot-token");

    expect(sentMessageBody(0).text).toContain("No digest brief is available yet");
    expect(sentMessageBody(1).text).toContain("No digest brief is available yet");
  });

  it("handles direct /top usage without running the expensive top view", async () => {
    const db = fixtureMockD1([]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/top"), "test-secret", "bot-token");

    expect(sentMessageBody().text).toBe("Usage: /top depeg|dews|yield|liquidity|chains|safety");
    const history = db.getHistory();
    expect(history[0]?.sql).toContain("FROM telegram_pending_disambiguation");
    expect(
      history.some((entry) => entry.binds.some((bind) => String(bind).includes("telegram:command-cooldown"))),
    ).toBe(false);
    expect(history.some((entry) => entry.sql.includes("FROM depeg_events"))).toBe(false);
  });

  it("does not consume the /status cooldown when called with no args (usage reply)", async () => {
    const db = fixtureMockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);

    // Two consecutive no-arg /status calls — neither should store a cooldown entry.
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/status"), "test-secret", "bot-token");
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/status"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(
      history.some((entry) =>
        entry.binds.some((bind) => String(bind).includes("telegram:command-cooldown:123:/status")),
      ),
    ).toBe(false);
  });

  it("handles direct /why and /coverage commands", async () => {
    const db = fixtureMockD1([
      { match: "FROM price_cache WHERE asset_id = ?", rows: [] },
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM depeg_events", rows: [] },
      { match: "FROM dex_liquidity", rows: [] },
      { match: "FROM yield_data", rows: [] },
      { match: "FROM cache WHERE key = ?", rows: [] },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/why NOTACOIN"), "test-secret", "bot-token");
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/coverage USDC"), "test-secret", "bot-token");

    expect(sentMessageBody(0).text).toContain("not found");
    expect(sentMessageBody(1).text).toContain("USDC coverage");
    expect(sentMessageBody(1).text).toContain("Open coin page");
    expectMiniAppButton(sentMessageBody(1), "Open in app", "coverage_usdc-circle");
  });

  it("/start with an unknown payload falls back to the wizard intro", async () => {
    const db = fixtureMockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/start garbage_xyz"),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const sent = JSON.parse((init?.body as string) ?? "{}") as {
      text: string;
      reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    };
    expect(sent.text).toContain("Welcome to PharosWatchBot");
    expect(sent.text).toContain("Pick a path below");
    const callbacks = (sent.reply_markup?.inline_keyboard ?? []).flat().map((btn) => btn.callback_data);
    expect(callbacks).toContain("setup:branch:recommended");
  });

  it("/start rejects payloads over 64 characters and falls back to the wizard intro", async () => {
    const db = fixtureMockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const longPayload = `status_${"a".repeat(60)}`; // 7 + 60 = 67 chars, well-formed otherwise
    expect(longPayload.length).toBeGreaterThan(64);

    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, `/start ${longPayload}`),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    // Status handler did not run — no stress_signals/price_cache queries were issued.
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("FROM stress_signals"))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("FROM price_cache"))).toBe(false);
    expect(sentMessageBody().text).toContain("Pick a path below");
  });

  it("/start rejects payloads containing disallowed characters and falls back to the wizard intro", async () => {
    const db = fixtureMockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/start status_usdc.circle"),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("FROM stress_signals"))).toBe(false);
    expect(sentMessageBody().text).toContain("Pick a path below");
  });
});

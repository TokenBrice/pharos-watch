import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchSpy,
  handleTelegramWebhook,
  TELEGRAM_GROUP_ADMIN_GATING,
  resolveTicker,
  makeWebhookRequest,
  makeCallbackRequest,
  sentMessageBody,
  latestSendMessageBody,
  inlineButtons,
  expectMiniAppButton,
  makeSetupPendingRow,
  resetTelegramWebhookTest,
  makeTelegramWebhookDb,
} from "./telegram-webhook.test-support";


describe("handleTelegramWebhook", () => {
  beforeEach(resetTelegramWebhookTest);
  it("setup-step awaiting-ticker advances to confirm when a unique ticker is replied", async () => {
    const db = makeTelegramWebhookDb([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "setup-step",
          action_payload: JSON.stringify({
            step: "awaiting-ticker",
            alertTypes: ["dews"],
            target: null,
          }),
          alert_types: JSON.stringify([]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "",
          candidates: JSON.stringify([]),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: null,
        },
      },
    ]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "USDC"), "test-secret", "bot-token");

    const persist = db
      .getHistory()
      .filter((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    expect(persist.length).toBeGreaterThan(0);
    const payload = String(persist[persist.length - 1].binds[2] ?? "");
    expect(payload).toContain('"step":"confirm-custom"');
    expect(payload).toContain('"kind":"ticker"');
    expect(payload).toContain("USDC");
  });

  it("setup-step awaiting-ticker treats slash-prefixed ticker replies as ticker input", async () => {
    const db = makeTelegramWebhookDb([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: makeSetupPendingRow({
          step: "awaiting-ticker",
          alertTypes: ["dews"],
          target: null,
        }),
      },
    ]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/USDC"), "test-secret", "bot-token");

    const history = db.getHistory();
    const persist = history.filter((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    expect(persist.length).toBeGreaterThan(0);
    const payload = String(persist[persist.length - 1].binds[2] ?? "");
    expect(payload).toContain('"step":"confirm-custom"');
    expect(payload).toContain('"kind":"ticker"');
    expect(payload).toContain("USDC");
    expect(history.some((entry) => entry.binds.includes("unknown_command"))).toBe(false);
  });

  it("setup-step awaiting-ticker keeps an ambiguous force-reply selection in the ticker prompt", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to resolve ambiguously for setup force-reply test");
    }
    const db = makeTelegramWebhookDb([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: makeSetupPendingRow(
          {
            step: "awaiting-ticker",
            alertTypes: ["dews"],
            target: null,
          },
          { initiatorUserId: "999" },
        ),
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "USDF"), "test-secret", "bot-token");

    const body = sentMessageBody();
    expect(body.text).toContain("USDF");
    expect(body.text).toContain("matches");
    expect((body.reply_markup as { force_reply?: boolean } | undefined)?.force_reply).toBe(true);
    const history = db.getHistory();
    const persistedSetupPayloads = history
      .filter((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"))
      .map((entry) => String(entry.binds[2] ?? ""));
    expect(persistedSetupPayloads.some((payload) => payload.includes('"step":"confirm-custom"'))).toBe(false);
  });

  it("setup:type-toggle:launch toggles Launch on in the custom alert picker", async () => {
    const db = makeTelegramWebhookDb([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: makeSetupPendingRow(
          {
            step: "custom-types",
            alertTypes: ["dews", "depeg"],
            target: null,
          },
          { initiatorUserId: "999" },
        ),
      },
    ]);

    await handleTelegramWebhook(db, makeCallbackRequest("setup:type-toggle:launch"), "test-secret", "bot-token");

    const pendingWrites = db
      .getHistory()
      .filter((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    const latestPendingWrite = pendingWrites[pendingWrites.length - 1];
    expect(latestPendingWrite).toBeDefined();
    const payload = JSON.parse(String(latestPendingWrite!.binds[2] ?? "{}")) as {
      step?: string;
      alertTypes?: string[];
    };
    expect(payload.step).toBe("custom-types");
    expect(payload.alertTypes).toEqual(["dews", "depeg", "launch"]);

    const body = sentMessageBody();
    expect(body.text).toContain("Selected: DEWS, Depeg, Launch");
    const buttons = inlineButtons(body);
    expect(buttons).toContainEqual({ text: "✓ Launch", callback_data: "setup:type-toggle:launch" });
    expect(buttons).toContainEqual({ text: "Next →", callback_data: "setup:next" });
  });

  it("setup:target:type opens one ticker prompt with an inline cancel affordance", async () => {
    const db = makeTelegramWebhookDb([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: makeSetupPendingRow(
          {
            step: "custom-target",
            alertTypes: ["dews", "launch"],
            target: null,
          },
          { initiatorUserId: "999" },
        ),
      },
    ]);

    await handleTelegramWebhook(db, makeCallbackRequest("setup:target:type"), "test-secret", "bot-token");

    const pendingWrites = db
      .getHistory()
      .filter((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    const latestPendingWrite = pendingWrites[pendingWrites.length - 1];
    expect(latestPendingWrite).toBeDefined();
    const payload = JSON.parse(String(latestPendingWrite!.binds[2] ?? "{}")) as {
      step?: string;
      alertTypes?: string[];
    };
    expect(payload.step).toBe("awaiting-ticker");
    expect(payload.alertTypes).toEqual(["dews", "launch"]);

    const sendCalls = fetchSpy.mock.calls.filter((call) => String(call[0]).includes("sendMessage"));
    expect(sendCalls).toHaveLength(1);
    const promptBody = sentMessageBody();
    expect(promptBody.text).toContain("Reply with a ticker");
    expect((promptBody.reply_markup as { force_reply?: boolean } | undefined)?.force_reply).toBeUndefined();
    expect(inlineButtons(promptBody)).toContainEqual({ text: "Cancel", callback_data: "setup:cancel" });
  });

  it("setup:branch:skip sends a slim command reference instead of the full start surface", async () => {
    const db = makeTelegramWebhookDb([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: makeSetupPendingRow(
          {
            step: "branch",
            alertTypes: [],
            target: null,
          },
          { initiatorUserId: "999" },
        ),
      },
    ]);

    await handleTelegramWebhook(db, makeCallbackRequest("setup:branch:skip"), "test-secret", "bot-token");

    expect(db.getHistory().some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(
      true,
    );
    const body = sentMessageBody();
    expect(body.text).toContain("Command reference");
    expect(body.text).toContain("/help");
    expect(body.text).toContain("/settings");
    expect(body.text).toContain("/list");
    expect(body.text).not.toContain("<b>Alert types</b>");
    expect(body.text).not.toContain("Other useful setups");
  });

  it("atomically replaces a stale setup-step row when reopening the setup wizard", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const db = makeTelegramWebhookDb([
        {
          match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
          rows: [],
          first: makeSetupPendingRow(
            {
              step: "awaiting-ticker",
              alertTypes: ["dews"],
              target: null,
            },
            {
              expiresAt: Math.floor(Date.now() / 1000) - 1,
              initiatorUserId: "999",
            },
          ),
        },
      ]);

      await handleTelegramWebhook(db, makeWebhookRequest(123, "/start"), "test-secret", "bot-token");

      const history = db.getHistory();
      expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(false);
      const pendingWrites = history.filter((entry) =>
        entry.sql.includes("INSERT INTO telegram_pending_disambiguation"),
      );
      expect(pendingWrites.length).toBeGreaterThan(0);
      const latestPayload = JSON.parse(String(pendingWrites[pendingWrites.length - 1].binds[2] ?? "{}")) as {
        step?: string;
      };
      expect(latestPayload.step).toBe("branch");
      expect(latestSendMessageBody().text).toContain("Welcome to PharosWatchBot");
    } finally {
      warn.mockRestore();
    }
  });

  it("setup-step pending state lets a fresh slash command through after clearing wizard state", async () => {
    const db = makeTelegramWebhookDb([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "setup-step",
          action_payload: JSON.stringify({ step: "branch", alertTypes: [], target: null }),
          alert_types: JSON.stringify([]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "",
          candidates: JSON.stringify([]),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: null,
        },
      },
    ]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/help"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
    expect(sentMessageBody().text).toContain("Commands");
  });

  it("setup-step branch nudges the user when they type instead of tapping a button", async () => {
    const db = makeTelegramWebhookDb([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "setup-step",
          action_payload: JSON.stringify({ step: "branch", alertTypes: [], target: null }),
          alert_types: JSON.stringify([]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "",
          candidates: JSON.stringify([]),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: null,
        },
      },
    ]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "recommended"), "test-secret", "bot-token");

    expect(sentMessageBody().text).toContain("Tap one of the buttons above");
    const history = db.getHistory();
    // Plain text at the branch step does not clear the wizard — the user can still tap a button.
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(false);
  });

  it("setup-step /cancel confirms cancellation instead of replying 'No pending selection'", async () => {
    const db = makeTelegramWebhookDb([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "setup-step",
          action_payload: JSON.stringify({ step: "branch", alertTypes: [], target: null }),
          alert_types: JSON.stringify([]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "",
          candidates: JSON.stringify([]),
          remaining_tickers: JSON.stringify([]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: null,
        },
      },
    ]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/cancel"), "test-secret", "bot-token");

    const body = sentMessageBody().text;
    expect(body).toContain("Setup cancelled");
    expect(body).not.toContain("No pending selection");
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
  });

  it("handles addressed commands in group chats", async () => {
    const db = makeTelegramWebhookDb([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/help@PharosWatchBot", "test-secret", { chatType: "group" }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sentMessageBody().text).toContain("Commands");
    expect(sentMessageBody().text).toContain("In groups");
  });

  it("rejects channel-originated mutating commands without changing subscriptions", async () => {
    const db = makeTelegramWebhookDb([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(-100123, "/subscribe dews USDC", "test-secret", {
        chatType: "channel",
        fromId: 222,
      }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(sentMessageBody().text).toContain("Channel-originated mutations are not supported");
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_subscribers"))).toBe(false);
  });

  it("keeps discovery keyboards for addressed /coverage commands in group chats", async () => {
    const db = makeTelegramWebhookDb([
      { match: "FROM price_cache WHERE asset_id = ?", rows: [] },
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM depeg_events", rows: [] },
      { match: "FROM dex_liquidity", rows: [] },
      { match: "FROM yield_data", rows: [] },
      { match: "FROM cache WHERE key = ?", rows: [] },
    ]);

    const coverageRes = await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/coverage@PharosWatchBot USDC", "test-secret", { chatType: "group", fromId: 222 }),
      "test-secret",
      "bot-token",
    );

    expect(coverageRes.status).toBe(200);
    const sentBodies = fetchSpy.mock.calls
      .filter((call) => String(call[0]).includes("/sendMessage"))
      .map(([, init]) => JSON.parse((init?.body as string) ?? "{}") as { text: string; reply_markup?: unknown });
    const coverageBody = sentBodies.find((body) => body.text.includes("USDC coverage"));
    expect(coverageBody).toBeDefined();
    const coverageButtons = inlineButtons(coverageBody!);
    expect(coverageButtons).toEqual(
      expect.arrayContaining([
        { text: "Why?", callback_data: "why:usdc-circle" },
        { text: "Coverage", callback_data: "coverage:usdc-circle" },
        { text: "Subscribe", callback_data: "quicksub:usdc-circle" },
      ]),
    );
    expect(coverageButtons.some((button) => button.web_app)).toBe(false);
  });

  it("ignores commands addressed to the channel handle in group chats", async () => {
    const db = makeTelegramWebhookDb([]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/help@pharoswatch", "test-secret", { chatType: "supergroup" }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.getHistory()).toEqual([]);
  });

  it("handles /subscribe validation: no tickers", async () => {
    const db = makeTelegramWebhookDb([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe dews"), "test-secret", "bot-token");

    expect(sentMessageBody().text.toLowerCase()).toContain("ticker");
  });

  it("handles /subscribe validation: no types", async () => {
    const db = makeTelegramWebhookDb([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe USDC"), "test-secret", "bot-token");

    expect(sentMessageBody().text.toLowerCase()).toContain("alert type");
  });

  it("handles /list with no subscriptions", async () => {
    const db = makeTelegramWebhookDb([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "FROM telegram_subscribers", rows: [], first: null },
    ]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/list"), "test-secret", "bot-token");

    const body = sentMessageBody();
    expect(body.text).toContain("No active subscriptions");
    expect(body.text).toContain("/presets");
    expectMiniAppButton(body, "Open control panel", "watchlist");
    expectMiniAppButton(body, "Browse presets", "presets");
  });

  it("allows non-admin group users to view /list without an admin lookup", async () => {
    const db = makeTelegramWebhookDb([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "FROM telegram_subscribers", rows: [], first: null },
      { match: "FROM telegram_subscriptions", rows: [] },
    ]);

    await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/list@PharosWatchBot", "test-secret", {
        chatType: "supergroup",
        fromId: 7,
      }),
      "test-secret",
      "bot-token",
    );

    expect(sentMessageBody().text).toContain("No active subscriptions");
    expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes("getChatMember"))).toBe(false);
    expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes("getChatAdministrators"))).toBe(false);
  });

  it("allows non-admin group users to open read-only /settings and /timezone views", async () => {
    const db = makeTelegramWebhookDb([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "FROM telegram_subscribers", rows: [], first: null },
    ]);

    await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/settings@PharosWatchBot", "test-secret", {
        chatType: "supergroup",
        fromId: 7,
      }),
      "test-secret",
      "bot-token",
    );
    await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/timezone@PharosWatchBot", "test-secret", {
        chatType: "supergroup",
        fromId: 7,
      }),
      "test-secret",
      "bot-token",
    );

    expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes("getChatMember"))).toBe(false);
    expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes("getChatAdministrators"))).toBe(false);
    const sentBodies = fetchSpy.mock.calls
      .filter((call) => String(call[0]).includes("sendMessage"))
      .map((call) => JSON.parse((call[1]?.body as string) ?? "{}") as { text: string; reply_markup?: unknown });
    expect(sentBodies.some((body) => body.text.includes("<b>Settings</b>"))).toBe(true);
    const timezoneBody = sentBodies.find((body) => body.text.includes("Current timezone"));
    expect(timezoneBody).toBeDefined();
    expect(timezoneBody?.reply_markup).toBeUndefined();
    expect(timezoneBody?.text).not.toContain("keyboard");
  });

  it("denies mutating group commands when Telegram omits from.id", async () => {
    const db = makeTelegramWebhookDb([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "FROM cache WHERE key = ?", rows: [], first: null },
    ]);
    fetchSpy.mockImplementation(async (url) => {
      if (String(url).includes("getChatAdministrators")) {
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/mute@PharosWatchBot 22-07", "test-secret", {
        chatType: "supergroup",
        includeFrom: false,
      }),
      "test-secret",
      "bot-token",
    );

    expect(latestSendMessageBody().text).toMatch(/Only group admins/i);
    expect(
      db.getHistory().some((entry) => /INSERT INTO telegram_subscribers|UPDATE telegram_subscribers/i.test(entry.sql)),
    ).toBe(false);
  });

  it("keeps group admin denial copy short and caps admin hints at three names", async () => {
    const db = makeTelegramWebhookDb([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "FROM cache WHERE key = ?", rows: [], first: null },
    ]);
    fetchSpy.mockImplementation(async (url) => {
      const target = String(url);
      if (target.includes("getChatMember")) {
        return new Response(
          JSON.stringify({ ok: true, result: { user: { id: 7, first_name: "member" }, status: "member" } }),
          { status: 200 },
        );
      }
      if (target.includes("getChatAdministrators")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              { status: "creator", user: { id: 1, username: "admin1" } },
              { status: "administrator", user: { id: 2, username: "admin2" } },
              { status: "administrator", user: { id: 3, username: "admin3" } },
              { status: "administrator", user: { id: 4, username: "admin4" } },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/mute@PharosWatchBot 22-07", "test-secret", {
        chatType: "supergroup",
        fromId: 7,
      }),
      "test-secret",
      "bot-token",
    );

    const text = latestSendMessageBody().text;
    expect(text).toContain("Only group admins can /mute");
    expect(text).toContain("@admin1");
    expect(text).toContain("@admin2");
    expect(text).toContain("@admin3");
    expect(text).toContain("and 1 more");
    expect(text).not.toContain("@admin4");
    expect(text).not.toContain("change alert settings");
  });

  it("denies /pause for non-admin group users", async () => {
    const db = makeTelegramWebhookDb([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "FROM cache WHERE key = ?", rows: [], first: null },
    ]);
    fetchSpy.mockImplementation(async (url) => {
      if (String(url).includes("getChatMember")) {
        return new Response(
          JSON.stringify({ ok: true, result: { user: { id: 7, first_name: "member" }, status: "member" } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/pause@PharosWatchBot", "test-secret", {
        chatType: "supergroup",
        fromId: 7,
      }),
      "test-secret",
      "bot-token",
    );

    expect(latestSendMessageBody().text).toMatch(/Only group admins/i);
    expect(
      db.getHistory().some((entry) => /INSERT INTO telegram_subscribers|UPDATE telegram_subscribers/i.test(entry.sql)),
    ).toBe(false);
  });

  it("denies mutating /timezone args for non-admin group users", async () => {
    const db = makeTelegramWebhookDb([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "FROM cache WHERE key = ?", rows: [], first: null },
    ]);
    fetchSpy.mockImplementation(async (url) => {
      if (String(url).includes("getChatMember")) {
        return new Response(
          JSON.stringify({ ok: true, result: { user: { id: 7, first_name: "member" }, status: "member" } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/timezone@PharosWatchBot Europe/Paris", "test-secret", {
        chatType: "supergroup",
        fromId: 7,
      }),
      "test-secret",
      "bot-token",
    );

    expect(latestSendMessageBody().text).toMatch(/Only group admins/i);
    expect(
      db.getHistory().some((entry) => /INSERT INTO telegram_subscribers|UPDATE telegram_subscribers/i.test(entry.sql)),
    ).toBe(false);
  });

  it("does not grant group mutation access from a stale cached admin membership", async () => {
    const cachedAdmin = JSON.stringify({
      status: "administrator",
      userId: "7",
      username: "oldadmin",
      firstName: "Old Admin",
    });
    const db = makeTelegramWebhookDb([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          {
            key: "telegram:chat-member:-123:7",
            value: cachedAdmin,
            updated_at: Math.floor(Date.now() / 1000),
          },
        ],
        first: null,
      },
    ]);
    fetchSpy.mockImplementation(async (url) => {
      if (String(url).includes("getChatMember")) {
        return new Response(
          JSON.stringify({ ok: true, result: { user: { id: 7, first_name: "demoted" }, status: "member" } }),
          { status: 200 },
        );
      }
      if (String(url).includes("getChatAdministrators")) {
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/mute@PharosWatchBot 22-07", "test-secret", {
        chatType: "supergroup",
        fromId: 7,
      }),
      "test-secret",
      "bot-token",
    );

    expect(latestSendMessageBody().text).toMatch(/Only group admins/i);
    expect(db.getHistory().some((entry) => entry.binds.includes("telegram:chat-member:-123:7"))).toBe(false);
    expect(
      db.getHistory().some((entry) => /INSERT INTO telegram_subscribers|UPDATE telegram_subscribers/i.test(entry.sql)),
    ).toBe(false);
  });

  it("soft gating mode warns a non-admin but still executes the gated mutation", async () => {
    const original = TELEGRAM_GROUP_ADMIN_GATING.mode;
    TELEGRAM_GROUP_ADMIN_GATING.mode = "soft";
    try {
      const db = makeTelegramWebhookDb([
        { match: "telegram_pending_disambiguation", rows: [] },
        { match: "FROM cache WHERE key = ?", rows: [], first: null },
        { match: "FROM telegram_subscribers", rows: [], first: null },
      ]);
      fetchSpy.mockImplementation(async (url) => {
        if (String(url).includes("getChatMember")) {
          return new Response(
            JSON.stringify({ ok: true, result: { user: { id: 7, first_name: "member" }, status: "member" } }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      await handleTelegramWebhook(
        db,
        makeWebhookRequest(-123, "/subscribe@PharosWatchBot dews USDC", "test-secret", {
          chatType: "supergroup",
          fromId: 7,
        }),
        "test-secret",
        "bot-token",
      );

      // Command should proceed (subscriber row written), not be denied.
      expect(db.getHistory().some((entry) => /INSERT INTO telegram_subscribers/i.test(entry.sql))).toBe(true);
      // A group_admin_denial usage event with outcome 'warned' should be recorded.
      const usageRow = db
        .getHistory()
        .find(
          (entry) =>
            entry.sql.includes("INSERT INTO telegram_usage_daily") &&
            entry.binds[1] === "group_admin_denial" &&
            entry.binds[3] === "/subscribe",
        );
      expect(usageRow).toBeDefined();
      expect(usageRow!.binds[4]).toBe("warned");
    } finally {
      TELEGRAM_GROUP_ADMIN_GATING.mode = original;
    }
  });

  it("splits long /list replies into Telegram-safe chunks", async () => {
    const subscriptions = Array.from({ length: 220 }, (_, index) => ({
      stablecoin_id: `synthetic-stablecoin-${String(index).padStart(3, "0")}-with-a-long-portfolio-label`,
      alert_dews: 1,
      alert_depeg: 1,
      alert_safety: 1,
      alert_launch: 1,
      dews_min_band: "WARNING",
      safety_mode: "downgrade-only",
      depeg_worsening_bps_step: 250,
    }));
    const db = makeTelegramWebhookDb([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM telegram_subscribers",
        rows: [],
        first: {
          global_alert_dews: 1,
          global_alert_depeg: 1,
          global_alert_safety: 1,
          global_alert_launch: 0,
          global_depeg_worsening_bps_step: 250,
          quiet_hours_enabled: 0,
          quiet_hours_start_utc: null,
          quiet_hours_end_utc: null,
        },
      },
      { match: "FROM telegram_subscriptions", rows: subscriptions },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/list"), "test-secret", "bot-token");

    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
    for (const [, init] of fetchSpy.mock.calls) {
      const body = JSON.parse(init?.body as string) as { text: string };
      expect(body.text.length).toBeLessThanOrEqual(4000);
    }
  });

  it("shows launch follows in /list and reads alert_launch from the subscription query", async () => {
    const db = makeTelegramWebhookDb([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "FROM telegram_subscribers", rows: [], first: null },
      {
        match: "FROM telegram_subscriptions",
        rows: [
          {
            stablecoin_id: "usdpt-western-union",
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

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/list"), "test-secret", "bot-token");

    const history = db.getHistory();
    const subscriptionsQuery = history.find((entry) => entry.sql.includes("FROM telegram_subscriptions"));
    expect(subscriptionsQuery?.sql).toContain("alert_launch");
    expect(sentMessageBody().text).toContain("Launch");
    expect(sentMessageBody().text).toContain("USDPT");
  });

  it("attaches a [Manage] inline button to /list when subscriptions exist", async () => {
    const db = makeTelegramWebhookDb([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "FROM telegram_subscribers", rows: [], first: null },
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

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/list"), "test-secret", "bot-token");

    const body = sentMessageBody() as {
      text: string;
      reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> };
    };
    const callbacks = (body.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
    expect(callbacks).toContain("manage:page:0");
  });

  it("omits the callback [Manage] button when /list has no explicit coin subscriptions", async () => {
    const db = makeTelegramWebhookDb([
      { match: "telegram_pending_disambiguation", rows: [] },
      {
        match: "FROM telegram_subscribers",
        rows: [],
        first: {
          global_alert_dews: 1,
          global_alert_depeg: 0,
          global_alert_safety: 0,
          global_alert_launch: 0,
          quiet_hours_enabled: 0,
          quiet_hours_start_utc: null,
          quiet_hours_end_utc: null,
        },
      },
      { match: "FROM telegram_subscriptions", rows: [] },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/list"), "test-secret", "bot-token");

    const body = sentMessageBody() as {
      text: string;
      reply_markup?: {
        inline_keyboard?: Array<Array<{ text: string; callback_data?: string; web_app?: { url: string } }>>;
      };
    };
    const buttons = (body.reply_markup?.inline_keyboard ?? []).flat();
    expect(buttons.some((button) => button.callback_data === "manage:page:0")).toBe(false);
    expect(
      buttons.some(
        (button) =>
          button.text === "Open control panel" &&
          button.web_app?.url === "https://pharos.watch/pharoswatchbot/app/?startapp=watchlist",
      ),
    ).toBe(true);
  });

  it("replies to /presets with the preset catalog", async () => {
    const db = makeTelegramWebhookDb([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/presets"), "test-secret", "bot-token");

    const body = sentMessageBody();
    const text = body.text;
    expect(text).toContain("Preset Watchlists");
    expect(text).toContain("usd-top25");
    expect(text).toContain("mcap-ge-1b");
    expectMiniAppButton(body, "Browse presets", "presets");
  });

  it("replies unknown command", async () => {
    const db = makeTelegramWebhookDb([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/attacker-controlled-token"), "test-secret", "bot-token");

    const body = sentMessageBody() as {
      text: string;
      reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> };
    };
    expect(body.text).toContain("Unknown command");
    expect((body.reply_markup?.inline_keyboard ?? []).flat()).toContainEqual({
      text: "/help",
      callback_data: "help:commands",
    });

    const usageRows = db.getHistory().filter((entry) => entry.sql.includes("INSERT INTO telegram_usage_daily"));
    expect(usageRows.map((entry) => [entry.binds[1], entry.binds[3], entry.binds[4]])).toEqual([
      ["unknown_command", "unknown", "unknown"],
      ["command", "unknown", "unknown_command"],
    ]);
  });
});

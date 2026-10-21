import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { classifyTelegramCommand, TELEGRAM_COMMAND_POLICIES } from "../telegram-webhook-ingress-policy";

import { COMMAND_HANDLERS, type WebhookCommandHandler } from "../../commands";
import { makeTelegramUpdateRequest } from "../../../test-helpers/__shared/telegram";
import {
  fetchSpy,
  handleTelegramWebhook,
  resolveTicker,
  FROZEN_STABLECOINS,
  makeWebhookRequest,
  makeCallbackRequest,
  sentMessageBody,
  makeStablecoinsCacheValue,
  latestSendMessageBody,
  resetTelegramWebhookTest,
  makeTelegramWebhookDb,
  mockTelegramMembership,
} from "./telegram-webhook.test-support.ts";


// Webhook tests exercise command routing, so stub the canonical V9 loader with
// one matching card (the fail-closed paths have their own focused tests).
// Vitest hoists this factory before static imports initialize.
vi.mock("../../../lib/safety-score-index", async () => {
  const { makeTelegramSafetySnapshot } = await import("./telegram-safety.test-support.ts");
  const snapshot = makeTelegramSafetySnapshot();
  return {
    loadActiveSafetyScoreIndex: vi.fn(async () => ({
      kind: "v9",
      snapshot,
    })),
  };
});

describe("handleTelegramWebhook", () => {
  beforeEach(resetTelegramWebhookTest);
  const sqliteFixtures = createLatestSchemaFixtureTracker();
  afterEach(sqliteFixtures.closeAll);

  it.each(Object.keys(TELEGRAM_COMMAND_POLICIES))(
    "applies the group-admin authorization matrix to %s",
    async (command) => {
      const { requiresGroupAdmin } = classifyTelegramCommand(command, "");
      const { db } = sqliteFixtures.open();
      const handler = vi.fn<WebhookCommandHandler>().mockResolvedValue(undefined);
      const previousHandler = COMMAND_HANDLERS[command];
      COMMAND_HANDLERS[command] = handler;
      try {
        for (const chatType of ["private", "group", "supergroup", "channel"] as const) {
          for (const admin of [true, false]) {
            handler.mockClear();
            fetchSpy.mockClear();
            mockTelegramMembership(fetchSpy, admin ? "administrator" : "member");
            const response = await handleTelegramWebhook(
              db,
              makeWebhookRequest(123, `${command}${chatType === "private" ? "" : "@PharosWatchBot"}`, "test-secret", {
                chatType, fromId: 111,
              }),
              "test-secret",
              "bot-token",
            );
            const scenario = `${command}/${chatType}/admin=${admin}`;
            const grouped = chatType === "group" || chatType === "supergroup";
            const dispatches = !requiresGroupAdmin || chatType === "private" || (grouped && admin);
            expect(response.status, scenario).toBe(200);
            expect(handler.mock.calls.length, scenario).toBe(dispatches ? 1 : 0);
            expect(fetchSpy.mock.calls.filter(([url]) => String(url).endsWith("/getChatMember")).length, scenario)
              .toBe(requiresGroupAdmin && grouped ? 1 : 0);
          }
        }
      } finally {
        COMMAND_HANDLERS[command] = previousHandler;
      }
    },
  );

  it.each([
    {
      label: "allows private mutating commands",
      command: "/subscribe",
      chatType: "private",
      membership: null,
      dispatches: true,
    },
    {
      label: "denies group mutating commands to members",
      command: "/subscribe",
      chatType: "supergroup",
      membership: "member",
      dispatches: false,
    },
    {
      label: "allows group mutating commands to administrators",
      command: "/subscribe",
      chatType: "supergroup",
      membership: "administrator",
      dispatches: true,
    },
    {
      label: "allows group read-only commands to members",
      command: "/status",
      chatType: "supergroup",
      membership: "member",
      dispatches: true,
    },
  ] as const)("$label", async ({ command, chatType, membership, dispatches }) => {
    const handler = vi.fn<WebhookCommandHandler>().mockResolvedValue(undefined);
    const previousHandler = COMMAND_HANDLERS[command];
    COMMAND_HANDLERS[command] = handler;
    try {
      if (membership) {
        mockTelegramMembership(fetchSpy, membership, { id: 7, is_bot: false, first_name: membership });
      }
      const db = makeTelegramWebhookDb();
      const commandText = chatType === "private" ? command : `${command}@PharosWatchBot`;
      const response = await handleTelegramWebhook(
        db,
        makeWebhookRequest(123, commandText, "test-secret", { chatType, fromId: 7 }),
        "test-secret",
        "bot-token",
      );

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalledTimes(dispatches ? 1 : 0);
    } finally {
      COMMAND_HANDLERS[command] = previousHandler;
    }
  });

  it("asks a group actor to retry when the admin lookup fails instead of denying them", async () => {
    const handler = vi.fn<WebhookCommandHandler>().mockResolvedValue(undefined);
    const previousHandler = COMMAND_HANDLERS["/subscribe"];
    COMMAND_HANDLERS["/subscribe"] = handler;
    try {
      fetchSpy.mockImplementation(async (url) => (
        String(url).includes("getChatMember")
          ? new Response("{}", { status: 502 })
          : Response.json({ ok: true })
      ));
      const response = await handleTelegramWebhook(
        makeTelegramWebhookDb(),
        makeWebhookRequest(-123, "/subscribe@PharosWatchBot dews USDC", "test-secret", { chatType: "supergroup", fromId: 7 }),
        "test-secret",
        "bot-token",
      );

      expect(response.status).toBe(200);
      expect(handler).not.toHaveBeenCalled();
      expect(latestSendMessageBody().text).toBe("Couldn't verify admin status. Please try again.");
    } finally {
      COMMAND_HANDLERS["/subscribe"] = previousHandler;
    }
  });

  it.each([
    [-123, true],
    [-100999, false],
  ])("treats a message posted as chat %s in group -123 as admin=%s", async (senderChatId, dispatches) => {
    const handler = vi.fn<WebhookCommandHandler>().mockResolvedValue(undefined);
    const previousHandler = COMMAND_HANDLERS["/subscribe"];
    COMMAND_HANDLERS["/subscribe"] = handler;
    try {
      // GroupAnonymousBot is a member, not an admin, of every group.
      mockTelegramMembership(fetchSpy, "member", { id: 1_087_968_824, is_bot: true, first_name: "Group" });
      const response = await handleTelegramWebhook(
        makeTelegramWebhookDb(),
        makeTelegramUpdateRequest({
          message: {
            chat: { id: -123, type: "supergroup" },
            from: { id: 1_087_968_824, username: "GroupAnonymousBot" },
            sender_chat: { id: senderChatId },
            text: "/subscribe@PharosWatchBot dews USDC",
          },
        }),
        "test-secret",
        "bot-token",
      );

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalledTimes(dispatches ? 1 : 0);
    } finally {
      COMMAND_HANDLERS["/subscribe"] = previousHandler;
    }
  });

  function seedStablecoinsCache(sqlite: DatabaseSync): void {
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('stablecoins', ?, ?)")
      .run(makeStablecoinsCacheValue({ "usdt-tether": 100_000_000_000, "usdc-circle": 90_000_000_000 }), Math.floor(Date.now() / 1000));
  }

  function callbackFromLatest(prefix: string): string {
    const markup = latestSendMessageBody().reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined;
    const data = (markup?.inline_keyboard ?? []).flat().map((button) => button.callback_data)
      .find((value) => value?.startsWith(prefix));
    if (!data) throw new Error(`Missing ${prefix} button`);
    return data;
  }

  it("subscribe reserve all asks for a stateless bulk:sa confirmation, then writes the global reserve flag", async () => {
    const { sqlite, db } = sqliteFixtures.open();
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe reserve all", "test-secret", { updateId: 1 }), "test-secret", "bot-token");

    const confirm = callbackFromLatest("bulk:sa:");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_disambiguation").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT global_alert_reserve FROM telegram_subscribers WHERE chat_id = '123'").get() ?? null)
      .not.toEqual({ global_alert_reserve: 1 });

    await handleTelegramWebhook(db, makeCallbackRequest(confirm, { chatId: 123, updateId: 2 }), "test-secret", "bot-token");
    expect(sqlite.prepare("SELECT global_alert_reserve FROM telegram_subscribers WHERE chat_id = '123'").get())
      .toEqual({ global_alert_reserve: 1 });
  });

  it.each([
    ["/subscribe dews usd-top25", null],
    ["/subscribe dews usd-top-25", null],
    ["/subscribe usd-top-50 depeg-step 250", 250],
  ] as const)("follows a large preset directly for %s without a confirmation", async (command, step) => {
    const { sqlite, db } = sqliteFixtures.open();
    seedStablecoinsCache(sqlite);
    await handleTelegramWebhook(db, makeWebhookRequest(123, command, "test-secret", { updateId: 1 }), "test-secret", "bot-token");

    const presetId = command.includes("top-50") ? "usd-top50" : "usd-top25";
    expect(sqlite.prepare("SELECT preset_id, depeg_worsening_bps_step FROM telegram_preset_subscriptions WHERE chat_id = '123'").all())
      .toEqual([{ preset_id: presetId, depeg_worsening_bps_step: step }]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_subscriptions WHERE chat_id = '123'").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_disambiguation").get()).toEqual({ count: 0 });
    expect(latestSendMessageBody().text).not.toContain("Something went wrong");
  });

  it.each(["/import legacy-token", "/export", "/recap", "/recap on", "/recap off", "/recap time 9"])("answers retired %s with the legacy redirect without changing preferences", async (command) => {
    const { sqlite, db } = sqliteFixtures.open();
    sqlite.exec(`
      INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at, preference_generation)
      VALUES ('123', 1, 1, 7);
      INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_dews, alert_dews_override)
      VALUES ('123', 'usdc-circle', 1, 1);
    `);
    const before = sqlite.prepare("SELECT * FROM telegram_subscriptions WHERE chat_id = '123'").all();
    await handleTelegramWebhook(db, makeWebhookRequest(123, command), "test-secret", "bot-token");
    expect(latestSendMessageBody().text).toMatch(/retired/i);
    expect(sqlite.prepare("SELECT * FROM telegram_subscriptions WHERE chat_id = '123'").all()).toEqual(before);
    expect(sqlite.prepare("SELECT preference_generation FROM telegram_subscribers WHERE chat_id = '123'").get())
      .toEqual({ preference_generation: 7 });
    expect(sqlite.prepare("SELECT * FROM telegram_pending_disambiguation").all()).toEqual([]);
  });

  it("refuses launch alerts for a preset without writing a follow", async () => {
    const { sqlite, db } = sqliteFixtures.open();
    seedStablecoinsCache(sqlite);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe launch usd-top25"), "test-secret", "bot-token");

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_preset_subscriptions").get()).toEqual({ count: 0 });
    expect(latestSendMessageBody().text).not.toContain("Something went wrong");
  });

  it("rejects mixing all with preset targets", async () => {
    const db = makeTelegramWebhookDb();
    await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/subscribe dews all usd-top25"),
      "test-secret",
      "bot-token",
    );

    expect(sentMessageBody().text).toContain("Use either &quot;all&quot; or specific tickers/presets");
  });

  it.each([
    ["/subscribe dews USDF", "pick:su:"],
    ["/unsubscribe USDF", "pick:un:"],
  ] as const)("answers ambiguous %s with stateless %s buttons and writes nothing", async (command, prefix) => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") throw new Error("Expected USDF to be ambiguous");
    const { sqlite, db } = sqliteFixtures.open();
    const coinId = ambiguous.matches[0].id;
    sqlite.prepare("INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_dews) VALUES ('123', ?, 1)").run(coinId);
    const before = sqlite.prepare("SELECT * FROM telegram_subscriptions").all();

    await handleTelegramWebhook(db, makeWebhookRequest(123, command, "test-secret", { updateId: 1 }), "test-secret", "bot-token");

    expect(callbackFromLatest(prefix)).toMatch(new RegExp(`^${prefix}`));
    expect(sqlite.prepare("SELECT * FROM telegram_subscriptions").all()).toEqual(before);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_disambiguation").get()).toEqual({ count: 0 });
  });

  it("asks for a stateless bulk:ua confirmation for /unsubscribe all, then clears every alert flag", async () => {
    const { sqlite, db } = sqliteFixtures.open();
    sqlite.exec(`
      INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at, global_alert_reserve, global_alert_launch)
      VALUES ('123', 1, 1, 1, 1);
      INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_dews) VALUES ('123', 'usdc-circle', 1);
    `);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/unsubscribe all", "test-secret", { updateId: 1 }), "test-secret", "bot-token");

    const confirm = callbackFromLatest("bulk:ua:");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_subscriptions").get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_disambiguation").get()).toEqual({ count: 0 });

    await handleTelegramWebhook(db, makeCallbackRequest(confirm, { chatId: 123, updateId: 2 }), "test-secret", "bot-token");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_subscriptions").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT global_alert_reserve, global_alert_launch FROM telegram_subscribers WHERE chat_id = '123'").get())
      .toEqual({ global_alert_reserve: 0, global_alert_launch: 0 });
  });

  it("unfollows a large preset directly without a confirmation", async () => {
    const { sqlite, db } = sqliteFixtures.open();
    seedStablecoinsCache(sqlite);
    sqlite.exec(`
      INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('123', 1, 1);
      INSERT INTO telegram_preset_subscriptions (chat_id, preset_id, alert_dews, created_at, updated_at) VALUES ('123', 'usd-top25', 1, 1, 1);
    `);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/unsubscribe usd-top25", "test-secret", { updateId: 1 }), "test-secret", "bot-token");

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_preset_subscriptions").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_disambiguation").get()).toEqual({ count: 0 });
  });

  it("allows legacy frozen coin subscriptions to be removed by exact id", async () => {
    const frozen = FROZEN_STABLECOINS[0];
    if (!frozen) {
      throw new Error("Expected at least one frozen stablecoin fixture");
    }

    const db = makeTelegramWebhookDb([{ match: "DELETE FROM telegram_subscriptions", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, `/unsubscribe ${frozen.id}`), "test-secret", "bot-token");

    expect(db.getHistory().find((entry) => entry.sql.includes("DELETE FROM telegram_subscriptions"))?.binds).toEqual([
      "123",
      frozen.id,
    ]);
    expect(sentMessageBody().text).toContain("Removed 1 coin");
  });

  it("handles D1 error gracefully", async () => {
    const db = makeTelegramWebhookDb([]);
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      // Fail the handler's read, not the ingress flood counter that runs first.
      if (sql.includes("FROM telegram_subscribers")) throw new Error("D1 error");
      return prepare(sql);
    });

    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/list"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    expect(sentMessageBody().text).toContain("Something went wrong");
  });

  it("replies with retry message when preset resolution cache is missing", async () => {
    const db = makeTelegramWebhookDb([
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
    const db = makeTelegramWebhookDb([
      { match: "FROM cache WHERE key = ?", matchBinds: ["stablecoins"], rows: [], first: null },
      { match: "DELETE FROM telegram_preset_subscriptions", rows: [] },
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
    expect(sentMessageBody().text).not.toContain("Something went wrong");
  });

});

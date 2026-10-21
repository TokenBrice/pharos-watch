import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import {
  fetchSpy,
  handleTelegramWebhook,
  makeWebhookRequest,
  sentMessageBody,
  makeStablecoinsCacheTable,
  resetTelegramWebhookTest,
  makeTelegramWebhookDb,
  fixtureLastSendMessageBody,
  mockTelegramMembership,
} from "./telegram-webhook.test-support.ts";
import type * as TelegramWebhookReplies from "../telegram-webhook-replies";
import { COMMAND_HANDLERS } from "../../commands";
import { callbackMutatesChatState, classifyTelegramCommand, TELEGRAM_COMMAND_POLICIES } from "../telegram-webhook-ingress-policy";
import { parseStartPayload } from "../telegram-webhook-parsing";

// The audited reply helper keeps its production behaviour by default; the flood
// cases below make one notice reply throw, which the helper swallows internally.
const sendAuditedTelegramReplyMock = vi.hoisted(() =>
  vi.fn<typeof TelegramWebhookReplies.sendAuditedTelegramReply>(),
);
vi.mock("../telegram-webhook-replies", async (importOriginal) => {
  const actual = await importOriginal<typeof TelegramWebhookReplies>();
  sendAuditedTelegramReplyMock.mockImplementation(actual.sendAuditedTelegramReply);
  return { ...actual, sendAuditedTelegramReply: sendAuditedTelegramReplyMock };
});


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
// Module loading inside a hoisted mock is required by Vitest's test seam.
vi.mock("../../../lib/safety-score-active-source", async () => {
  const { makeTelegramSafetySnapshot } = await import("./telegram-safety.test-support.ts");
  return { loadActiveSafetyScoreSource: vi.fn(async () => ({ kind: "v9",
    snapshot: makeTelegramSafetySnapshot(),
  })) };
});


describe("command ingress policy", () => {
  it("classifies every registered command and alias explicitly, without stale policy entries", () => {
    expect(Object.keys(TELEGRAM_COMMAND_POLICIES).sort()).toEqual(Object.keys(COMMAND_HANDLERS).sort());
    for (const command of Object.keys(COMMAND_HANDLERS)) {
      const policy = classifyTelegramCommand(command, "");
      // Only mutating commands may require a group admin.
      expect(policy.requiresGroupAdmin && policy.mutation === "none").toBe(false);
    }
  });

  it.each([
    ["/start", "", "required", false],
    ["/start", "setup", "required", false],
    ["/start", "pw1_landing_hero", "required", false],
    ["/start", "sub_dews_usdc-circle", "required", false],
    ["/start", "status_usdc-circle", "none", false],
    ["/start", "why_usdc-circle", "none", false],
    ["/start", "coverage_usdc-circle", "none", false],
    ["/start", "sample", "none", false],
    ["/start", "app", "none", false],
    ["/start", "garbage_xyz", "required", false],
    ["/subscribe", "", "required", true],
    ["/unsubscribe", "", "required", true],
    ["/pause", "", "required", true],
    ["/forget", "", "required", true],
    ["/unsnooze", "", "required", true],
    ["/settings", "", "none", false],
    ["/why", "", "none", false],
    ["/health", "", "none", false],
    ["/set", "USDC dews off", "none", false],
    ["/timezone", " UTC ", "none", false],
    ["/cancel", "", "none", false],
  ] as const)("classifies %s %j", (command, args, mutation, requiresGroupAdmin) => {
    expect(classifyTelegramCommand(command, args)).toEqual({ mutation, requiresGroupAdmin });
  });

  it.each(["pw1_landing_hero", "pw1_landing_setup"])(
    "keeps retired landing token %s on the mutating setup path",
    (token) => {
      expect(parseStartPayload(token)).toEqual({ kind: "none" });
      expect(classifyTelegramCommand("/start", token)).toMatchObject({ mutation: "required" });
    },
  );

  it.each([
    ["pick:su:x", true], ["pick:un:x", true], ["pick:st:x", false],
    ["bulk:sa:x", true], ["bulk:ua:x", true], ["bulk:no", false],
    ["forget:yes:1", true], ["forget:no", false],
    ["setup:top25", true], ["setup:undo", true], ["setup:sample", false],
    ["settings:home", false], ["settings:gt:dews", true],
    ["snooze:1h", true], ["status:usdc-circle", false],
    ["tz:UTC", false], ["unsub:usdc-circle", false], ["select:1", false], ["manage:page:1", false],
  ] as const)("classifies callback %s as mutating=%s", (data, mutating) => {
    expect(callbackMutatesChatState(data)).toBe(mutating);
  });
});

describe("handleTelegramWebhook", () => {
  beforeEach(resetTelegramWebhookTest);
  it.each(["PharosWatchBot", "OtherBot", "Pharos_Watch", "Pharos"])(
    "routes newline-delimited group commands only for the exact bot mention %s",
    async (mention) => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const previous = COMMAND_HANDLERS["/subscribe"];
      COMMAND_HANDLERS["/subscribe"] = handler;
      try {
        mockTelegramMembership(fetchSpy, "administrator");
        await handleTelegramWebhook(
          makeTelegramWebhookDb(),
          makeWebhookRequest(-123, `/subscribe@${mention}\ndews USDC`, "test-secret", {
            chatType: "supergroup", fromId: 7,
          }),
          "test-secret",
          "bot-token",
        );
        expect(handler).toHaveBeenCalledTimes(mention === "PharosWatchBot" ? 1 : 0);
        if (mention === "PharosWatchBot") expect(handler.mock.calls[0][1]).toBe("dews USDC");
      } finally {
        COMMAND_HANDLERS["/subscribe"] = previous;
      }
    },
  );
  it("drops commands over the per-chat flood cap and replies once at first exceed", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    // 21st command inside the window: counter row already at the limit of 20.
    const db = makeTelegramWebhookDb([
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
    const db = makeTelegramWebhookDb([
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

  it("returns 200 for non-command text", async () => {
    const db = makeTelegramWebhookDb();
    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "hello"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("records command replies without stamping alert delivery success", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const db = makeTelegramWebhookDb();

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/help"), "test-secret", "bot-token");

    const diagnosticInsert = db
      .getHistory()
      .find((entry) => entry.sql.includes("INSERT INTO telegram_chat_delivery_diagnostics"));
    expect(diagnosticInsert).toBeDefined();
    expect(diagnosticInsert!.sql).toContain("VALUES (?, ?, ?, ?, ?, ?)");
    expect(diagnosticInsert!.binds).toEqual(["123", null, 1_700_000_000, 1_700_000_000, null, 1_700_000_000]);
    nowSpy.mockRestore();
  });

  it("ignores unaddressed commands in group chats", async () => {
    const db = makeTelegramWebhookDb([]);
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

  function sentCallbacks(): Array<string | undefined> {
    const body = sentMessageBody() as { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } };
    return (body.reply_markup?.inline_keyboard ?? []).flat().map((button) => button.callback_data);
  }

  function wrotePendingRow(db: ReturnType<typeof makeTelegramWebhookDb>): boolean {
    return db.getHistory().some((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
  }

  it.each(["", " setup", " garbage_xyz", " pw1_landing_hero"])(
    "/start%s opens stateless onboarding with the follow-top-25 button",
    async (payload) => {
      const db = makeTelegramWebhookDb();
      const res = await handleTelegramWebhook(db, makeWebhookRequest(123, `/start${payload}`), "test-secret", "bot-token");

      expect(res.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(sentCallbacks()).toContain("setup:top25");
      expect(wrotePendingRow(db)).toBe(false);
    },
  );

  it("/start greets a returning private user with Manage Alerts, pause and help", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    sqlite.exec(`
      INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('123', 1, 1);
      INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_dews, alert_depeg) VALUES ('123', 'usdc-circle', 1, 1);
    `);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/start"), "test-secret", "bot-token");

    expect(sentMessageBody().text).toContain("Welcome back.");
    expect(sentCallbacks()).toEqual(expect.arrayContaining(["snooze:24h", "help:commands"]));
    sqlite.close();
  });

  it("/start in a group gives admins the follow-top-25 button", async () => {
    const db = makeTelegramWebhookDb();
    mockTelegramMembership(fetchSpy, "administrator");
    await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/start@PharosWatchBot", "test-secret", { chatType: "supergroup", fromId: 7 }),
      "test-secret",
      "bot-token",
    );

    const body = fixtureLastSendMessageBody<{ reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } }>(fetchSpy);
    expect((body.reply_markup?.inline_keyboard ?? []).flat().map((button) => button.callback_data)).toEqual(["setup:top25"]);
    expect(wrotePendingRow(db)).toBe(false);
  });

  it("/start in a group gives non-admins a personal-alerts link instead of setup buttons", async () => {
    const db = makeTelegramWebhookDb();
    mockTelegramMembership(fetchSpy, "member", { id: 7, is_bot: false, first_name: "member" });

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
    const body = fixtureLastSendMessageBody<{ reply_markup?: unknown }>(fetchSpy);
    expect(JSON.stringify(body.reply_markup)).toContain("start=setup");
    expect(JSON.stringify(body.reply_markup)).not.toContain("setup:top25");
    expect(wrotePendingRow(db)).toBe(false);
  });

  it("/start sub_<types>_<targets> in a private chat subscribes to the preset without a confirmation", async () => {
    const db = makeTelegramWebhookDb([
      makeStablecoinsCacheTable({
        "usdt-tether": 100_000_000_000,
        "usdc-circle": 90_000_000_000,
        "dai-makerdao": 5_000_000_000,
      }),
    ]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/start sub_dews-depeg_usd-top25"),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("FROM cache WHERE key = ?"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_preset_subscriptions"))).toBe(true);
    expect(wrotePendingRow(db)).toBe(false);
  });

  it("/start sub_<types>_<targets> in a group chat falls back to onboarding without subscribing", async () => {
    const db = makeTelegramWebhookDb();
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
    // No subscribe machinery ran (the flood counter also reads the cache table; exclude it).
    expect(
      history.some(
        (entry) =>
          entry.sql.includes("FROM cache WHERE key = ?") &&
          !entry.binds.some((bind) => String(bind).startsWith("telegram:command-flood:")),
      ),
    ).toBe(false);
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_preset_subscriptions"))).toBe(false);
    expect(wrotePendingRow(db)).toBe(false);
  });

  it.each(["status", "why", "coverage"])("/start %s_<coinId> dispatches into the status card", async (prefix) => {
    const db = makeTelegramWebhookDb([
      // Current DEWS rows require explicit accepted publication scope (WS05-B4).
      {
        match: "FROM cache WHERE key = ?", matchBinds: ["dews:published-generation"],
        rows: [{
          value: JSON.stringify({ updatedAt: 1_700_000_000, source: "compute-dews", publishStatus: "published" }),
          updated_at: 1_700_000_000,
        }],
      },
      { match: "FROM stress_signals", rows: [{ band: "CALM", score: 15, computed_at: 1_700_000_000 }] },
      { match: "FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL", rows: [] },
      {
        match: "FROM price_cache WHERE asset_id = ?",
        rows: [{ price: 0.9999, updated_at: 1_700_000_000 }],
      },
    ]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(1, `/start ${prefix}_usdc-circle`),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    const body = sentMessageBody().text;
    expect(body).toContain("USDC");
    expect(body).toContain("0.9999");
  });

  it.each([`status_${"a".repeat(60)}`, "status_usdc.circle"])(
    "/start rejects malformed payload %s and falls back to onboarding",
    async (payload) => {
      const db = makeTelegramWebhookDb();
      const res = await handleTelegramWebhook(db, makeWebhookRequest(123, `/start ${payload}`), "test-secret", "bot-token");

      expect(res.status).toBe(200);
      // Status handler did not run.
      const history = db.getHistory();
      expect(history.some((entry) => entry.sql.includes("FROM stress_signals"))).toBe(false);
      expect(history.some((entry) => entry.sql.includes("FROM price_cache"))).toBe(false);
      expect(sentCallbacks()).toContain("setup:top25");
    },
  );
});

describe("telegram webhook per-chat flood cap", () => {
  beforeEach(() => {
    resetTelegramWebhookTest();
    sendAuditedTelegramReplyMock.mockClear();
  });

  it("does not process an over-limit command when the flood notice reply throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    sendAuditedTelegramReplyMock.mockRejectedValueOnce(new Error("reply boom"));
    // 21st command inside the window: counter row already at the limit of 20.
    const db = makeTelegramWebhookDb([{ match: "RETURNING value", rows: [{ value: "21" }] }]);

    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/help"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    // Only the failed flood notice — the /help handler never produced a reply.
    expect(sendAuditedTelegramReplyMock).toHaveBeenCalledTimes(1);
    expect(String(sendAuditedTelegramReplyMock.mock.calls[0]?.[2])).toContain("Too many commands");
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
    warn.mockRestore();
  });

  it("fails closed with the busy reply when no flood scope can be evaluated", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = makeTelegramWebhookDb([
      { match: "RETURNING value", rows: [], throwError: new Error("d1 flood unavailable") },
    ]);

    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(123, "/help"),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(sendAuditedTelegramReplyMock).toHaveBeenCalledTimes(1);
    expect(String(sendAuditedTelegramReplyMock.mock.calls[0]?.[2])).toContain("Command traffic is busy");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

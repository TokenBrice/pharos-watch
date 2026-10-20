import { makeBulkPendingRow, pendingDisambiguationTable } from "./telegram-rows.test-support.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { TelegramWebhookEffectFence, createTelegramWebhookIntent } from "../telegram-webhook-effect-fence";
import { claimTelegramProcessedUpdate } from "../../store/telegram-webhook-store";
import { TELEGRAM_SUBSCRIBABLE_STABLECOINS } from "../../store/subscription-eligibility";
import { TELEGRAM_ALERT_TYPES } from "@shared/types/status";
import { classifyTelegramCommand } from "../telegram-webhook-ingress-policy";

import { COMMAND_HANDLERS, type WebhookCommandHandler } from "../../commands";
import { makePendingSelectionRow, makeSelectionSubscription } from "../../store/__tests__/telegram-selection.test-support.ts";
import {
  fetchSpy,
  handleTelegramWebhook,
  resolveTicker,
  FROZEN_STABLECOINS,
  makeWebhookRequest,
  makeCallbackRequest,
  sentMessageBody,
  makeStablecoinsCacheTable,
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

function pendingActionPayload(
  candidates: readonly unknown[],
  actionPayload: Record<string, unknown> = {},
  remainingTickers: readonly string[] = [],
): string {
  return JSON.stringify({
    ...actionPayload,
    schemaVersion: 1,
    flowId: "0123456789abcdef",
    resolvedIds: [],
    ambiguousTicker: "USDF",
    candidates,
    remainingTickers,
  });
}


describe("handleTelegramWebhook", () => {
  beforeEach(resetTelegramWebhookTest);
  const sqliteFixtures = createLatestSchemaFixtureTracker();
  afterEach(sqliteFixtures.closeAll);

  const commandPolicyCases = [
    ["/start", false, "required", "clear-and-run", true, true],
    ["/presets", false, "none", "passthrough", false, true],
    ["/help", false, "none", "passthrough", false, true],
    ["/sample", false, "none", "passthrough", false, true],
    ["/list", false, "none", "passthrough", false, true],
    ["/status", false, "none", "passthrough", false, true],
    ["/brief", false, "none", "passthrough", false, true],
    ["/market", false, "none", "passthrough", false, true],
    ["/top", false, "none", "passthrough", false, true],
    ["/why", false, "none", "passthrough", false, true],
    ["/coverage", false, "none", "passthrough", false, true],
    ["/health", false, "none", "passthrough", false, true],
    ["/subscribe", true, "required", "clear-and-run", true, false],
    ["/unsubscribe", true, "required", "clear-and-run", true, false],
    ["/set", true, "required", "clear-and-run", true, false],
    ["/settings", false, "none", "clear-and-run", false, false],
    ["/mute", true, "required", "clear-and-run", true, false],
    ["/pause", true, "required", "remind", true, false],
    ["/timezone", false, "none", "clear-and-run", true, false],
    ["/unmutehours", true, "required", "clear-and-run", true, false],
    ["/unsnooze", true, "required", "clear-and-run", true, false],
    ["/cancel", false, "required", "cancel", false, false],
    ["/forget", true, "required", "clear-and-run", false, false],
    ["/recap", false, "none", "passthrough", true, false],
  ] as const;
  it("pins every registered command in the pending-state matrix", () => {
    expect(commandPolicyCases.map(([command]) => command).sort()).toEqual(Object.keys(COMMAND_HANDLERS).sort());
  });
  it.each(commandPolicyCases)(
    "preserves the full authorization and pending matrix for %s",
    async (command, requiresGroupAdmin, mutation, pending, recoveryEligible, setupNonOwnerPassthrough) => {
      expect(classifyTelegramCommand(command, "")).toMatchObject({
        requiresGroupAdmin, mutation, pending, recoveryEligible, setupNonOwnerPassthrough,
      });
      const { sqlite, db } = sqliteFixtures.open();
      const handler = vi.fn<WebhookCommandHandler>().mockResolvedValue(undefined);
      const previousHandler = COMMAND_HANDLERS[command];
      COMMAND_HANDLERS[command] = handler;
      try {
        for (const flow of ["none", "setup", "numeric", "bulk"] as const) {
          for (const chatType of ["private", "group", "supergroup", "channel"] as const) {
            for (const owner of [true, false]) {
              for (const admin of [true, false]) {
                handler.mockClear();
                fetchSpy.mockClear();
                mockTelegramMembership(fetchSpy, admin ? "administrator" : "member");
                sqlite.exec("DELETE FROM telegram_pending_disambiguation; DELETE FROM telegram_processed_updates; DELETE FROM cache;");
                if (flow !== "none") {
                  const actionType = flow === "setup" ? "setup-step" : flow === "bulk" ? "confirm-bulk" : "subscribe";
                  const payload = flow === "setup"
                    ? { step: "branch", initiatorUserId: "111" }
                    : flow === "bulk"
                      ? { kind: "subscribe", alertTypes: ["dews"], coinIds: ["usdc-circle"], presetIds: [] }
                      : {
                        alertTypes: ["dews"], resolvedIds: [], ambiguousTicker: "USDF",
                        candidates: [{ id: "usdf-falcon", symbol: "USDF", name: "Falcon USD" }],
                        remainingTickers: [],
                      };
                  sqlite.prepare(`
                    INSERT INTO telegram_pending_disambiguation (
                      chat_id, action_type, action_payload, expires_at, initiator_user_id,
                      alert_types, resolved_ids, ambiguous_ticker, candidates, remaining_tickers
                    ) VALUES ('123', ?, ?, ?, '111', '[]', '[]', '', '[]', '[]')
                  `).run(actionType, JSON.stringify({ schemaVersion: 1, flowId: "0123456789abcdef", ...payload }), Math.floor(Date.now() / 1000) + 60);
                }
                const allowedByPending = flow === "none"
                  || (flow === "setup"
                    ? (owner ? pending !== "cancel" : setupNonOwnerPassthrough)
                    : pending === "passthrough" || (pending === "clear-and-run" && owner));
                const authorized = !requiresGroupAdmin
                  || chatType === "private"
                  || (chatType !== "channel" && admin);
                const dispatches = allowedByPending && authorized;
                const response = await handleTelegramWebhook(
                  db,
                  makeWebhookRequest(123, `${command}${chatType === "private" ? "" : "@PharosWatchBot"}`, "test-secret", {
                    chatType, fromId: owner ? 111 : 222,
                  }),
                  "test-secret",
                  "bot-token",
                );
                const scenario = `${command}/${flow}/${chatType}/owner=${owner}/admin=${admin}`;
                expect(response.status, scenario).toBe(200);
                expect(handler.mock.calls.length, scenario).toBe(dispatches ? 1 : 0);
                expect(fetchSpy.mock.calls.filter(([url]) => String(url).endsWith("/getChatMember")).length, scenario).toBe(
                  allowedByPending && requiresGroupAdmin && (chatType === "group" || chatType === "supergroup") ? 1 : 0,
                );
                if (dispatches) {
                  expect(Boolean(handler.mock.calls[0][0].clearPendingOnMutation), scenario).toBe(
                    flow !== "none" && owner && mutation === "required"
                    && (flow === "setup" || pending === "clear-and-run"),
                  );
                }
                const clearedImmediately = flow !== "none" && owner
                  && (pending === "cancel"
                    || (mutation === "none" && (flow === "setup" || pending === "clear-and-run")));
                expect(Boolean(sqlite.prepare("SELECT 1 FROM telegram_pending_disambiguation WHERE chat_id = '123'").get()), scenario)
                  .toBe(flow !== "none" && !clearedImmediately);
              }
            }
          }
        }
      } finally {
        COMMAND_HANDLERS[command] = previousHandler;
      }
    },
  );

  describe.each(["numeric", "callback"] as const)("deferred %s selection authorization", (completion) => {
    it.each([
      ["subscribe", "supergroup", "member", false],
      ["set", "supergroup", "member", false],
      ["unsubscribe", "supergroup", "member", false],
      ["subscribe", "group", "unavailable", false],
      ["set", "group", "unavailable", false],
      ["unsubscribe", "group", "unavailable", false],
      ["subscribe", "supergroup", "administrator", true],
      ["set", "supergroup", "administrator", true],
      ["unsubscribe", "supergroup", "administrator", true],
      ["subscribe", "private", "member", true],
      ["set", "private", "member", true],
      ["unsubscribe", "private", "member", true],
    ] as const)("freshly authorizes %s in %s with membership %s", async (action, chatType, membership, allowed) => {
      const { sqlite, db } = sqliteFixtures.open();
      const ambiguous = resolveTicker("USDF");
      if (ambiguous.status !== "ambiguous") throw new Error("Expected ambiguous USDF fixture");
      const coinId = ambiguous.matches[0].id;
      sqlite.prepare(`
        INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at)
        VALUES ('-123', ?, ?)
      `).run(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));
      sqlite.prepare(`
        INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_dews)
        VALUES ('-123', ?, 0)
      `).run(coinId);
      mockTelegramMembership(fetchSpy, "administrator");
      const command = action === "subscribe"
        ? "subscribe dews USDF"
        : action === "unsubscribe" ? "unsubscribe USDF" : "set USDF dews DANGER";
      const addressedCommand = chatType === "private"
        ? `/${command}`
        : `/${command.replace(" ", "@PharosWatchBot ")}`;
      const started = await handleTelegramWebhook(
        db,
        makeWebhookRequest(-123, addressedCommand, "test-secret", { chatType, fromId: 111, updateId: 800 }),
        "test-secret",
        "bot-token",
      );
      expect(started.status).toBe(200);
      expect(fetchSpy.mock.calls.filter(([url]) => String(url).endsWith("/getChatMember")))
        .toHaveLength(chatType === "private" ? 0 : 1);
      const pending = sqlite.prepare("SELECT * FROM telegram_pending_disambiguation WHERE chat_id = '-123'").get();
      expect(pending).toMatchObject({ action_type: action, initiator_user_id: "111" });
      const before = sqlite.prepare("SELECT * FROM telegram_subscriptions WHERE chat_id = '-123'").all();
      fetchSpy.mockClear();
      if (membership === "unavailable") {
        fetchSpy.mockImplementation(async (url) => new Response(
          JSON.stringify({ ok: !String(url).endsWith("/getChatMember") }),
          { status: String(url).endsWith("/getChatMember") ? 503 : 200 },
        ));
      } else {
        mockTelegramMembership(fetchSpy, membership);
      }
      const request = completion === "callback"
        ? makeCallbackRequest(`select:1:${JSON.parse(String(pending!.action_payload)).flowId}`, { chatId: -123, chatType, fromId: 111, updateId: 801 })
        : makeWebhookRequest(-123, "1", "test-secret", { chatType, fromId: 111, updateId: 801 });
      const response = await handleTelegramWebhook(db, request, "test-secret", "bot-token");
      expect(response.status).toBe(200);
      const memberCalls = fetchSpy.mock.calls.filter(([url]) => String(url).endsWith("/getChatMember"));
      expect(memberCalls).toHaveLength(chatType === "private" ? 0 : 1);
      if (chatType !== "private") {
        expect(JSON.parse(String(memberCalls[0][1]?.body))).toEqual({ chat_id: "-123", user_id: 111 });
      }
      if (allowed) {
        expect(sqlite.prepare(`
          SELECT alert_dews, dews_min_band FROM telegram_subscriptions
           WHERE chat_id = '-123' AND stablecoin_id = ?
        `).get(coinId)).toEqual(action === "unsubscribe"
          ? undefined
          : { alert_dews: 1, dews_min_band: action === "set" ? "DANGER" : null });
        expect(sqlite.prepare("SELECT * FROM telegram_pending_disambiguation WHERE chat_id = '-123'").get()).toBeUndefined();
      } else {
        expect(sqlite.prepare("SELECT * FROM telegram_subscriptions WHERE chat_id = '-123'").all()).toEqual(before);
        expect(sqlite.prepare("SELECT * FROM telegram_pending_disambiguation WHERE chat_id = '-123'").get()).toEqual(pending);
      }
    });
  });

  describe.each(["numeric", "callback", "command"] as const)("recovered %s selection authorization", (completion) => {
    it.each([
      ["supergroup", "member", 111, false],
      ["supergroup", "administrator", 111, true],
      ["supergroup", "administrator", 222, false],
      ["private", "member", 111, true],
    ] as const)("reauthorizes recovered intent in %s with %s actor %s", async (chatType, membership, actor, allowed) => {
      const { sqlite, db } = sqliteFixtures.open();
      const updateId = 802;
      const claimed = await claimTelegramProcessedUpdate(db, {
        updateId,
        nowSec: Math.floor(Date.now() / 1000) - 600,
        updateType: completion === "callback" ? "callback_query" : "message",
        chatId: "-123",
        processingStaleSec: 300,
      });
      if (claimed.status !== "claimed" || !claimed.claimOwner || claimed.claimGeneration == null) {
        throw new Error("Expected initial webhook claim");
      }
      const fence = new TelegramWebhookEffectFence(
        db, updateId, { owner: claimed.claimOwner, generation: claimed.claimGeneration }, undefined, null,
      );
      await fence.plan(createTelegramWebhookIntent("command:subscribe", {
        coinIds: ["usdc-circle"],
        presetIds: [],
        alertTypes: ["dews"],
        depegWorseningBpsStep: null,
        clearPending: true,
        flowId: "0123456789abcdef",
        initiatorUserId: "111",
      }, "required"));
      // Recover without a pending row: authorization must not depend on it.
      mockTelegramMembership(fetchSpy, membership);
      const request = completion === "callback"
        ? makeCallbackRequest("select:1:0123456789abcdef", { chatId: -123, chatType, fromId: actor, updateId })
        : makeWebhookRequest(
          -123,
          completion === "command" ? "/start@PharosWatchBot sub_dews_usdc-circle" : "1",
          "test-secret",
          { chatType, fromId: actor, updateId },
        );
      await handleTelegramWebhook(db, request, "test-secret", "bot-token");
      expect(fetchSpy.mock.calls.filter(([url]) => String(url).endsWith("/getChatMember")))
        .toHaveLength(chatType === "private" || actor !== 111 ? 0 : 1);
      expect(sqlite.prepare("SELECT stablecoin_id FROM telegram_subscriptions WHERE chat_id = '-123'").all())
        .toEqual(allowed ? [{ stablecoin_id: "usdc-circle" }] : []);
      if (!allowed) {
        expect(sqlite.prepare("SELECT mutation_applied_at FROM telegram_processed_updates WHERE update_id = ?").get(updateId))
          .toEqual({ mutation_applied_at: null });
      }
    });
  });

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

  it("subscribe reserve all (after Confirm) writes the global reserve flag", async () => {
    const db = makeTelegramWebhookDb([
      { match: "INSERT INTO telegram_subscribers", rows: [] },
      pendingDisambiguationTable(makeBulkPendingRow({
        kind: "subscribe",
        alertTypes: ["reserve"],
        coinIds: [],
        presetIds: [],
        subscribeAll: true,
      }, {
        expires_at: Math.floor(Date.now() / 1000) + 60,
        initiator_user_id: "999",
      })),
    ]);

    await handleTelegramWebhook(
      db,
      makeCallbackRequest("confirm:bulk:0123456789abcdef", { chatId: 123, fromId: 999, fromUsername: "requester" }),
      "test-secret",
      "bot-token",
    );

    const subscriberUpsert = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO telegram_subscribers"));
    expect(subscriberUpsert).toBeDefined();
    expect(subscriberUpsert!.sql).toContain("global_alert_reserve = MAX");
    const globalReserveBindIndex = 2 + TELEGRAM_ALERT_TYPES.length + TELEGRAM_ALERT_TYPES.indexOf("reserve");
    expect(subscriberUpsert!.binds[globalReserveBindIndex]).toBe(1);
  });

  it("gates /subscribe with a >10-coin preset behind a confirmation prompt", async () => {
    const db = makeTelegramWebhookDb([
      { match: "INSERT INTO telegram_pending_disambiguation", rows: [] },
      makeStablecoinsCacheTable({
        "usdt-tether": 100_000_000_000,
        "usdc-circle": 90_000_000_000,
        "dai-makerdao": 5_000_000_000,
      }),
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

  it.each(["/import legacy-token", "/export"])("treats retired %s as an unknown command without changing preferences", async (command) => {
    const { sqlite, db } = sqliteFixtures.open();
    sqlite.exec(`
      INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at, preference_generation)
      VALUES ('123', 1, 1, 7);
      INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_dews, alert_dews_override)
      VALUES ('123', 'usdc-circle', 1, 1);
    `);
    const before = sqlite.prepare("SELECT * FROM telegram_subscriptions WHERE chat_id = '123'").all();
    await handleTelegramWebhook(db, makeWebhookRequest(123, command), "test-secret", "bot-token");
    expect(latestSendMessageBody().text).toContain("Unknown command");
    expect(sqlite.prepare("SELECT * FROM telegram_subscriptions WHERE chat_id = '123'").all()).toEqual(before);
    expect(sqlite.prepare("SELECT preference_generation FROM telegram_subscribers WHERE chat_id = '123'").get())
      .toEqual({ preference_generation: 7 });
    expect(sqlite.prepare("SELECT * FROM telegram_pending_disambiguation").all()).toEqual([]);
  });


  it("gates /subscribe with a >10-coin preset and depeg-step modifier behind a confirmation prompt", async () => {
    const db = makeTelegramWebhookDb([
      { match: "INSERT INTO telegram_pending_disambiguation", rows: [] },
      makeStablecoinsCacheTable({
        "usdt-tether": 100_000_000_000,
        "usdc-circle": 90_000_000_000,
        "dai-makerdao": 5_000_000_000,
      }),
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
    const db = makeTelegramWebhookDb([
      { match: "INSERT INTO telegram_pending_disambiguation", rows: [] },
      makeStablecoinsCacheTable({
        "usdt-tether": 100_000_000_000,
        "usdc-circle": 90_000_000_000,
        "dai-makerdao": 5_000_000_000,
      }),
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
    const db = makeTelegramWebhookDb();
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe launch usd-top25"), "test-secret", "bot-token");

    expect(sentMessageBody().text).toContain("Preset watchlists support dews, depeg, and safety only");
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

  it("handles /subscribe with ambiguous ticker (disambiguation)", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to be ambiguous for disambiguation test");
    }

    const db = makeTelegramWebhookDb([{ match: "INSERT INTO telegram_pending_disambiguation", rows: [] }]);
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
    expect(buttons.some((button) => button.text.startsWith("1.") && /^select:1:[a-f0-9]{16}$/.test(button.callback_data ?? ""))).toBe(true);
  });

  it("preserves the pending initiator on chained ambiguous ticker selections", async () => {
    const firstAmbiguous = resolveTicker("USDF");
    const nextAmbiguous = resolveTicker("USDA");
    if (firstAmbiguous.status !== "ambiguous" || nextAmbiguous.status !== "ambiguous") {
      throw new Error("Expected USDF and USDA to be ambiguous for chained disambiguation test");
    }

    const db = makeTelegramWebhookDb([
      pendingDisambiguationTable(makePendingSelectionRow("subscribe", pendingActionPayload(firstAmbiguous.matches,
      { alertTypes: ["dews"], presetIds: [] },
      ["USDA"],), "999")),
    ]);
    mockTelegramMembership(fetchSpy, "administrator");

    await handleTelegramWebhook(
      db,
      makeCallbackRequest("select:1:0123456789abcdef", { chatId: -123, chatType: "supergroup", fromId: 999 }),
      "test-secret",
      "bot-token",
    );

    const followUpInsert = db.getHistory()
      .find((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"));
    expect(followUpInsert?.binds[9]).toBe("999");
  });

  it("finalizes pending disambiguation and continues remaining tickers", async () => {
    const ambiguous = resolveTicker("USDF");
    const usdc = resolveTicker("USDC");
    if (ambiguous.status !== "ambiguous" || usdc.status !== "unique") {
      throw new Error("Expected fixed ticker fixtures for telegram disambiguation flow test");
    }

    const db = makeTelegramWebhookDb([
      pendingDisambiguationTable(makePendingSelectionRow("subscribe", pendingActionPayload(ambiguous.matches,
      { alertTypes: ["dews"] },
      ["USDC"],))),
      { match: "INSERT INTO telegram_subscribers", rows: [] },
      { match: "INSERT INTO telegram_subscriptions", rows: [] },
      {
        match: "FROM telegram_subscriptions",
        matchBinds: ["123", ambiguous.matches[0].id, usdc.matches[0].id],
        rows: [
          makeSelectionSubscription(ambiguous.matches[0].id, null),
          makeSelectionSubscription(usdc.matches[0].id, null),
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

    const db = makeTelegramWebhookDb([
      pendingDisambiguationTable(makePendingSelectionRow("subscribe", pendingActionPayload(ambiguous.matches, {
        alertTypes: ["depeg"],
        presetIds: [],
        depegWorseningBpsStep: 250,
      }), "999")),
      { match: "INSERT INTO telegram_subscribers", rows: [] },
      { match: "INSERT INTO telegram_subscriptions", rows: [] },
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

    const db = makeTelegramWebhookDb([
      pendingDisambiguationTable(makePendingSelectionRow("subscribe", pendingActionPayload(ambiguous.matches, { alertTypes: ["dews"] }), "111")),
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

    const db = makeTelegramWebhookDb([
      pendingDisambiguationTable(makePendingSelectionRow("subscribe", pendingActionPayload(ambiguous.matches, { alertTypes: ["dews"] }), "999")),
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

    const db = makeTelegramWebhookDb([
      { match: "INSERT INTO telegram_pending_disambiguation", rows: [] },
      pendingDisambiguationTable(makePendingSelectionRow("subscribe", pendingActionPayload(ambiguous.matches, { alertTypes: ["dews"] }), "999")),
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

    const db = makeTelegramWebhookDb([
      pendingDisambiguationTable(makePendingSelectionRow("subscribe", pendingActionPayload(ambiguous.matches, { alertTypes: ["dews"] }), "111")),
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

    const db = makeTelegramWebhookDb([
      pendingDisambiguationTable(makePendingSelectionRow("subscribe", pendingActionPayload(ambiguous.matches, { alertTypes: ["dews"] }), "111")),
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

  it.each(["not a number", "1.5", "1abc", "1,2e0", "+1", "9007199254740992"])(
    "reminds the initiating user without changing preferences or consuming pending for %s",
    async (text) => {
      const { sqlite, db } = sqliteFixtures.open();
      await handleTelegramWebhook(
        db,
        makeWebhookRequest(123, "/subscribe dews USDF", "test-secret", { fromId: 999, updateId: 900 }),
        "test-secret",
        "bot-token",
      );
      const pendingBefore = sqlite.prepare(
        "SELECT * FROM telegram_pending_disambiguation WHERE chat_id = '123'",
      ).get();
      expect(pendingBefore).toMatchObject({ action_type: "subscribe", initiator_user_id: "999" });
      const preferencesBefore = sqlite.prepare("SELECT * FROM telegram_subscriptions WHERE chat_id = '123'").all();
      const generationBefore = sqlite.prepare("SELECT preference_generation FROM telegram_subscribers WHERE chat_id = '123'").get();
      fetchSpy.mockClear();
      const sendMarkers: unknown[] = [];
      fetchSpy.mockImplementation(async (url) => {
        if (String(url).endsWith("/sendMessage")) {
          sendMarkers.push(sqlite.prepare(
            "SELECT effect_state, effect_started_at FROM telegram_processed_updates WHERE update_id = 901",
          ).get());
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      });

      const response = await handleTelegramWebhook(
        db,
        makeWebhookRequest(123, text, "test-secret", { fromId: 999, updateId: 901 }),
        "test-secret",
        "bot-token",
      );

      expect(response.status).toBe(200);
      expect(sqlite.prepare("SELECT * FROM telegram_subscriptions WHERE chat_id = '123'").all())
        .toEqual(preferencesBefore);
      // Reply diagnostics may advance, but the subscription preference generation must not.
      expect(sqlite.prepare("SELECT preference_generation FROM telegram_subscribers WHERE chat_id = '123'").get())
        .toEqual(generationBefore);
      expect(sqlite.prepare("SELECT * FROM telegram_pending_disambiguation WHERE chat_id = '123'").get())
        .toEqual(pendingBefore);
      expect(fetchSpy.mock.calls.filter(([url]) => String(url).endsWith("/sendMessage"))).toHaveLength(1);
      expect(sendMarkers).toEqual([{ effect_state: "started", effect_started_at: expect.any(Number) }]);
      expect(sentMessageBody().text).toContain("numbers only");
      expect(sentMessageBody().text).toContain("USDF");
    },
  );

  it("allows the initiating group admin to complete a pending selection", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to be ambiguous for group ownership test");
    }

    const db = makeTelegramWebhookDb([
      pendingDisambiguationTable(makePendingSelectionRow("subscribe", pendingActionPayload(ambiguous.matches, { alertTypes: ["dews"] }), "111")),
      { match: "INSERT INTO telegram_subscribers", rows: [] },
      { match: "INSERT INTO telegram_subscriptions", rows: [] },
      {
        match: "FROM telegram_subscriptions",
        rows: [
          makeSelectionSubscription(ambiguous.matches[0].id, null),
        ],
      },
    ]);
    mockTelegramMembership(fetchSpy, "administrator");

    await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "1", "test-secret", { chatType: "supergroup", fromId: 111 }),
      "test-secret",
      "bot-token",
    );

    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))).toBe(true);
    expect(latestSendMessageBody().text).toContain("Updated subscriptions");
  });

  it("finalizes pending /unsubscribe disambiguation with the shared completion handler", async () => {
    const ambiguous = resolveTicker("USDF");
    const usdc = resolveTicker("USDC");
    if (ambiguous.status !== "ambiguous" || usdc.status !== "unique") {
      throw new Error("Expected fixed ticker fixtures for telegram unsubscribe disambiguation flow test");
    }

    const db = makeTelegramWebhookDb([
      pendingDisambiguationTable(makePendingSelectionRow("unsubscribe", pendingActionPayload(ambiguous.matches, {}, ["USDC"]))),
      { match: "DELETE FROM telegram_subscriptions", rows: [] },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "1"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_subscriptions"))).toBe(true);
    expect(sentMessageBody().text).toContain("Removed 2 coin subscriptions");
    expect(sentMessageBody().text).toContain(ambiguous.matches[0].id);
    expect(sentMessageBody().text).toContain(usdc.matches[0].id);
  });

  it("clears a pending row whose canonical payload is malformed", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const db = makeTelegramWebhookDb([
      pendingDisambiguationTable({
        action_type: "subscribe",
        action_payload: "{bad-json",
        expires_at: Math.floor(Date.now() / 1000) + 60,
      }),
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "1"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
    expect(sentMessageBody().text).toContain("pending selection could not be restored");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("field=action_payload"));
  });

  it("clears malformed active pending selections with a recovery message", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = makeTelegramWebhookDb([
      pendingDisambiguationTable({
        action_type: "subscribe",
        action_payload: JSON.stringify({
          schemaVersion: 1,
          alertTypes: ["dews"],
          resolvedIds: [],
          ambiguousTicker: "USDF",
          candidates: "{bad-json",
          remainingTickers: [],
        }),
        expires_at: Math.floor(Date.now() / 1000) + 60,
        initiator_user_id: "999",
      }),
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "1"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
    expect(sentMessageBody().text).toContain("pending selection could not be restored");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("canonical candidates are missing or malformed"));
  });

  it("gates /unsubscribe all behind a confirmation prompt", async () => {
    const db = makeTelegramWebhookDb([{ match: "INSERT INTO telegram_pending_disambiguation", rows: [] }]);
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
    expect(text).toContain("preset follows");
    expect(text).not.toContain(`${TELEGRAM_SUBSCRIBABLE_STABLECOINS.length} coins`);
  });

  it("gates /unsubscribe with a >10-coin preset behind a confirmation prompt", async () => {
    const db = makeTelegramWebhookDb([
      { match: "INSERT INTO telegram_pending_disambiguation", rows: [] },
      makeStablecoinsCacheTable({
        "usdt-tether": 100_000_000_000,
        "usdc-circle": 90_000_000_000,
        "dai-makerdao": 5_000_000_000,
      }),
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

    const db = makeTelegramWebhookDb([{ match: "DELETE FROM telegram_subscriptions", rows: [] }]);
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

    const db = makeTelegramWebhookDb([{ match: "INSERT INTO telegram_pending_disambiguation", rows: [] }]);
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
      (body.reply_markup?.inline_keyboard ?? []).flat().some((button) => /^select:1:[a-f0-9]{16}$/.test(button.callback_data ?? "")),
    ).toBe(true);
  });

  it("cancels pending disambiguation with /cancel", async () => {
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      throw new Error("Expected USDF to be ambiguous for cancel test");
    }

    const db = makeTelegramWebhookDb([
      pendingDisambiguationTable(makePendingSelectionRow("subscribe", pendingActionPayload(ambiguous.matches, { alertTypes: ["dews"] }))),
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/cancel"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
    expect(sentMessageBody().text).toContain("Pending selection cancelled");
  });

  it("unsubscribe all (after Confirm) clears launch alert flags", async () => {
    const db = makeTelegramWebhookDb([
      pendingDisambiguationTable(makeBulkPendingRow({
        kind: "unsubscribe",
        presetIds: [],
        coinIds: [],
        unsubscribeAll: true,
      }, {
        expires_at: Math.floor(Date.now() / 1000) + 60,
        initiator_user_id: "999",
      })),
    ]);

    const request = makeCallbackRequest("confirm:bulk:0123456789abcdef");
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
    const db = makeTelegramWebhookDb([]);
    vi.spyOn(db, "prepare").mockImplementationOnce(() => {
      throw new Error("D1 error");
    });

    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/list"), "test-secret", "bot-token");

    expect(res.status).toBe(200);
    expect(sentMessageBody().text).toContain("Something went wrong");
  });

  it("replies with retry message when preset resolution cache is missing", async () => {
    const db = makeTelegramWebhookDb([
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
    const db = makeTelegramWebhookDb([
      { match: "SELECT action_type, action_payload", rows: [], first: null },
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
    expect(sentMessageBody().text).toContain("current membership was unavailable for preview");
  });

  it("finalizes pending /set disambiguation with the shared completion handler", async () => {
    const ambiguous = resolveTicker("USDF");
    const usdc = resolveTicker("USDC");
    if (ambiguous.status !== "ambiguous" || usdc.status !== "unique") {
      throw new Error("Expected fixed ticker fixtures for telegram set disambiguation flow test");
    }

    const db = makeTelegramWebhookDb([
      pendingDisambiguationTable(makePendingSelectionRow("set", pendingActionPayload(ambiguous.matches, {
        ticker: "USDF", setting: "dews", enabled: true, minBand: "WARNING",
      }, ["USDC"]))),
      { match: "INSERT INTO telegram_subscribers", rows: [] },
      { match: "INSERT INTO telegram_subscriptions", rows: [] },
      {
        match: "FROM telegram_subscriptions",
        matchBinds: ["123", ambiguous.matches[0].id, usdc.matches[0].id],
        rows: [
          makeSelectionSubscription(ambiguous.matches[0].id, "WARNING"),
          makeSelectionSubscription(usdc.matches[0].id, "WARNING"),
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
});

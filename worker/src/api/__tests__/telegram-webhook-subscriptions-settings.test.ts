import { beforeEach, describe, expect, it, vi } from "vitest";
import { TELEGRAM_SUBSCRIBABLE_STABLECOINS } from "../../lib/telegram-subscription-eligibility";
import { TELEGRAM_ALERT_TYPES } from "@shared/types/status";
import { TELEGRAM_BOT_COMMANDS } from "@shared/lib/telegram-bot-registration";
import { COMMAND_HANDLERS, type WebhookCommandHandler } from "../webhook-commands";
import {
  fetchSpy,
  handleTelegramWebhook,
  resolveTicker,
  FROZEN_STABLECOINS,
  encodeWatchlistToken,
  makeWebhookRequest,
  makeCallbackRequest,
  sentMessageBody,
  makeStablecoinsCacheValue,
  resetTelegramWebhookTest,
  makeTelegramWebhookDb,
  mockTelegramMembership,
} from "./telegram-webhook.test-support";


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

function pendingActionPayload(
  candidates: readonly unknown[],
  actionPayload: Record<string, unknown> = {},
  remainingTickers: readonly string[] = [],
): string {
  return JSON.stringify({
    ...actionPayload,
    schemaVersion: 1,
    resolvedIds: [],
    ambiguousTicker: "USDF",
    candidates,
    remainingTickers,
  });
}


describe("handleTelegramWebhook", () => {
  beforeEach(resetTelegramWebhookTest);

  it.each(TELEGRAM_BOT_COMMANDS.map(({ command }) => `/${command}`))(
    "routes %s through its registered handler in a private chat",
    async (command) => {
      const handler = vi.fn<WebhookCommandHandler>().mockResolvedValue(undefined);
      const previousHandler = COMMAND_HANDLERS[command];
      COMMAND_HANDLERS[command] = handler;
      try {
        const db = makeTelegramWebhookDb();
        const response = await handleTelegramWebhook(
          db,
          makeWebhookRequest(123, command),
          "test-secret",
          "bot-token",
        );

        expect(response.status).toBe(200);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0]?.[0]).toMatchObject({
          chatId: "123",
          chatType: "private",
        });
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

  it("subscribe reserve all (after Confirm) writes the global reserve flag", async () => {
    const db = makeTelegramWebhookDb([
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
    const globalReserveBindIndex = 2 + TELEGRAM_ALERT_TYPES.length + TELEGRAM_ALERT_TYPES.indexOf("reserve");
    expect(subscriberUpsert!.binds[globalReserveBindIndex]).toBe(1);
  });

  it("gates /subscribe with a >10-coin preset behind a confirmation prompt", async () => {
    const db = makeTelegramWebhookDb([
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
    const db = makeTelegramWebhookDb();

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
    const db = makeTelegramWebhookDb();

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
    const db = makeTelegramWebhookDb();

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
    const db = makeTelegramWebhookDb();

    await handleTelegramWebhook(db, makeWebhookRequest(123, `/import ${token}`), "test-secret", "bot-token");

    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO telegram_pending_disambiguation"))).toBe(false);
    expect(sentMessageBody().text).toContain("No coins available for new alerts");
  });

  it("exports the maximum current subscribable registry as one copyable pw3 token", async () => {
    const subscriptions = TELEGRAM_SUBSCRIBABLE_STABLECOINS.map(({ id: stablecoinId }) => ({
      stablecoin_id: stablecoinId,
      alert_dews: 1,
      alert_depeg: 1,
      alert_safety: 0,
      alert_launch: 0,
      alert_reserve: 0,
      alert_dews_override: 1,
      alert_depeg_override: 1,
      alert_safety_override: 1,
      alert_launch_override: 1,
      alert_reserve_override: 1,
      dews_min_band: null,
      safety_mode: null,
      depeg_worsening_bps_step: null,
      alert_snooze_until_ts: null,
    }));
    const db = makeTelegramWebhookDb([
      { match: "FROM telegram_subscriptions", rows: subscriptions },
      { match: "FROM telegram_preset_subscriptions", rows: [] },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "/export"), "test-secret", "bot-token");

    const body = sentMessageBody();
    expect(body.text).toContain(`${subscriptions.length} direct/local rows`);
    expect(body.text).toContain("<pre>pw3.");
    expect(body.text).toContain("Import shows an exact replacement preview");
  });

  it("refuses to export an unavailable row instead of silently dropping it", async () => {
    const stablecoinId = "retired-stablecoin";
    const db = makeTelegramWebhookDb([
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
    expect(body.text).toContain("retired or unknown entries");
    expect(body.text).toContain("Nothing was changed");
    expect(body.text).not.toContain("<pre>");
  });

  it("gates /subscribe with a >10-coin preset and depeg-step modifier behind a confirmation prompt", async () => {
    const db = makeTelegramWebhookDb([
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
    const db = makeTelegramWebhookDb([
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

    const db = makeTelegramWebhookDb();
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

  it("preserves the pending initiator on chained ambiguous ticker selections", async () => {
    const firstAmbiguous = resolveTicker("USDF");
    const nextAmbiguous = resolveTicker("USDA");
    if (firstAmbiguous.status !== "ambiguous" || nextAmbiguous.status !== "ambiguous") {
      throw new Error("Expected USDF and USDA to be ambiguous for chained disambiguation test");
    }

    const db = makeTelegramWebhookDb([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: pendingActionPayload(
            firstAmbiguous.matches,
            { alertTypes: ["dews"], presetIds: [] },
            ["USDA"],
          ),
          expires_at: Math.floor(Date.now() / 1000) + 60,
          initiator_user_id: "999",
        },
      },
    ]);

    await handleTelegramWebhook(
      db,
      makeCallbackRequest("select:1", { chatId: -123, chatType: "supergroup", fromId: 999 }),
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
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: pendingActionPayload(
            ambiguous.matches,
            { alertTypes: ["dews"] },
            ["USDC"],
          ),
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

    const db = makeTelegramWebhookDb([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: pendingActionPayload(ambiguous.matches, {
            alertTypes: ["depeg"],
            presetIds: [],
            depegWorseningBpsStep: 250,
          }),
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

    const db = makeTelegramWebhookDb([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: pendingActionPayload(ambiguous.matches, { alertTypes: ["dews"] }),
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

    const db = makeTelegramWebhookDb([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: pendingActionPayload(ambiguous.matches, { alertTypes: ["dews"] }),
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

    const db = makeTelegramWebhookDb([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: pendingActionPayload(ambiguous.matches, { alertTypes: ["dews"] }),
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

    const db = makeTelegramWebhookDb([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: pendingActionPayload(ambiguous.matches, { alertTypes: ["dews"] }),
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

    const db = makeTelegramWebhookDb([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: pendingActionPayload(ambiguous.matches, { alertTypes: ["dews"] }),
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

    const db = makeTelegramWebhookDb([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: pendingActionPayload(ambiguous.matches, { alertTypes: ["dews"] }),
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

    const db = makeTelegramWebhookDb([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: pendingActionPayload(ambiguous.matches, { alertTypes: ["dews"] }),
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

    const db = makeTelegramWebhookDb([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "unsubscribe",
          action_payload: pendingActionPayload(ambiguous.matches, {}, ["USDC"]),
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

  it("clears a pending row whose canonical payload is malformed", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const db = makeTelegramWebhookDb([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: "{bad-json",
          expires_at: Math.floor(Date.now() / 1000) + 60,
        },
      },
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
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
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
        },
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "1"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
    expect(sentMessageBody().text).toContain("pending selection could not be restored");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("canonical candidates are missing or malformed"));
  });

  it("gates /unsubscribe all behind a confirmation prompt", async () => {
    const db = makeTelegramWebhookDb();
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
    const db = makeTelegramWebhookDb([
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

    const db = makeTelegramWebhookDb();
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

    const db = makeTelegramWebhookDb();
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

    const db = makeTelegramWebhookDb([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "subscribe",
          action_payload: pendingActionPayload(ambiguous.matches, { alertTypes: ["dews"] }),
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
    const db = makeTelegramWebhookDb([
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

});

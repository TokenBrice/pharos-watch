import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  fetchSpy,
  handleCallbackQuery,
  mockD1,
  resetCallbackTest,
  sendAuditedTelegramReply,
} from "./telegram-webhook-callbacks.test-support";
import {
  telegramApiCallBody,
} from "../../test-helpers/__shared/telegram";















function firstAckBody(): { text?: string } {
  return telegramApiCallBody(fetchSpy, "answerCallbackQuery", { last: false });
}



beforeEach(resetCallbackTest);

describe("handleCallbackQuery", () => {
  describe("watchlist manage (P1-U8)", () => {
    function makeSubRow(stablecoinId: string) {
      return {
        stablecoin_id: stablecoinId,
        alert_dews: 1,
        alert_depeg: 0,
        alert_safety: 0,
        alert_launch: 0,
        dews_min_band: null,
        safety_mode: null,
        depeg_worsening_bps_step: null,
      };
    }

    function editMessageBody(): {
      text: string;
      reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> };
    } {
      const editCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("editMessageText"));
      if (!editCall) throw new Error("No editMessageText call recorded");
      return JSON.parse(((editCall[1] as RequestInit).body as string) ?? "{}");
    }

    it("manage:page:0 edits the message with the first page of unsub buttons", async () => {
      const subs = [makeSubRow("usdc-circle"), makeSubRow("dai-makerdao")];
      const db = mockD1([{ match: "FROM telegram_subscriptions", rows: subs }]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-manage-0",
        data: "manage:page:0",
        from: { id: 1, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 100 },
      });

      const body = editMessageBody();
      expect(body.text).toContain("Manage watchlist");
      const callbacks = (body.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
      expect(callbacks).toContain("unsub:usdc-circle");
      expect(callbacks).toContain("unsub:dai-makerdao");
      const subscriptionSelect = db.getHistory().find((h) => h.sql.includes("FROM telegram_subscriptions"));
      expect(subscriptionSelect?.sql).toContain("alert_reserve");
      // No mutations on a pure page render.
      expect(db.getHistory().some((h) => /\bDELETE\b|\bINSERT\b/i.test(h.sql))).toBe(false);
    });

    it("manage:page:1 paginates beyond the first 5 entries", async () => {
      const ids = [
        "usdc-circle",
        "usdt-tether",
        "dai-makerdao",
        "frax-frax",
        "tusd-trueusd",
        "lusd-liquity",
        "susd-synthetix",
      ];
      const db = mockD1([{ match: "FROM telegram_subscriptions", rows: ids.map(makeSubRow) }]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-manage-1",
        data: "manage:page:1",
        from: { id: 1, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 100 },
      });

      const body = editMessageBody();
      const callbacks = (body.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
      // Page 1 of 2 should expose a Prev button back to page 0.
      expect(callbacks).toContain("manage:page:0");
      // Exactly two rows fit on the second page given 5/page.
      const unsubCount = callbacks.filter((c) => c?.startsWith("unsub:")).length;
      expect(unsubCount).toBe(2);
    });

    it("manage:page in a group allows non-admin read-only pagination", async () => {
      const db = mockD1([{ match: "FROM telegram_subscriptions", rows: [makeSubRow("usdc-circle")] }]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-manage-group",
        data: "manage:page:0",
        from: { id: 7, username: "member" },
        message: { chat: { id: -42, type: "supergroup" }, message_id: 100 },
      });

      expect(editMessageBody().text).toContain("Manage watchlist");
      expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes("getChatMember"))).toBe(false);
    });

    it("rejects malformed manage page numbers without loading subscriptions", async () => {
      const db = mockD1([]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-manage-bad",
        data: "manage:page:1.5",
        from: { id: 1, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 100 },
      });

      expect(db.getHistory().some((h) => h.sql.includes("FROM telegram_subscriptions"))).toBe(false);
      expect(firstAckBody().text).toBe("Action not recognized.");
    });

    it("unsub:<id> deletes the subscription and re-renders the same page", async () => {
      // First call (DELETE batch). Second SELECT after delete returns the remaining row.
      const remaining = [makeSubRow("dai-makerdao")];
      const db = mockD1([{ match: "FROM telegram_subscriptions", rows: remaining }]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-unsub",
        data: "unsub:usdc-circle",
        from: { id: 1, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 100 },
      });

      const history = db.getHistory();
      const deleteRow = history.find((h) => /DELETE FROM telegram_subscriptions/.test(h.sql));
      expect(deleteRow).toBeDefined();
      expect(deleteRow!.binds).toContain("usdc-circle");

      expect(firstAckBody().text).toMatch(/Removed USDC/);

      const body = editMessageBody();
      const callbacks = (body.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
      expect(callbacks).toContain("unsub:dai-makerdao");
      expect(callbacks).not.toContain("unsub:usdc-circle");
    });

    it("unsub:<id> clears the inline keyboard when the last subscription is removed", async () => {
      const db = mockD1([{ match: "FROM telegram_subscriptions", rows: [] }]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-unsub-empty",
        data: "unsub:usdc-circle",
        from: { id: 1, username: "alice" },
        message: { chat: { id: 42, type: "private" }, message_id: 100 },
      });

      const body = editMessageBody();
      expect(body.text).toContain("No coin subscriptions");
      expect(body.reply_markup?.inline_keyboard).toEqual([]);
    });

    it("unsub:<id> in a group refuses non-admin without deleting", async () => {
      const db = mockD1([
        { match: "FROM cache WHERE key = ?", rows: [], first: null },
        { match: "FROM telegram_subscriptions", rows: [] },
      ]);
      fetchSpy.mockImplementation(async (url) => {
        if (String(url).includes("getChatMember")) {
          return new Response(
            JSON.stringify({ ok: true, result: { user: { id: 7, is_bot: false, first_name: "m" }, status: "member" } }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-unsub-group",
        data: "unsub:usdc-circle",
        from: { id: 7, username: "tapping_user" },
        message: { chat: { id: -42, type: "supergroup" }, message_id: 100 },
      });

      const history = db.getHistory();
      expect(history.some((h) => /DELETE FROM telegram_subscriptions/.test(h.sql))).toBe(false);
      const ack = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
      expect(JSON.parse((ack?.[1] as RequestInit).body as string).text).toMatch(/Only group admins/);
    });

    it("unsub:<id> shifts to the previous page when the current page becomes empty", async () => {
      // After the delete the chat has 5 remaining subs -> only page 0 remains.
      const remaining = [
        makeSubRow("usdc-circle"),
        makeSubRow("usdt-tether"),
        makeSubRow("dai-makerdao"),
        makeSubRow("frax-frax"),
        makeSubRow("tusd-trueusd"),
      ];
      const db = mockD1([{ match: "FROM telegram_subscriptions", rows: remaining }]);
      // The tapped message came from page 1 — its keyboard included `manage:page:0` Prev.
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-unsub-shift",
        data: "unsub:lusd-liquity",
        from: { id: 1, username: "alice" },
        message: {
          chat: { id: 42, type: "private" },
          message_id: 100,
          reply_markup: {
            inline_keyboard: [
              [{ text: "❌ LUSD", callback_data: "unsub:lusd-liquity" }],
              [{ text: "◀ Prev", callback_data: "manage:page:0" }],
            ],
          },
        } as unknown as Parameters<typeof handleCallbackQuery>[2]["message"],
      });

      const body = editMessageBody();
      const callbacks = (body.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
      // After deletion only 5 coins remain — a single page — so no nav row.
      expect(callbacks.filter((c) => c?.startsWith("unsub:"))).toHaveLength(5);
      expect(callbacks.some((c) => c?.startsWith("manage:page:"))).toBe(false);
    });

    it("infers the current manage page from nav callback_data when labels change", async () => {
      const remaining = [
        "usdc-circle",
        "usdt-tether",
        "dai-makerdao",
        "frax-frax",
        "tusd-trueusd",
        "lusd-liquity",
        "susd-synthetix",
        "pyusd-paypal",
        "eurc-circle",
        "xaut-tether",
        "aeur-anchored-coins",
      ].map(makeSubRow);
      const db = mockD1([{ match: "FROM telegram_subscriptions", rows: remaining }]);
      await handleCallbackQuery(db, "fake-token", {
        id: "cb-unsub-relabel",
        data: "unsub:usdc-circle",
        from: { id: 1, username: "alice" },
        message: {
          chat: { id: 42, type: "private" },
          message_id: 100,
          reply_markup: {
            inline_keyboard: [
              [{ text: "Remove USDC", callback_data: "unsub:usdc-circle" }],
              [
                { text: "Back", callback_data: "manage:page:0" },
                { text: "Forward", callback_data: "manage:page:2" },
              ],
            ],
          },
        } as unknown as Parameters<typeof handleCallbackQuery>[2]["message"],
      });

      expect(editMessageBody().text).toContain("Page 2/3");
    });
  });

  it("confirm:bulk replies with an expiry toast when pending TTL has elapsed", async () => {
    const db = mockD1([
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
          expires_at: Math.floor(Date.now() / 1000) - 1,
          initiator_user_id: "999",
        },
      },
    ]);
    await handleCallbackQuery(db, "fake-token", {
      id: "cb-expired",
      data: "confirm:bulk",
      from: { id: 999, username: "requester" },
      message: { chat: { id: 123, type: "private" }, message_id: 1 },
    });

    const ackCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
    expect(ackCall).toBeDefined();
    const body = JSON.parse((ackCall?.[1] as RequestInit).body as string);
    expect(body.text).toMatch(/expired/i);
  });
});

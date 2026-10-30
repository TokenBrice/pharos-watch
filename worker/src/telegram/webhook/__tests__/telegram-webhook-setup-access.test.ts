import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fetchSpy,
  handleTelegramWebhook,
  TELEGRAM_GROUP_ADMIN_GATING,
  makeWebhookRequest,
  sentMessageBody,
  latestSendMessageBody,
  inlineButtons,
  resetTelegramWebhookTest,
  makeTelegramWebhookDb,
} from "./telegram-webhook.test-support.ts";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { TELEGRAM_LANDING_LINK_CATALOG } from "@shared/lib/telegram-landing-links";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());


describe("handleTelegramWebhook", () => {
  beforeEach(resetTelegramWebhookTest);
  it.each([["sub_depeg_usdc-circle", false], ["sub_depeg_all", true]] as const)(
    "runs subscription deep link %s without pending state",
    async (payload, confirms) => {
      const { sqlite, db } = fixtures.open();
      const response = await handleTelegramWebhook(
        db, makeWebhookRequest(123, `/start ${payload}`, "test-secret", { updateId: 2 }), "test-secret", "bot-token",
      );
      expect(response.status).toBe(200);
      if (confirms) {
        expect(latestSendMessageBody().text).toContain("Confirm");
        expect(JSON.stringify(latestSendMessageBody().reply_markup)).toContain("bulk:sa:");
      } else {
        expect(sqlite.prepare("SELECT stablecoin_id, alert_depeg FROM telegram_subscriptions WHERE chat_id = '123'").get())
          .toEqual({ stablecoin_id: "usdc-circle", alert_depeg: 1 });
      }
    },
  );

  it("handles addressed commands in group chats", async () => {
    const db = makeTelegramWebhookDb([]);
    const res = await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/help@PharosWatchBot", "test-secret", { chatType: "group" }),
      "test-secret",
      "bot-token",
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sentMessageBody().text).toContain("Pharos Watch help");
    expect(sentMessageBody().text).toContain("/subscribe@PharosWatchBot");
  });

  it("rejects channel-originated mutating commands without changing subscriptions", async () => {
    const db = makeTelegramWebhookDb([]);
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

  it("answers addressed /coverage in groups with the status card and a Follow button", async () => {
    const db = makeTelegramWebhookDb([
      { match: "FROM depeg_events", rows: [] },
      { match: "FROM dex_liquidity", rows: [] },
      { match: "FROM cache WHERE key = ?", rows: [] },
    ]);

    const coverageRes = await handleTelegramWebhook(
      db,
      makeWebhookRequest(-123, "/coverage@PharosWatchBot USDC", "test-secret", { chatType: "group", fromId: 222 }),
      "test-secret",
      "bot-token",
    );

    expect(coverageRes.status).toBe(200);
    // Coverage now reads the served yield snapshot, never the raw yield table.
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM yield_data"))).toBe(false);
    // Missing accepted DEWS scope must not fall through to diagnostic row reads.
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM stress_signals"))).toBe(false);
    const sentBodies = fetchSpy.mock.calls
      .filter((call) => String(call[0]).includes("/sendMessage"))
      .map(([, init]) => JSON.parse((init?.body as string) ?? "{}") as { text: string; reply_markup?: unknown });
    const coverageBody = sentBodies.find((body) => body.text.includes("<b>USDC</b>"));
    expect(coverageBody).toBeDefined();
    const coverageButtons = inlineButtons(coverageBody!);
    expect(coverageButtons).toEqual([{ text: "Follow USDC", callback_data: "quicksub:usdc-circle" }]);
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
    const db = makeTelegramWebhookDb([]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe dews"), "test-secret", "bot-token");

    expect(sentMessageBody().text.toLowerCase()).toContain("ticker");
  });


  it("allows non-admin group users to view /list without an admin lookup", async () => {
    const db = makeTelegramWebhookDb([
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

    expect(sentMessageBody().text).toContain("You don't follow any stablecoins yet.");
    expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes("getChatMember"))).toBe(false);
    expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes("getChatAdministrators"))).toBe(false);
  });

  it("allows non-admin group users to open the read-only group /settings view", async () => {
    const db = makeTelegramWebhookDb([
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

    expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes("getChatMember"))).toBe(false);
    expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes("getChatAdministrators"))).toBe(false);
    const sentBodies = fetchSpy.mock.calls
      .filter((call) => String(call[0]).includes("sendMessage"))
      .map((call) => JSON.parse((call[1]?.body as string) ?? "{}") as { text: string; reply_markup?: unknown });
    expect(sentBodies.some((body) => body.text.includes("<b>Settings</b>"))).toBe(true);
  });

  it("denies mutating group commands when Telegram omits from.id", async () => {
    const db = makeTelegramWebhookDb([
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
      makeWebhookRequest(-123, "/unsubscribe@PharosWatchBot all", "test-secret", {
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

  it("denies /pause for non-admin group users", async () => {
    const db = makeTelegramWebhookDb([
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

  it("does not grant group mutation access from a stale cached admin membership", async () => {
    const cachedAdmin = JSON.stringify({
      status: "administrator",
      userId: "7",
      username: "oldadmin",
      firstName: "Old Admin",
    });
    const db = makeTelegramWebhookDb([
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
      makeWebhookRequest(-123, "/unsubscribe@PharosWatchBot all", "test-secret", {
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
          { match: "FROM cache WHERE key = ?", rows: [], first: null },
        { match: "INSERT INTO telegram_subscribers", rows: [] },
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

  it("attaches the Manage Alerts button to /list in private chats", async () => {
    const db = makeTelegramWebhookDb([
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
      reply_markup?: { inline_keyboard?: Array<Array<{ text: string; web_app?: { url: string } }>> };
    };
    const buttons = (body.reply_markup?.inline_keyboard ?? []).flat();
    expect(buttons.map((button) => button.text)).toEqual(["Manage Alerts"]);
  });
});

describe("landing deep links and bare /subscribe", () => {
  beforeEach(resetTelegramWebhookTest);

  it.each(TELEGRAM_LANDING_LINK_CATALOG.map((entry) => entry.token))(
    "answers /start %s with onboarding, never the generic error",
    async (token) => {
      const { db } = fixtures.open();
      const response = await handleTelegramWebhook(
        db, makeWebhookRequest(123, `/start ${token}`, "test-secret", { updateId: 1 }), "test-secret", "bot-token",
      );
      expect(response.status).toBe(200);
      expect(latestSendMessageBody().text).not.toContain("Something went wrong");
    },
  );

  it("prompts on bare /subscribe with the one-tap choices and records outcome prompted", async () => {
    const { sqlite, db } = fixtures.open();
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe", "test-secret", { updateId: 1 }), "test-secret", "bot-token");
    const body = latestSendMessageBody();
    expect(body.text).toContain("What do you want to follow?");
    expect(JSON.stringify(body.reply_markup)).toContain("setup:top25");
    expect(sqlite.prepare("SELECT outcome, failure_class FROM telegram_usage_daily WHERE event_type = 'subscribe'").all())
      .toEqual([{ outcome: "prompted", failure_class: "" }]);
  });

  it("defaults /subscribe <ticker> to DEWS and depeg", async () => {
    const { sqlite, db } = fixtures.open();
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe USDC", "test-secret", { updateId: 1 }), "test-secret", "bot-token");
    expect(sqlite.prepare("SELECT stablecoin_id, alert_dews, alert_depeg FROM telegram_subscriptions WHERE chat_id = '123'").get())
      .toMatchObject({ stablecoin_id: "usdc-circle", alert_depeg: 1 });
  });
});

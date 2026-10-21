import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import {
  TELEGRAM_BOT_COMMANDS,
  TELEGRAM_COMMAND_NAMES,
} from "@shared/lib/telegram-bot-registration";
import type { StatusForCoin } from "../../webhook/telegram-webhook-status";
import { loadStatusForCoin } from "../../webhook/telegram-webhook-status";
import { buildStatusMessage } from "../../webhook/telegram-webhook-messages";
import { COMMAND_HANDLERS, replyToUnknownCommand } from "..";
import { HELP_COMMANDS, PRIVATE_HELP_MESSAGE, GROUP_HELP_MESSAGE, handleHelp } from "../help";
import { handleSample } from "../sample";
import { handleStatus } from "../status";
import { makeCommandContext, buttonsFromMarkup, expectMiniAppButton } from "./webhook-commands.test-support.ts";

vi.mock("../../webhook/telegram-webhook-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../webhook/telegram-webhook-status")>();
  return { ...actual, loadStatusForCoin: vi.fn() };
});

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  fixtures.closeAll();
  vi.mocked(loadStatusForCoin).mockReset();
});

const NOW = 1_700_003_600;
const statusFixture: StatusForCoin = {
  stablecoinId: "usdc-circle",
  priceUsd: 0.9999,
  priceUpdatedAt: NOW - 120,
  supplyUsd: 12_300_000_000,
  supplyObservedAt: NOW - 3600,
  supplyCurrent: true,
  dews: { band: "CALM", score: 15, computedAt: NOW - 900 },
  safety: {
    grade: "A",
    ratingStatus: "rated",
    partialEvidence: null,
    score: 82,
    model: "v9",
    methodologyVersion: "10.26",
    publicationGenerationId: "report-cards:v9:1700000000",
    publishedAt: NOW - 3 * 3600,
    recordedAt: NOW - 3 * 3600,
  },
  liquidity: { score: 91, totalTvlUsd: 450_000_000, updatedAt: NOW - 1200, current: true },
  yield: null,
  flow: null,
  depeg: { status: "stable" },
};

function writes(sqlite: ReturnType<typeof fixtures.open>["sqlite"]): unknown[] {
  return sqlite.prepare("SELECT * FROM telegram_subscribers").all();
}

describe("/status <coin>", () => {
  it("names each value's age and keeps model and generation ids off the card", () => {
    const message = buildStatusMessage("USDC", statusFixture, NOW);
    expect(message).toContain("<b>USDC</b> at $0.9999, no active depeg");
    expect(message).toContain("Safety grade A (82) · early-warning stress CALM (15/100)");
    expect(message).toContain("updated 1h ago");
    expect(message).not.toMatch(/V9|10\.26|report-cards|generation|stale|fresh|budget/i);
  });

  it("states unavailable values instead of dropping them", () => {
    const message = buildStatusMessage("USDC", {
      ...statusFixture,
      priceUsd: null,
      priceUpdatedAt: null,
      supplyUsd: null,
      dews: null,
      safety: null,
      safetyUnavailableReason: "active-source-unavailable",
    }, NOW);
    expect(message).toContain("no recent price");
    expect(message).toContain("Supply not available right now");
    expect(message).toContain("Safety grade not available right now");
    expect(message).toContain("early-warning stress not available right now");
  });

  it("replies with Follow and Manage buttons for one coin", async () => {
    const { db } = fixtures.open();
    vi.mocked(loadStatusForCoin).mockResolvedValue(statusFixture);
    const ctx = makeCommandContext(db);
    await handleStatus(ctx, "USDC");
    const [, options] = vi.mocked(ctx.replyToChatWithMarkup).mock.calls[0]!;
    const buttons = buttonsFromMarkup(options.replyMarkup);
    expect(buttons[0]).toMatchObject({ text: "Follow USDC", callback_data: "quicksub:usdc-circle" });
    expectMiniAppButton(buttons, "Manage USDC", "coin_usdc-circle");
  });
});

describe("/status (chat card)", () => {
  it("offers onboarding when the chat follows nothing", async () => {
    const { db } = fixtures.open();
    const ctx = makeCommandContext(db);
    await handleStatus(ctx, "");
    const [message, options] = vi.mocked(ctx.replyToChatWithMarkup).mock.calls[0]!;
    expect(message).toContain("You don't follow any stablecoins yet.");
    expect(buttonsFromMarkup(options.replyMarkup).map((button) => button.callback_data)).toContain("setup:top25");
  });

  it("lists follows, pause state, followed depegs and the last delivery", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec(`
      INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at, alert_snooze_until_ts)
        VALUES ('42', 1, 1, ${NOW + 3600});
      INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_depeg) VALUES ('42', 'usdc-circle', 1);
      INSERT INTO telegram_chat_delivery_diagnostics (chat_id, last_successful_delivery_at, updated_at) VALUES ('42', ${NOW - 7200}, ${NOW - 7200});
      INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peak_price, peg_reference, source)
        VALUES ('usdc-circle', 'USDC', 'peggedUSD', 'below', -120, ${NOW - 600}, 0.99, 0.988, 1, 'live'),
               ('usdt-tether', 'USDT', 'peggedUSD', 'below', -300, ${NOW - 600}, 0.98, 0.97, 1, 'live');
    `);
    const ctx = makeCommandContext(db, { operationNowSec: NOW });
    await handleStatus(ctx, "");
    const [message, options] = vi.mocked(ctx.replyToChatWithMarkup).mock.calls[0]!;
    expect(message).toContain("Alerts are paused for 1 h more.");
    expect(message).toContain("<b>Coins:</b> USDC (Depeg)");
    expect(message).toContain("<b>Off peg now:</b> USDC (peak 1.2% below)");
    expect(message).not.toContain("USDT");
    expect(message).toContain("Last alert delivered 2h ago.");
    expectMiniAppButton(buttonsFromMarkup(options.replyMarkup), "Manage Alerts", "watchlist");
    expect(writes(sqlite)).toHaveLength(1);
  });

  it("drops only the last-delivery line when the diagnostics read fails", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec(`
      INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('42', 1, 1);
      INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_depeg) VALUES ('42', 'usdc-circle', 1);
    `);
    const failing = new Proxy(db, {
      get(target, key) {
        if (key !== "prepare") return Reflect.get(target, key);
        return (sql: string) => {
          if (sql.includes("telegram_chat_delivery_diagnostics")) throw new Error("diagnostics unavailable");
          return target.prepare(sql);
        };
      },
    });
    const ctx = makeCommandContext(failing, { operationNowSec: NOW });
    await handleStatus(ctx, "");
    const [message] = vi.mocked(ctx.replyToChatWithMarkup).mock.calls[0]!;
    expect(message).toContain("<b>Coins:</b> USDC (Depeg)");
    expect(message).not.toContain("Last alert delivered");
  });

  it("omits the depeg line when the depeg read fails instead of claiming none", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec(`
      INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('42', 1, 1);
      INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_depeg) VALUES ('42', 'usdc-circle', 1);
      DROP TABLE depeg_events;
    `);
    const ctx = makeCommandContext(db, { operationNowSec: NOW });
    await handleStatus(ctx, "");
    const [message] = vi.mocked(ctx.replyToChatWithMarkup).mock.calls[0]!;
    expect(message).toContain("Alerts are on.");
    expect(message).not.toMatch(/off peg/i);
  });
});

describe("/help", () => {
  it("is short, names only live commands, and covers every menu command", async () => {
    for (const message of [PRIVATE_HELP_MESSAGE, GROUP_HELP_MESSAGE]) {
      expect(message.split("\n").length).toBeLessThanOrEqual(17);
      const named = new Set([...message.matchAll(/(?<![<\w.])\/([a-z]+)/g)].map((match) => match[1]));
      for (const command of named) {
        if (command === "pharoswatchbot") continue;
        expect(TELEGRAM_COMMAND_NAMES).toContain(command);
      }
    }
    for (const command of HELP_COMMANDS) expect(PRIVATE_HELP_MESSAGE).toContain(`/${command}`);
    for (const { command } of TELEGRAM_BOT_COMMANDS) {
      if (command !== "start" && command !== "help") expect(HELP_COMMANDS).toContain(command);
    }
    expect(GROUP_HELP_MESSAGE).toContain("/status@PharosWatchBot USDC");

    const ctx = makeCommandContext(fixtures.open().db);
    await handleHelp(ctx, "");
    expectMiniAppButton(buttonsFromMarkup(vi.mocked(ctx.replyToChatWithMarkup).mock.calls[0]![1].replyMarkup), "Manage Alerts", "watchlist");
  });
});

describe("/sample", () => {
  it("sends the shared sample with onboarding buttons and never claims a subscription state", async () => {
    const ctx = makeCommandContext(fixtures.open().db);
    await handleSample(ctx, "");
    const [message, options] = vi.mocked(ctx.replyToChatWithMarkup).mock.calls[0]!;
    expect(message).toContain("This was a sample alert.");
    expect(message).not.toContain("/unsubscribe");
    expect(buttonsFromMarkup(options.replyMarkup).map((button) => button.callback_data)).toContain("setup:top25");
  });
});

describe("retired commands and unknown commands", () => {
  it.each(["/set", "/mute", "/unmutehours", "/timezone", "/presets", "/top", "/brief", "/market", "/recap", "/cancel", "/export", "/import", "/add"])(
    "%s answers with one line and changes nothing",
    async (command) => {
      const { sqlite, db } = fixtures.open();
      const ctx = makeCommandContext(db);
      await COMMAND_HANDLERS[command]!(ctx, "USDC all on");
      const [message, options] = vi.mocked(ctx.replyToChatWithMarkup).mock.calls[0]!;
      expect(message.split("\n")).toHaveLength(1);
      expectMiniAppButton(buttonsFromMarkup(options.replyMarkup), "Manage Alerts", "watchlist");
      expect(writes(sqlite)).toEqual([]);
    },
  );

  it("redirects groups without a Mini App button", async () => {
    const ctx = makeCommandContext(fixtures.open().db, { chatType: "group" });
    await COMMAND_HANDLERS["/set"]!(ctx, "");
    expect(ctx.replyToChat).toHaveBeenCalledWith("Use /settings to change this chat&#39;s alerts.");
  });

  it("suggests the nearest command for typos", async () => {
    for (const [typed, suggestion] of [["/sunscribe", "/subscribe"], ["/subsriptions", "/subscriptions"], ["/staus", "/status"]]) {
      const ctx = makeCommandContext(fixtures.open().db);
      await replyToUnknownCommand(ctx, typed!);
      expect(vi.mocked(ctx.replyToChatWithMarkup).mock.calls[0]![0]).toContain(`Did you mean ${suggestion}?`);
    }
  });

  it("shows a coin when the command token is a ticker", async () => {
    vi.mocked(loadStatusForCoin).mockResolvedValue(statusFixture);
    const ctx = makeCommandContext(fixtures.open().db);
    await replyToUnknownCommand(ctx, "/usdc");
    expect(ctx.replyToChat).toHaveBeenCalledWith("Showing USDC. Next time: /status USDC");
    expect(vi.mocked(ctx.replyToChatWithMarkup).mock.calls[0]![0]).toContain("<b>USDC</b>");
  });

  it("falls back to Help and Manage Alerts for anything else", async () => {
    const ctx = makeCommandContext(fixtures.open().db);
    await replyToUnknownCommand(ctx, "/qqqqqqqq");
    const [message, options] = vi.mocked(ctx.replyToChatWithMarkup).mock.calls[0]!;
    expect(message).toBe("I don&#39;t know /qqqqqqqq.");
    expect(buttonsFromMarkup(options.replyMarkup).map((button) => button.callback_data ?? button.text))
      .toEqual(["help:commands", "Manage Alerts"]);
  });
});

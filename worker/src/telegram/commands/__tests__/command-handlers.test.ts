import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createTelegramFetchSpy } from "../../../test-helpers/__shared/telegram";
import { handleForget } from "../forget";
import { coinIdHash } from "../../callbacks/pick";
import { resolveTicker } from "../../common/alerts-parser";
import { handleList } from "../list";
import { handleSettings } from "../settings";
import { handleStart } from "../start";
import { handleSubscribe } from "../subscribe";
import { handleUnsubscribe } from "../unsubscribe";
import { makeCommandContext, buttonsFromMarkup, expectMiniAppButton } from "./webhook-commands.test-support.ts";

vi.mock("../../common/presets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../common/presets")>();
  return {
    ...actual,
    resolveTelegramPresetTargets: vi.fn(async (_db: D1Database, presetIds: readonly string[]) => ({
      kind: "ok",
      presets: presetIds.map((id) => ({
        definition: { id },
        stablecoinIds: ["usdc-circle"],
        coins: [{ id: "usdc-circle", symbol: "USDC", name: "USD Coin" }],
      })),
    })),
  };
});

const { fetchSpy, reset: resetTelegramFetchSpy } = createTelegramFetchSpy();
const fixtures = createLatestSchemaFixtureTracker();
const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1];
const NOW = 1_800_000_000;

beforeEach(() => {
  resetTelegramFetchSpy();
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
});
afterEach(() => {
  vi.useRealTimers();
  fixtures.closeAll();
});

describe("/subscribe and /unsubscribe", () => {
  it("follows a unique ticker for DEWS and depeg by default", async () => {
    const { sqlite, db } = fixtures.open();
    const ctx = makeCommandContext(db);
    await handleSubscribe(ctx, "USDC");
    expect(sqlite.prepare("SELECT stablecoin_id, alert_dews, alert_depeg FROM telegram_subscriptions WHERE chat_id = '42'").all())
      .toEqual([{ stablecoin_id: "usdc-circle", alert_dews: 1, alert_depeg: 1 }]);
    expect(vi.mocked(ctx.replyToChat).mock.calls[0]![0]).toContain("USDC");
  });

  it("keeps depeg off and stored depeg tuning intact when only safety is requested", async () => {
    const { sqlite, db } = fixtures.open();
    await handleSubscribe(makeCommandContext(db), "safety USDC");
    expect(sqlite.prepare("SELECT alert_safety, alert_depeg, depeg_worsening_bps_step FROM telegram_subscriptions WHERE stablecoin_id = 'usdc-circle'").get())
      .toEqual({ alert_safety: 1, alert_depeg: 0, depeg_worsening_bps_step: null });

    sqlite.exec("UPDATE telegram_subscriptions SET alert_depeg = 1, depeg_worsening_bps_step = 500");
    await handleSubscribe(makeCommandContext(db), "safety USDC");
    expect(sqlite.prepare("SELECT alert_depeg, depeg_worsening_bps_step FROM telegram_subscriptions WHERE stablecoin_id = 'usdc-circle'").get())
      .toEqual({ alert_depeg: 1, depeg_worsening_bps_step: 500 });
  });

  it("stops on an unknown ticker before writing anything", async () => {
    const { sqlite, db } = fixtures.open();
    const ctx = makeCommandContext(db);
    await handleSubscribe(ctx, "dews USDC NOTACOINXYZ");
    expect(sqlite.prepare("SELECT * FROM telegram_subscriptions").all()).toEqual([]);
    expect(vi.mocked(ctx.replyToChat).mock.calls[0]![0]).toContain("No stablecoin or preset called");
  });

  it("applies unambiguous coins and offers stateless pick buttons for an ambiguous ticker", async () => {
    const { sqlite, db } = fixtures.open();
    const ctx = makeCommandContext(db);
    await handleSubscribe(ctx, "depeg USDC USDF");
    expect(sqlite.prepare("SELECT stablecoin_id FROM telegram_subscriptions WHERE chat_id = '42'").all())
      .toEqual([{ stablecoin_id: "usdc-circle" }]);
    const [message, options] = vi.mocked(ctx.replyToChatWithMarkup).mock.calls[0]!;
    expect(message).toContain("\"USDF\" matches");
    const data = buttonsFromMarkup(options.replyMarkup).map((button) => button.callback_data);
    expect(data.length).toBeGreaterThan(1);
    expect(data[0]).toBe(`pick:su:2:USDF:${coinIdHash(resolveTicker("USDF", "subscribable").matches[0]!.id)}`);
  });

  it("follows a preset at once", async () => {
    const { sqlite, db } = fixtures.open();
    const ctx = makeCommandContext(db);
    await handleSubscribe(ctx, "usd-top25");
    expect(sqlite.prepare("SELECT preset_id, alert_dews, alert_depeg FROM telegram_preset_subscriptions").all())
      .toEqual([{ preset_id: "usd-top25", alert_dews: 1, alert_depeg: 1 }]);
  });

  it("asks once, statelessly, before following every tracked coin", async () => {
    const { sqlite, db } = fixtures.open();
    const ctx = makeCommandContext(db, { operationNowSec: NOW });
    await handleSubscribe(ctx, "depeg,safety all");
    const [message, options] = vi.mocked(ctx.replyToChatWithMarkup).mock.calls[0]!;
    expect(message).toContain("Confirm?");
    expect(buttonsFromMarkup(options.replyMarkup).map((button) => button.callback_data))
      .toEqual([`bulk:sa:6:${(NOW + 900).toString(36)}`, "bulk:no"]);
    expect(sqlite.prepare("SELECT * FROM telegram_subscribers").all()).toEqual([]);
  });

  it("answers a bare /subscribe with the one-tap choices", async () => {
    const { db } = fixtures.open();
    const ctx = makeCommandContext(db);
    await handleSubscribe(ctx, "");
    const buttons = buttonsFromMarkup(vi.mocked(ctx.replyToChatWithMarkup).mock.calls[0]![1].replyMarkup);
    expect(buttons[0]).toMatchObject({ text: "Follow the top 25 USD stablecoins", callback_data: "setup:top25" });
  });

  it("removes a direct coin and confirms /unsubscribe all statelessly", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec(`INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_dews) VALUES ('42', 'usdc-circle', 1)`);
    const ctx = makeCommandContext(db, { operationNowSec: NOW });
    await handleUnsubscribe(ctx, "USDC");
    expect(sqlite.prepare("SELECT * FROM telegram_subscriptions").all()).toEqual([]);
    await handleUnsubscribe(ctx, "all");
    expect(buttonsFromMarkup(vi.mocked(ctx.replyToChatWithMarkup).mock.calls[0]![1].replyMarkup)[0]?.callback_data)
      .toBe(`bulk:ua:${(NOW + 900).toString(36)}`);
  });
});

describe("/start onboarding", () => {
  it("shows one card with three choices to a new private user", async () => {
    const { db } = fixtures.open();
    await handleStart(makeCommandContext(db), "");
    const body = JSON.parse(String(last(fetchSpy.mock.calls)![1]!.body)) as { text: string; reply_markup: unknown };
    expect(body.text).toContain("Tap below to follow the 25 largest USD stablecoins.");
    const buttons = buttonsFromMarkup(body.reply_markup);
    expect(buttons.map((button) => button.text)).toEqual([
      "Follow the top 25 USD stablecoins",
      "Choose my own coins",
      "Show me a sample alert",
    ]);
    expect(buttons[1]?.web_app?.url).toContain("startapp=setup");
  });

  it("welcomes a returning user with what they follow", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec(`INSERT INTO telegram_preset_subscriptions (chat_id, preset_id, alert_dews, alert_depeg, alert_safety, created_at, updated_at)
      VALUES ('42', 'usd-top25', 1, 1, 0, 1, 1)`);
    await handleStart(makeCommandContext(db), "setup");
    const body = JSON.parse(String(last(fetchSpy.mock.calls)![1]!.body)) as { text: string; reply_markup: unknown };
    expect(body.text).toContain("Welcome back.");
    expect(body.text).toContain("USD Top 25");
    expect(buttonsFromMarkup(body.reply_markup).map((button) => button.callback_data ?? button.text))
      .toEqual(["Manage Alerts", "snooze:24h", "help:commands"]);
  });
});

describe("/settings, /list and /forget", () => {
  it("hands private settings off to the Mini App", async () => {
    const { db } = fixtures.open();
    const ctx = makeCommandContext(db);
    await handleSettings(ctx, "");
    const [message, options] = vi.mocked(ctx.replyToChatWithMarkup).mock.calls[0]!;
    expect(message).toContain("<b>Alert settings</b>");
    expectMiniAppButton(buttonsFromMarkup(options.replyMarkup), "Manage Alerts", "settings");
  });

  it("lists follows without engine rules or coin ids", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec(`INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_depeg) VALUES ('42', 'usdc-circle', 1)`);
    const ctx = makeCommandContext(db);
    await handleList(ctx, "");
    const [message] = vi.mocked(ctx.replyToChatWithMarkup).mock.calls[0]!;
    expect(message).toContain("<b>Coins:</b> USDC (Depeg)");
    expect(message).not.toMatch(/Precedence|usdc-circle|\/presets|\/unsnooze/);
  });

  it("prompts /forget with an expiring button, honest retention copy", async () => {
    const { db } = fixtures.open();
    const ctx = makeCommandContext(db, { operationNowSec: NOW });
    await handleForget(ctx, "");
    const [message, options] = vi.mocked(ctx.replyToChatWithMarkup).mock.calls[0]!;
    expect(message).not.toMatch(/alert-job|dead-letter|delivery audit/);
    expect(message).toContain("ids of messages already processed");
    expect(buttonsFromMarkup(options.replyMarkup).map((button) => button.callback_data))
      .toEqual([`forget:yes:${(NOW + 900).toString(36)}`, "forget:no"]);
  });
});

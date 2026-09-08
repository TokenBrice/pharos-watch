import { afterEach, describe, expect, it } from "vitest";
import { loadPerCoinExplicitlyOffMap } from "../dispatch-telegram-subscribers";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { insertTelegramSubscriber } from "./telegram-subscriber.test-support";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

describe("dispatch telegram subscriber loaders", () => {
  it.each(["depeg", "reserve", "freeze"] as const)("executes %s explicit-off eligibility across coin and chat chunks", async (type) => {
    const { sqlite, db } = fixtures.open();
    const insert = sqlite.prepare(`INSERT INTO telegram_subscriptions
      (chat_id, stablecoin_id, alert_${type}, alert_${type}_override) VALUES (?, ?, ?, ?)`);
    const chats = Array.from({ length: 46 }, (_, index) => `chat-${index}`);
    for (const chatId of [...chats, "outside", "implicit", "enabled", "enabled-override"]) {
      insertTelegramSubscriber(sqlite, { chatId });
    }
    const coins = Array.from({ length: 101 }, (_, index) => `coin-${index}`);
    for (const coin of coins) {
      for (const chat of chats) insert.run(chat, coin, 0, 1);
    }
    insert.run("outside", coins[0], 0, 1);
    insert.run(chats[0], "other-coin", 0, 1);
    insert.run("implicit", coins[0], 0, 0);
    insert.run("enabled", coins[0], 1, 0);
    insert.run("enabled-override", coins[0], 1, 1);

    const result = await loadPerCoinExplicitlyOffMap(db, [...coins, coins[0]], type, {
      chatIds: [...chats, "implicit", "enabled", "enabled-override"],
    });
    expect(result).toEqual(new Map(coins.map((coin) => [coin, new Set(chats)])));
    expect(await loadPerCoinExplicitlyOffMap(db, [coins[0]], type))
      .toEqual(new Map([[coins[0], new Set([...chats, "outside"])]]));
    expect(await loadPerCoinExplicitlyOffMap(db, coins, type, { chatIds: [] })).toEqual(new Map());
    expect(await loadPerCoinExplicitlyOffMap(db, [], type)).toEqual(new Map());
  });
});

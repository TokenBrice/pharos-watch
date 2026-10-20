import { afterEach, describe, expect, it } from "vitest";
import { loadGlobalSubscriberRows, loadPerCoinExplicitlyOffMap, loadSubscriberRowsBatch } from "../dispatch-telegram-subscribers";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { insertTelegramSubscriber } from "./telegram-subscriber.test-support";
import { TELEGRAM_ALERT_TYPES } from "@shared/types/status";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

describe("dispatch telegram subscriber loaders", () => {
  it.each(TELEGRAM_ALERT_TYPES)("selects only %s direct, global, and explicit-off recipients", async (family) => {
    const { sqlite, db } = fixtures.open();
    for (const chatId of ["direct", "global", "off", "inactive"]) {
      insertTelegramSubscriber(sqlite, { chatId, global: { [family]: chatId === "global" } });
    }
    sqlite.prepare(`INSERT INTO telegram_subscriptions
      (chat_id, stablecoin_id, alert_${family}, alert_${family}_override)
      VALUES ('direct', 'coin', 1, 1), ('off', 'coin', 0, 1), ('inactive', 'coin', 0, 0)`).run();
    const direct = await loadSubscriberRowsBatch(db, ["coin"], family, 1_800_000_000);
    expect(direct.get("coin")?.map((row) => row.chat_id)).toEqual(["direct"]);
    expect((await loadGlobalSubscriberRows(db, family, 1_800_000_000)).map((row) => row.chat_id)).toEqual(["global"]);
    expect(await loadPerCoinExplicitlyOffMap(db, ["coin"], family)).toEqual(new Map([["coin", new Set(["off"])]]));
  });

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

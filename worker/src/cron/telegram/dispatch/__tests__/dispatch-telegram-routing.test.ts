import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { TELEGRAM_ALERT_TYPES } from "@shared/types/status";
import { buildTelegramAlertsByChat } from "../dispatch-telegram-fanout-plan";
import type { TelegramFanoutPlanEvents } from "../../sources/dispatch-telegram-events";
import { loadFanoutSubscriptionInputs, type FanoutSubscriptionInputs } from "../dispatch-telegram-alerts-fanout";
import { loadGlobalSubscriberRows, loadPerCoinExplicitlyOffMap, loadSubscriberRowsBatch } from "../dispatch-telegram-subscribers";
import type { ConsolidatedAlerts, DepegAlertPayload, DewsChange, SafetyChange } from "../../../../telegram/common/alerts-formatting";
import {
  expandSubscriberChunks,
  formatPlannedSubscribers,
  planSubscriberQueue,
  routeAlertEvents,
  strictestAlertTtlSec,
  type AlertsByChatEntry,
  type RoutedSubscriberAlert,
} from "../dispatch-telegram-routing";
import { insertTelegramSubscriber, makeSubscriberRow as subscriber } from "./telegram-subscriber.test-support";

function emptyAlerts(overrides: Partial<ConsolidatedAlerts> = {}): ConsolidatedAlerts {
  return {
    dews: [],
    depegTriggered: [],
    depegResolved: [],
    depegWorsening: [],
    safety: [],
    reserve: [],
    ...overrides,
  };
}

const DEWS_WARNING: DewsChange = {
  stablecoinId: "usdc-circle",
  symbol: "USDC",
  oldBand: "WATCH",
  newBand: "WARNING",
  score: 42,
  topSignals: [{ name: "Supply", value: 74 }],
};

const DEPEG_TRIGGERED: DepegAlertPayload = {
  stablecoinId: "usdc-circle",
  symbol: "USDC",
  direction: "below",
  deviationBps: 250,
  price: 0.975,
  pegReference: 1,
};

const SAFETY_DOWNGRADE: SafetyChange = {
  stablecoinId: "usdc-circle",
  symbol: "USDC",
  oldGrade: "B+",
  newGrade: "C",
  oldScore: 78,
  newScore: 66,
};


function alertsEntry(overrides: Partial<AlertsByChatEntry>): AlertsByChatEntry {
  return {
    lastActiveAt: 1_800_000_000,
    alerts: emptyAlerts(),
    quietHoursEnabled: false,
    quietHoursStartUtc: null,
    quietHoursEndUtc: null,
    timezone: null,
    ...overrides,
  };
}

function routedAlert(
  chatId: string,
  chunks: string[],
  overrides: Partial<RoutedSubscriberAlert> = {},
): RoutedSubscriberAlert {
  return {
    chatId,
    lastActiveAt: 1_800_000_000,
    alerts: emptyAlerts({ safety: [SAFETY_DOWNGRADE] }),
    canonicalHtml: "<b>Safety Grade Change</b>",
    chunks,
    disableNotification: false,
    alertType: "safety",
    alertTypes: ["safety"],
    ...overrides,
  };
}

describe("dispatch telegram routing helpers", () => {

  it("fails closed when a planned alert has no alert types", () => {
    expect(() => strictestAlertTtlSec([])).toThrow("Telegram alert type list cannot be empty");
  });

  it("lets a per-coin row suppress the same chat's global fallback", () => {
    const alertsByChat = new Map<string, AlertsByChatEntry>();
    const specificRows = new Map([
      [
        "usdc-circle",
        [
          subscriber({
            chat_id: "same-chat",
            last_active_at: 100,
            dews_min_band: "DANGER",
          }),
        ],
      ],
    ]);
    const globalRows = [
      subscriber({
        chat_id: "same-chat",
        last_active_at: 200,
        dews_min_band: "WARNING",
        isGlobal: true,
      }),
      subscriber({
        chat_id: "global-only",
        last_active_at: 300,
        dews_min_band: "WARNING",
        isGlobal: true,
      }),
    ];

    routeAlertEvents(
      [DEWS_WARNING],
      specificRows,
      globalRows,
      alertsByChat,
      (alerts) => alerts.dews,
      (sub) => sub.dews_min_band === "WARNING",
    );

    expect([...alertsByChat.keys()]).toEqual(["global-only"]);
    expect(alertsByChat.get("global-only")?.alerts.dews).toEqual([DEWS_WARNING]);
  });

  it("records the union of follow sources per chat for the Via footer", () => {
    const alertsByChat = new Map<string, AlertsByChatEntry>();
    const preset = (presetIds: string[]) =>
      subscriber({ chat_id: "mixed", isGlobal: false, hasLocalOverride: false, presetIds });
    routeAlertEvents([DEWS_WARNING], new Map([["usdc-circle", [preset(["usd-top25"])]]]), [], alertsByChat, (alerts) => alerts.dews);
    routeAlertEvents(
      [{ ...DEWS_WARNING, stablecoinId: "dai-makerdao", symbol: "DAI" }],
      new Map([["dai-makerdao", [preset(["usd-top10"]), subscriber({ chat_id: "direct" })]]]),
      [subscriber({ chat_id: "global", isGlobal: true })],
      alertsByChat,
      (alerts) => alerts.dews,
    );

    expect(alertsByChat.get("mixed")?.via).toEqual({ presetIds: ["usd-top10", "usd-top25"], watchlist: false, allStablecoins: false });
    expect(alertsByChat.get("direct")?.via).toEqual({ presetIds: [], watchlist: true, allStablecoins: false });
    expect(alertsByChat.get("global")?.via).toEqual({ presetIds: [], watchlist: false, allStablecoins: true });
  });

  it("applies per-coin off rows to preset/specific and global fan-out", () => {
    const alertsByChat = new Map<string, AlertsByChatEntry>();
    const specificRows = new Map([
      ["usdc-circle", [subscriber({ chat_id: "preset-chat" }), subscriber({ chat_id: "specific-on" })]],
    ]);
    const globalRows = [
      subscriber({ chat_id: "global-chat", isGlobal: true }),
      subscriber({ chat_id: "global-on", isGlobal: true }),
    ];

    routeAlertEvents(
      [DEWS_WARNING],
      specificRows,
      globalRows,
      alertsByChat,
      (alerts) => alerts.dews,
      undefined,
      undefined,
      new Map([["usdc-circle", new Set(["preset-chat", "global-chat"])]]),
    );

    expect([...alertsByChat.keys()]).toEqual(["specific-on", "global-on"]);
  });

  it("formats the selected newest-first plan with dominant alert type and notification flags", () => {
    const planned = planSubscriberQueue(
      new Map([
        [
          "older",
          alertsEntry({
            lastActiveAt: 100,
            alerts: emptyAlerts({ safety: [SAFETY_DOWNGRADE] }),
            quietHoursEnabled: false,
          }),
        ],
        [
          "newer",
          alertsEntry({
            lastActiveAt: 200,
            alerts: emptyAlerts({
              dews: [DEWS_WARNING],
              depegTriggered: [DEPEG_TRIGGERED],
            }),
            quietHoursEnabled: true,
          }),
        ],
      ]),
    );
    const queue = formatPlannedSubscribers(planned, (entry) => entry.quietHoursEnabled);
    expect(queue.map((entry) => entry.chatId)).toEqual(["newer", "older"]);
    expect(queue[0].alertType).toBe("depeg");
    expect(queue[0].alertTypes).toEqual(["depeg", "dews"]);
    expect(expandSubscriberChunks([queue[0]])[0]).not.toHaveProperty("alertType");
    expect(queue[0].disableNotification).toBe(true);
    expect(queue[0].canonicalHtml).toMatch(/^▼ <b>USDC<\/b> lost its peg/);
    expect(queue[0].chunks.length).toBeGreaterThan(0);
    expect(queue[1].alertType).toBe("safety");
    expect(queue[1].disableNotification).toBe(false);
  });

  it("counts reserve alerts in the cheap pre-format chunk estimate", () => {
    const reserveAlerts = Array.from({ length: 17 }, (_, index) => ({
      stablecoinId: `reserve-${index}`,
      symbol: `R${index}`,
      name: `Reserve ${index}`,
    })) as NonNullable<ConsolidatedAlerts["reserve"]>;
    const planned = planSubscriberQueue(
      new Map([
        [
          "older-dews",
          alertsEntry({
            lastActiveAt: 100,
            alerts: emptyAlerts({ dews: [DEWS_WARNING] }),
          }),
        ],
        [
          "newer-reserve",
          alertsEntry({
            lastActiveAt: 200,
            alerts: emptyAlerts({ reserve: reserveAlerts }),
          }),
        ],
      ]),
    );

    expect(planned.map((entry) => [entry.chatId, entry.estimatedChunks])).toEqual([
      ["newer-reserve", 2],
      ["older-dews", 1],
    ]);
  });

  it("expands chunks with private-chat Mini App markup and skips blocked chats", () => {
    const privateChat = routedAlert("123", ["first", "second"]);
    const groupChat = routedAlert("-100123", ["group"]);
    const blockedChat = routedAlert("456", ["blocked"]);

    const messages = expandSubscriberChunks([privateChat, groupChat, blockedChat], new Set(["456"]));

    expect(messages.map((message) => [message.chatId, message.chunkIndex])).toEqual([
      ["123", 0],
      ["123", 1],
      ["-100123", 0],
    ]);

    const privateFirst = messages[0];
    const privateSecond = messages[1];
    const groupFirst = messages[2];
    expect(JSON.stringify(privateFirst.replyMarkup)).toContain("web_app");
    expect(JSON.stringify(privateSecond.replyMarkup)).not.toContain("web_app");
    expect(JSON.stringify(groupFirst.replyMarkup)).not.toContain("web_app");
    expect(privateFirst.linkPreviewOptions).toMatchObject({
      is_disabled: false,
      url: "https://pharos.watch/stablecoin/usdc-circle",
    });
    expect(privateSecond.linkPreviewOptions).toBeUndefined();
  });
});

describe("Fewer button target value", () => {
  it("carries the next quieter value from the row that routed the event", () => {
    const alertsByChat = new Map<string, AlertsByChatEntry>();
    routeAlertEvents(
      [DEPEG_TRIGGERED],
      new Map([["usdc-circle", [subscriber({ chat_id: "1", depeg_worsening_bps_step: 100 })]]]),
      [subscriber({ chat_id: "2", depeg_worsening_bps_step: 500, isGlobal: true })],
      alertsByChat,
      (alerts) => alerts.depegTriggered,
      () => true,
      undefined,
      undefined,
      "depeg",
    );
    const routed = formatPlannedSubscribers(planSubscriberQueue(alertsByChat), () => false);
    const fewerByChat = Object.fromEntries(expandSubscriberChunks(routed).map((message) => [
      message.chatId,
      JSON.stringify(message.replyMarkup).match(/fewer:[^"]+/)?.[0],
    ]));
    expect(fewerByChat).toEqual({ "1": "fewer:usdc-circle:ds:250", "2": "fewer:usdc-circle:ds:0" });
  });
});

const NOW_SEC = 1_800_000_000;

const FANOUT_DEWS_WARNING: DewsChange = {
  stablecoinId: "usdc-circle",
  symbol: "USDC",
  oldBand: "WATCH",
  newBand: "WARNING",
  score: 42,
  topSignals: [{ name: "Supply", value: 74 }],
};

function emptyExplicitlyOffMaps(): FanoutSubscriptionInputs["perCoinExplicitlyOffMaps"] {
  return {
    dews: new Map(),
    depeg: new Map(),
    safety: new Map(),
    reserve: new Map(),
  };
}

function fanoutInputs(overrides: Partial<FanoutSubscriptionInputs> = {}): FanoutSubscriptionInputs {
  return {
    direct: { dews: new Map(), depeg: new Map(), safety: new Map(), reserve: new Map() },
    preset: {
      dews: { kind: "ok", rows: new Map() },
      depeg: { kind: "ok", rows: new Map() },
      safety: { kind: "ok", rows: new Map() },
    },
    global: { dews: [], depeg: [], safety: [], reserve: [] },
    perCoinSnoozeMap: new Map(),
    perCoinExplicitlyOffMaps: emptyExplicitlyOffMaps(),
    ...overrides,
  };
}

function fanoutEvents(overrides: Partial<TelegramFanoutPlanEvents> = {}): TelegramFanoutPlanEvents {
  return {
    dewsChanges: [],
    depegTriggered: [],
    depegResolved: [],
    depegWorsening: [],
    safetyChanges: [],
    reservePromoted: [],
    ...overrides,
  };
}

describe("dispatch telegram fanout planning", () => {
  it("assembles distinct subscriber families and omits inactive families", async () => {
    const direct = vi.fn(async (_db: D1Database, ids: string[], type: string) =>
      new Map(ids.map((id) => [id, [subscriber({ chat_id: `direct-${type}` })]])));
    const preset = vi.fn(async (_db: D1Database, ids: string[], type: string) => ({
      kind: "ok" as const,
      rows: new Map(ids.map((id) => [id, [subscriber({ chat_id: `preset-${type}` })]])),
    }));
    const global = vi.fn(async (_db: D1Database, type: string) =>
      [subscriber({ chat_id: `global-${type}`, isGlobal: true })]);
    const snooze = vi.fn(async () => new Map([["dews-coin", new Set(["snoozed"])]]));
    const explicitlyOff = vi.fn(async (_db: D1Database, ids: readonly string[], type: string) =>
      new Map(ids.map((id) => [id, new Set([`off-${type}`])])));

    const inputs = await loadFanoutSubscriptionInputs(
      {} as D1Database,
      {
        dewsIds: ["dews-coin"],
        depegIds: ["depeg-coin"],
        safetyIds: ["safety-coin"],
        reserveIds: [],
      },
      {
        loadSubscriberRowsBatch: direct,
        loadPresetSubscribers: preset,
        loadGlobalSubscriberRows: global,
        loadPerCoinSnoozeMap: snooze,
        loadPerCoinExplicitlyOffMap: explicitlyOff,
      },
      NOW_SEC,
    );

    for (const family of ["dews", "depeg", "safety"] as const) {
      expect(inputs.direct[family].get(`${family}-coin`)?.map((row) => row.chat_id))
        .toEqual([`direct-${family}`]);
      expect(inputs.global[family].map((row) => row.chat_id)).toEqual([`global-${family}`]);
      expect(inputs.perCoinExplicitlyOffMaps[family].get(`${family}-coin`)).toEqual(new Set([`off-${family}`]));
    }
    for (const family of ["dews", "depeg", "safety"] as const) {
      expect(inputs.preset[family]).toEqual({
        kind: "ok",
        rows: new Map([[`${family}-coin`, [subscriber({ chat_id: `preset-${family}` })]]]),
      });
    }
    expect(inputs.direct.reserve).toEqual(new Map());
    expect(inputs.global.reserve).toEqual([]);
    expect(inputs.perCoinExplicitlyOffMaps.reserve).toEqual(new Map());
    expect(inputs.perCoinSnoozeMap).toEqual(new Map([["dews-coin", new Set(["snoozed"])]]));
    const routing = buildTelegramAlertsByChat({
      events: fanoutEvents({ dewsChanges: [{ ...FANOUT_DEWS_WARNING, stablecoinId: "dews-coin" }] }),
      inputs,
    });
    expect([...routing.alertsByChat.keys()].sort()).toEqual(["direct-dews", "global-dews", "preset-dews"]);
  });

  it("does not treat failed preset queries as subscribers", () => {
    const inputs = fanoutInputs({
      preset: {
        dews: { kind: "query-failed", error: new Error("d1 unavailable") },
        depeg: {
          kind: "partial",
          rows: new Map(),
          queryFailures: 0,
          resolutionFailures: 1,
        },
        safety: { kind: "ok", rows: new Map() },
      },
    });
    const routing = buildTelegramAlertsByChat({
      events: fanoutEvents({ dewsChanges: [FANOUT_DEWS_WARNING] }),
      inputs,
    });
    expect(routing).toEqual({ alertsByChat: new Map() });
  });

  it("exposes capture eligibility from routing without building rendered messages", () => {
    const routing = buildTelegramAlertsByChat({
      events: fanoutEvents({ dewsChanges: [FANOUT_DEWS_WARNING] }),
      inputs: fanoutInputs({
        direct: {
          ...fanoutInputs().direct,
          dews: new Map([
            ["usdc-circle", [subscriber({ chat_id: "eligible" })]],
          ]),
        },
      }),
    });

    expect([...routing.alertsByChat.keys()]).toEqual(["eligible"]);
    expect(routing.alertsByChat.get("eligible")?.alerts.dews).toEqual([FANOUT_DEWS_WARNING]);
    expect("subscriberQueue" in routing).toBe(false);
  });
});

const subscriberFixtures = createLatestSchemaFixtureTracker();
afterEach(() => subscriberFixtures.closeAll());

describe("dispatch telegram subscriber loaders", () => {
  it.each(TELEGRAM_ALERT_TYPES)("selects only %s direct, global, and explicit-off recipients", async (family) => {
    const { sqlite, db } = subscriberFixtures.open();
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

  it.each(["depeg"] as const)("executes %s explicit-off eligibility across coin and chat chunks", async (type) => {
    const { sqlite, db } = subscriberFixtures.open();
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

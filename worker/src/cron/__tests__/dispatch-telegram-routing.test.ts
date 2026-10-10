import { describe, expect, it } from "vitest";
import type { ConsolidatedAlerts, DepegAlertPayload, DewsChange, SafetyChange } from "../../lib/telegram/alerts";
import {
  expandSubscriberChunks,
  formatPlannedSubscribers,
  planSubscriberQueue,
  routeAlertEvents,
  strictestAlertTtlSec,
  type AlertsByChatEntry,
  type RoutedSubscriberAlert,
} from "../dispatch-telegram-routing";
import { makeSubscriberRow as subscriber } from "./telegram-subscriber.test-support";

function emptyAlerts(overrides: Partial<ConsolidatedAlerts> = {}): ConsolidatedAlerts {
  return {
    dews: [],
    depegTriggered: [],
    depegResolved: [],
    depegWorsening: [],
    safety: [],
    launch: [],
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

  it("applies per-coin snooze to both specific and global fan-out", () => {
    const alertsByChat = new Map<string, AlertsByChatEntry>();
    const specificRows = new Map([["usdc-circle", [subscriber({ chat_id: "specific-chat" })]]]);
    const globalRows = [subscriber({ chat_id: "global-chat", isGlobal: true })];

    routeAlertEvents(
      [DEWS_WARNING],
      specificRows,
      globalRows,
      alertsByChat,
      (alerts) => alerts.dews,
      undefined,
      new Map([["usdc-circle", new Set(["specific-chat", "global-chat"])]]),
    );

    expect(alertsByChat.size).toBe(0);
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
    expect(queue[0].canonicalHtml).toContain("<b>Depeg Detected</b>");
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

  it("counts freeze alerts in the cheap pre-format chunk estimate", () => {
    const freezeAlerts = Array.from({ length: 17 }, (_, index) => ({
      stablecoinId: `freeze-${index}`,
      symbol: `F${index}`,
    })) as NonNullable<ConsolidatedAlerts["freeze"]>;
    const planned = planSubscriberQueue(
      new Map([["freeze", alertsEntry({ alerts: emptyAlerts({ freeze: freezeAlerts }) })]]),
    );

    expect(planned).toMatchObject([{ alertType: "freeze", alertTypes: ["freeze"], estimatedChunks: 2 }]);
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

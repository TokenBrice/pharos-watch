import { describe, expect, it } from "vitest";
import type {
  ConsolidatedAlerts,
  DepegAlertPayload,
  DewsChange,
  SafetyChange,
} from "../../lib/telegram-alerts";
import {
  buildSubscriberQueue,
  expandSubscriberChunks,
  routeAlertEvents,
  splitFreshQueue,
  type AlertsByChatEntry,
  type RoutedSubscriberAlert,
  type SubscriberRow,
} from "../dispatch-telegram-routing";

function subscriber(overrides: Partial<SubscriberRow>): SubscriberRow {
  return {
    chat_id: "123",
    last_active_at: 1_800_000_000,
    dews_min_band: null,
    safety_mode: null,
    depeg_worsening_bps_step: null,
    global_depeg_worsening_bps_step: null,
    quiet_hours_enabled: 0,
    quiet_hours_start_utc: null,
    quiet_hours_end_utc: null,
    timezone: null,
    isGlobal: false,
    ...overrides,
  };
}

function emptyAlerts(overrides: Partial<ConsolidatedAlerts> = {}): ConsolidatedAlerts {
  return {
    dews: [],
    depegTriggered: [],
    depegResolved: [],
    depegWorsening: [],
    safety: [],
    launch: [],
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
    ...overrides,
  };
}

describe("dispatch telegram routing helpers", () => {
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
    const specificRows = new Map([
      ["usdc-circle", [subscriber({ chat_id: "specific-chat" })]],
    ]);
    const globalRows = [
      subscriber({ chat_id: "global-chat", isGlobal: true }),
    ];

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
      [
        "usdc-circle",
        [
          subscriber({ chat_id: "preset-chat" }),
          subscriber({ chat_id: "specific-on" }),
        ],
      ],
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

  it("builds a newest-first queue with dominant alert type and notification flags", () => {
    const queue = buildSubscriberQueue(
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
      (entry) => entry.quietHoursEnabled,
    );

    expect(queue.map((entry) => entry.chatId)).toEqual(["newer", "older"]);
    expect(queue[0].alertType).toBe("depeg");
    expect(queue[0].disableNotification).toBe(true);
    expect(queue[0].canonicalHtml).toContain("<b>Depeg Detected</b>");
    expect(queue[0].chunks.length).toBeGreaterThan(0);
    expect(queue[1].alertType).toBe("safety");
    expect(queue[1].disableNotification).toBe(false);
  });

  it("splits fresh sends by chunk budget and chat backoff", () => {
    const first = routedAlert("first", ["a", "b"]);
    const inBackoff = routedAlert("in-backoff", ["c"]);
    const overflow = routedAlert("overflow", ["d", "e"]);

    const result = splitFreshQueue(
      [first, inBackoff, overflow],
      3,
      new Map([["in-backoff", 1_800_000_300]]),
    );

    expect(result.toSend.map((entry) => entry.chatId)).toEqual(["first"]);
    expect(result.deferredPerChat.map((entry) => entry.chatId)).toEqual(["in-backoff"]);
    expect(result.toEnqueue.map((entry) => entry.chatId)).toEqual(["in-backoff", "overflow"]);
  });

  it("expands chunks with private-chat Mini App markup and skips blocked chats", () => {
    const privateChat = routedAlert("123", ["first", "second"]);
    const groupChat = routedAlert("-100123", ["group"]);
    const blockedChat = routedAlert("456", ["blocked"]);

    const messages = expandSubscriberChunks(
      [privateChat, groupChat, blockedChat],
      new Set(["456"]),
    );

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

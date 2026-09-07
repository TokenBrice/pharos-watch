import { describe, expect, it } from "vitest";
import type { ConsolidatedAlerts, DepegAlertPayload, DewsChange, SafetyChange } from "../../lib/telegram/alerts";
import {
  collapseBurstChats,
  expandSubscriberChunks,
  formatPlannedSubscribers,
  planSubscriberQueue,
  routeAlertEvents,
  selectChatsToFormat,
  splitFreshQueue,
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

const SUBSCRIBER_ROW_FIXTURE = {
  chat_id: "123", last_active_at: 1_800_000_000,
  dews_min_band: null, safety_mode: null,
  depeg_worsening_bps_step: null, global_depeg_worsening_bps_step: null,
  quiet_hours_enabled: 0, quiet_hours_start_utc: null,
  quiet_hours_end_utc: null, timezone: null, isGlobal: false,
};

function alertsEntry(overrides: Partial<AlertsByChatEntry>): AlertsByChatEntry {
  return {
    lastActiveAt: 1_800_000_000,
    alerts: emptyAlerts(),
    quietHoursEnabled: false,
    quietHoursStartUtc: null,
    quietHoursEndUtc: null,
    timezone: null,
    specificCount: 0,
    globalCount: 0,
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
  it.each([
    [{}, SUBSCRIBER_ROW_FIXTURE],
    [{ chat_id: "42", isGlobal: true }, { ...SUBSCRIBER_ROW_FIXTURE, chat_id: "42", isGlobal: true }],
  ])("builds canonical subscriber rows %#", (overrides, expected) => expect(subscriber(overrides)).toEqual(expected));

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
    const selected = selectChatsToFormat(planned, 10);
    const queue = formatPlannedSubscribers(selected.toFormat, (entry) => entry.quietHoursEnabled);

    expect(selected.overflow).toEqual([]);
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

  it("splits fresh sends by chunk budget and chat backoff", () => {
    const first = routedAlert("first", ["a", "b"]);
    const inBackoff = routedAlert("in-backoff", ["c"]);
    const overflow = routedAlert("overflow", ["d", "e"]);

    const result = splitFreshQueue([first, inBackoff, overflow], 3, new Map([["in-backoff", 1_800_000_300]]));

    expect(result.toSend.map((entry) => entry.chatId)).toEqual(["first"]);
    expect(result.deferredPerChat.map((entry) => entry.chatId)).toEqual(["in-backoff"]);
    expect(result.toEnqueue.map((entry) => entry.chatId)).toEqual(["in-backoff", "overflow"]);
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
    const selected = selectChatsToFormat(planned, 2);
    expect(selected.toFormat.map((entry) => entry.chatId)).toEqual(["newer-reserve"]);
    expect(selected.overflow.map((entry) => entry.chatId)).toEqual(["older-dews"]);
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

describe("collapseBurstChats (C128)", () => {
  const burstAlerts = (ids: string[]): ConsolidatedAlerts => ({
    dews: ids.map((id) => ({ stablecoinId: id }) as unknown as DewsChange),
    depegTriggered: [],
    depegResolved: [],
    depegWorsening: [],
    safety: [],
    launch: [],
    reserve: [],
  });
  const entry = (alerts: ConsolidatedAlerts, globalCount: number, specificCount = 0): AlertsByChatEntry =>
    alertsEntry({ alerts, globalCount, specificCount });

  it("collapses a global-dominant chat over the threshold into one burst summary", () => {
    const map = new Map([["100", entry(burstAlerts(["a", "b", "c"]), 3)]]);
    const out = collapseBurstChats(map, {}, 1000, 2, 1800);
    expect(out.collapsedChats).toBe(1);
    expect(map.get("100")?.alerts.burst?.coinCount).toBe(3);
    expect(out.markers["100"]?.coinIds.slice().sort()).toEqual(["a", "b", "c"]);
  });

  it("does not collapse when explicit subscriptions dominate", () => {
    const map = new Map([["100", entry(burstAlerts(["a", "b", "c"]), 0, 3)]]);
    const out = collapseBurstChats(map, {}, 1000, 2, 1800);
    expect(out.collapsedChats).toBe(0);
    expect(map.get("100")?.alerts.burst).toBeUndefined();
  });

  it("sends only the delta on a later run and suppresses when nothing is new", () => {
    const run1 = new Map([["100", entry(burstAlerts(["a", "b"]), 2)]]);
    const out1 = collapseBurstChats(run1, {}, 1000, 2, 1800);
    expect(run1.get("100")?.alerts.burst?.coinCount).toBe(2);

    const run2 = new Map([["100", entry(burstAlerts(["a", "b", "c"]), 3)]]);
    const out2 = collapseBurstChats(run2, out1.markers, 1100, 2, 1800);
    expect(run2.get("100")?.alerts.burst?.coinCount).toBe(1);
    // TTL is anchored to the first burst entry, not refreshed on the delta run.
    expect(out2.markers["100"]?.enteredAt).toBe(out1.markers["100"]?.enteredAt);

    const run3 = new Map([["100", entry(burstAlerts(["a", "b", "c"]), 3)]]);
    const out3 = collapseBurstChats(run3, out2.markers, 1200, 2, 1800);
    expect(run3.has("100")).toBe(false);
    expect(out3.deltaSuppressed).toBe(1);
  });

  it("expires the marker after the TTL and treats the run as a fresh burst", () => {
    const map = new Map([["100", entry(burstAlerts(["a", "b", "c"]), 3)]]);
    const out = collapseBurstChats(map, { "100": { enteredAt: 1000, coinIds: ["a", "b", "c"] } }, 1000 + 1801, 2, 1800);
    expect(map.get("100")?.alerts.burst?.coinCount).toBe(3);
    expect(out.markers["100"]?.enteredAt).toBe(1000 + 1801);
  });

  it("is a no-op at the default (very high) threshold", () => {
    const map = new Map([["100", entry(burstAlerts(["a", "b", "c"]), 3)]]);
    const out = collapseBurstChats(map, {}, 1000);
    expect(out.collapsedChats).toBe(0);
    expect(map.get("100")?.alerts.burst).toBeUndefined();
  });

  it("includes freeze-only alerts in burst collapse identity and attribution", () => {
    const freezeAlerts = ["frozen-a", "frozen-b"].map((stablecoinId) => ({ stablecoinId })) as NonNullable<ConsolidatedAlerts["freeze"]>;
    const map = new Map([["100", entry(emptyAlerts({ freeze: freezeAlerts }), 2)]]);

    const out = collapseBurstChats(map, {}, 1000, 2, 1800);

    expect(map.get("100")?.alerts.burst).toMatchObject({
      coinCount: 2,
      dominantFamily: "freeze",
      stablecoinIds: ["frozen-a", "frozen-b"],
    });
    expect(out.markers["100"]?.coinIds).toEqual(["frozen-a", "frozen-b"]);
  });
});

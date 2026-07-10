import { describe, expect, it } from "vitest";
import type { DewsChange } from "../../lib/telegram-alerts";
import {
  buildTelegramAlertsByChat,
  buildTelegramFanoutPlan,
  summarizePresetFanoutFailures,
  type TelegramFanoutPlanEvents,
} from "../dispatch-telegram-fanout-plan";
import type { FanoutSubscriptionInputs } from "../dispatch-telegram-alerts-fanout";
import {
  emptyAlerts,
  type PlannedSubscriberAlert,
  type SubscriberRow,
} from "../dispatch-telegram-routing";

const NOW_SEC = 1_800_000_000;

const DEWS_WARNING: DewsChange = {
  stablecoinId: "usdc-circle",
  symbol: "USDC",
  oldBand: "WATCH",
  newBand: "WARNING",
  score: 42,
  topSignals: [{ name: "Supply", value: 74 }],
};

function subscriber(overrides: Partial<SubscriberRow>): SubscriberRow {
  return {
    chat_id: "100",
    last_active_at: NOW_SEC,
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

function emptyExplicitlyOffMaps(): FanoutSubscriptionInputs["perCoinExplicitlyOffMaps"] {
  return {
    dews: new Map(),
    depeg: new Map(),
    safety: new Map(),
    launch: new Map(),
    reserve: new Map(),
  };
}

function fanoutInputs(overrides: Partial<FanoutSubscriptionInputs> = {}): FanoutSubscriptionInputs {
  return {
    directDewsSubs: new Map(),
    directDepegSubs: new Map(),
    directSafetySubs: new Map(),
    launchSubs: new Map(),
    reserveSubs: new Map(),
    presetDewsResult: { kind: "ok", rows: new Map() },
    presetDepegResult: { kind: "ok", rows: new Map() },
    presetSafetyResult: { kind: "ok", rows: new Map() },
    globalDewsSubs: [],
    globalDepegSubs: [],
    globalSafetySubs: [],
    globalLaunchSubs: [],
    globalReserveSubs: [],
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
    launchPromoted: [],
    reservePromoted: [],
    ...overrides,
  };
}

function overflowPlan(chatId: string): PlannedSubscriberAlert {
  return {
    chatId,
    alertType: "dews",
    estimatedChunks: 1,
    entry: {
      lastActiveAt: NOW_SEC - 1,
      alerts: {
        ...emptyAlerts(),
        dews: [DEWS_WARNING],
      },
      quietHoursEnabled: false,
      quietHoursStartUtc: null,
      quietHoursEndUtc: null,
      timezone: null,
      specificCount: 1,
      globalCount: 0,
    },
  };
}

describe("dispatch telegram fanout planning", () => {
  it("counts preset query and resolution failures without treating failed presets as subscribers", () => {
    const summary = summarizePresetFanoutFailures(fanoutInputs({
      presetDewsResult: { kind: "query-failed", error: new Error("d1 unavailable") },
      presetDepegResult: { kind: "resolution-failed" },
      presetSafetyResult: { kind: "ok", rows: new Map() },
    }));

    expect(summary).toEqual({
      presetQueryFailures: 1,
      presetResolutionFailures: 1,
      presetFailure: true,
    });
  });

  it("routes direct, preset, and global subscribers before applying the format budget", () => {
    const inputs = fanoutInputs({
      directDewsSubs: new Map([
        [
          "usdc-circle",
          [
            subscriber({ chat_id: "direct", last_active_at: 100 }),
            subscriber({ chat_id: "direct-off", last_active_at: 400 }),
          ],
        ],
      ]),
      presetDewsResult: {
        kind: "ok",
        rows: new Map([
          ["usdc-circle", [subscriber({ chat_id: "preset", last_active_at: 200 })]],
        ]),
      },
      globalDewsSubs: [
        subscriber({ chat_id: "global", last_active_at: 300, isGlobal: true }),
        subscriber({ chat_id: "global-off", last_active_at: 350, isGlobal: true }),
      ],
      perCoinExplicitlyOffMaps: {
        ...emptyExplicitlyOffMaps(),
        dews: new Map([["usdc-circle", new Set(["direct-off", "global-off"])]]),
      },
    });

    const plan = buildTelegramFanoutPlan({
      events: fanoutEvents({ dewsChanges: [DEWS_WARNING] }),
      inputs,
      overflowBacklog: [overflowPlan("cached-overflow")],
      burstMarkers: {},
      nowSec: NOW_SEC,
      formatBudget: 2,
    });

    expect(plan.plannedQueue.map((entry) => entry.chatId)).toEqual(["global", "preset", "direct"]);
    expect(plan.subscriberQueue.map((entry) => entry.chatId)).toEqual(["global"]);
    expect(plan.overflowPlanned.map((entry) => entry.chatId)).toEqual(["preset", "direct"]);
    expect(plan.combinedOverflowPlanned.map((entry) => entry.chatId)).toEqual([
      "cached-overflow",
      "preset",
      "direct",
    ]);
    expect(plan.freshCandidateChats).toBe(3);
    expect(plan.freshCandidateCount).toBe(3);
    expect(plan.formattedChats).toBe(1);
    expect(plan.overflowFormatBudget).toBe(1);
    expect(plan.perAlertTypeTargets.dews).toEqual({ chats: 1, chunks: 1 });
    expect(plan.presetFailure).toBe(false);
  });

  it("exposes capture eligibility from routing without building rendered messages", () => {
    const routing = buildTelegramAlertsByChat({
      events: fanoutEvents({ dewsChanges: [DEWS_WARNING] }),
      inputs: fanoutInputs({
        directDewsSubs: new Map([
          ["usdc-circle", [subscriber({ chat_id: "eligible" })]],
        ]),
      }),
      burstMarkers: {},
      nowSec: NOW_SEC,
      collapseBursts: false,
    });

    expect([...routing.alertsByChat.keys()]).toEqual(["eligible"]);
    expect(routing.alertsByChat.get("eligible")?.alerts.dews).toEqual([DEWS_WARNING]);
    expect("subscriberQueue" in routing).toBe(false);
  });
});

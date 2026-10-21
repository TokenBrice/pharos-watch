import { describe, expect, it, vi } from "vitest";
import type { DewsChange } from "../../../../telegram/common/alerts-formatting";
import {
  buildTelegramAlertsByChat,
} from "../dispatch-telegram-fanout-plan";
import type { TelegramFanoutPlanEvents } from "../../sources/dispatch-telegram-events";
import {
  loadFanoutSubscriptionInputs,
  type FanoutSubscriptionInputs,
} from "../dispatch-telegram-alerts-fanout";
import { makeSubscriberRow as subscriber } from "./telegram-subscriber.test-support";

const NOW_SEC = 1_800_000_000;

const DEWS_WARNING: DewsChange = {
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
      events: fanoutEvents({ dewsChanges: [{ ...DEWS_WARNING, stablecoinId: "dews-coin" }] }),
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
      events: fanoutEvents({ dewsChanges: [DEWS_WARNING] }),
      inputs,
    });
    expect(routing).toEqual({ alertsByChat: new Map() });
  });

  it("exposes capture eligibility from routing without building rendered messages", () => {
    const routing = buildTelegramAlertsByChat({
      events: fanoutEvents({ dewsChanges: [DEWS_WARNING] }),
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
    expect(routing.alertsByChat.get("eligible")?.alerts.dews).toEqual([DEWS_WARNING]);
    expect("subscriberQueue" in routing).toBe(false);
  });
});

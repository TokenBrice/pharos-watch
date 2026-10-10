import { describe, expect, it, vi } from "vitest";
import type { DewsChange } from "../../lib/telegram/alerts";
import {
  buildTelegramAlertsByChat,
  renderTelegramSubscriberPage,
  summarizePresetFanoutFailures,
} from "../dispatch-telegram-fanout-plan";
import type { TelegramFanoutPlanEvents } from "../dispatch-telegram-events";
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
    launch: new Map(),
    reserve: new Map(),
  };
}

function fanoutInputs(overrides: Partial<FanoutSubscriptionInputs> = {}): FanoutSubscriptionInputs {
  return {
    direct: { dews: new Map(), depeg: new Map(), safety: new Map(), launch: new Map(), reserve: new Map() },
    preset: {
      dews: { kind: "ok", rows: new Map() },
      depeg: { kind: "ok", rows: new Map() },
      safety: { kind: "ok", rows: new Map() },
    },
    global: { dews: [], depeg: [], safety: [], launch: [], reserve: [] },
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
        launchIds: ["launch-coin"],
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

    for (const family of ["dews", "depeg", "safety", "launch"] as const) {
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

  it("counts preset query and resolution failures without treating failed presets as subscribers", () => {
    const summary = summarizePresetFanoutFailures(fanoutInputs({
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
    }));

    expect(summary).toEqual({
      presetQueryFailures: 1,
      presetResolutionFailures: 1,
      presetFailure: true,
    });
  });

  it("rejects a whole page over budget and preserves direct, preset, global routing and vetoes", () => {
    const inputs = fanoutInputs({
      direct: {
        ...fanoutInputs().direct,
        dews: new Map([
          [
            "usdc-circle",
            [
              subscriber({ chat_id: "direct", last_active_at: 100 }),
              subscriber({ chat_id: "direct-off", last_active_at: 400 }),
            ],
          ],
        ]),
      },
      preset: {
        ...fanoutInputs().preset,
        dews: {
          kind: "ok",
          rows: new Map([
            ["usdc-circle", [subscriber({ chat_id: "preset", last_active_at: 200 })]],
          ]),
        },
      },
      global: {
        ...fanoutInputs().global,
        dews: [
          subscriber({ chat_id: "global", last_active_at: 300, isGlobal: true }),
          subscriber({ chat_id: "global-off", last_active_at: 350, isGlobal: true }),
        ],
      },
      perCoinExplicitlyOffMaps: {
        ...emptyExplicitlyOffMaps(),
        dews: new Map([["usdc-circle", new Set(["direct-off", "global-off"])]]),
      },
    });

    const args = {
      events: fanoutEvents({ dewsChanges: [DEWS_WARNING] }),
      inputs,
      nowSec: NOW_SEC,
      formatBudget: 1,
    };
    expect(() => renderTelegramSubscriberPage(args))
      .toThrow("Telegram subscriber page exceeded the bounded rendering budget");
    const queue = renderTelegramSubscriberPage({ ...args, formatBudget: 3 });

    expect(queue.map((entry) => entry.chatId)).toEqual(["global", "preset", "direct"]);
    expect(queue.every((entry) => entry.chunks.length === 1)).toBe(true);
    expect(queue.every((entry) => entry.canonicalHtml.includes("<b>DEWS</b>"))).toBe(true);
    expect(buildTelegramAlertsByChat(args).presetFailure).toBe(false);
  });

  it("admits the first candidate above budget and preserves quiet-hour, escalation and lineage policy", () => {
    const events = fanoutEvents({
      dewsChanges: Array.from({ length: 17 }, () => DEWS_WARNING),
    });
    const inputs = fanoutInputs({
      direct: {
        ...fanoutInputs().direct,
        dews: new Map([["usdc-circle", [subscriber({
          chat_id: "quiet",
          preference_generation: 7,
          quiet_hours_enabled: 1,
          quiet_hours_start_utc: 0,
          quiet_hours_end_utc: 23,
          timezone: "UTC",
        })]]]),
      },
    });
    const args = { events, inputs, nowSec: Date.UTC(2027, 0, 1, 12) / 1000, formatBudget: 1, sourceEventId: "source:test" };
    const [quiet] = renderTelegramSubscriberPage(args);
    expect(quiet).toMatchObject({
      chatId: "quiet",
      sourceEventId: "source:test",
      preferenceGeneration: 7,
      alertScope: [{ stablecoinId: "usdc-circle", family: "dews" }],
      disableNotification: true,
    });
    expect(quiet.canonicalHtml).toContain("<b>DEWS</b>");
    expect(quiet.chunks.length).toBeGreaterThan(0);
    inputs.direct.dews.set("usdc-circle", [subscriber({ chat_id: "loud" })]);
    expect(renderTelegramSubscriberPage(args)[0].disableNotification).toBe(false);
    const recovery = fanoutEvents({ dewsChanges: [{ ...DEWS_WARNING, oldBand: "DANGER", newBand: "WARNING" }] });
    expect(renderTelegramSubscriberPage({ ...args, events: recovery })[0].disableNotification).toBe(true);
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

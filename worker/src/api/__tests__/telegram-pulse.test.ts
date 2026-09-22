import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { cachedPulse as buildCachedPulse, pulseAggregate, pulseCacheTables } from "./telegram-pulse.test-support";

const fixtures = createLatestSchemaFixtureTracker();
function persistedPulseDb() {
  const fixture = fixtures.open();
  fixture.sqlite.exec(`
    INSERT INTO telegram_watcher_lifecycle_daily (day, snapshot_at, active_watchers, new_watchers, churned_watchers, reactivated_watchers)
    VALUES ('2027-01-13', 1799840000, 0, 0, 0, 0), ('2027-01-14', 1799926400, 0, 0, 0, 0);
  `);
  return fixture;
}
afterEach(() => {
  fixtures.closeAll();
  vi.restoreAllMocks();
});
import {
  mockD1 as baseMockD1,
  type MockD1Database,
  type MockPreparedStatement,
} from "@shared/test-utils/mock-d1";
import {
  handleTelegramPulse,
  publishTelegramPulseSnapshot,
  publishTelegramPulseSnapshotWithOutcome,
} from "../telegram-pulse";

function mockD1(
  tables: Parameters<typeof baseMockD1>[0] = [],
  options: Parameters<typeof baseMockD1>[1] = {},
) {
  return baseMockD1([
    ...tables,
    { match: "SELECT snapshot_at FROM telegram_watcher_lifecycle_daily WHERE day = ?", rows: [], first: null },
    { match: "FROM telegram_watcher_lifecycle_events_daily", rows: [], first: null },
    { match: "FROM telegram_adoption_daily", rows: [] },
    { match: "FROM telegram_usage_daily", rows: [], first: null },
    { match: "FROM telegram_adoption_retention_daily", rows: [] },
    { match: "INSERT INTO telegram_adoption_retention_daily", rows: [] },
    { match: "INSERT OR REPLACE INTO cache", rows: [] },
    { match: "INSERT INTO cache", rows: [], runMeta: { changes: 1 } },
  ], options);
}

describe("handleTelegramPulse", () => {
  it("serves a fresh materialized pulse snapshot without live aggregate reads", async () => {
    const cachedPulse = {
      activeWatchers: 8,
      coinSubscriptions: 13,
      explicitCoinSubscriptions: 10,
      presetImpliedCoinSubscriptions: 3,
      activePresetFollowers: 2,
      newWatchersToday: 1,
      churnedWatchersToday: 0,
      reactivatedWatchersToday: 0,
      historySource: "snapshot",
      topCoins: ["USDC"],
      pendingDeliveries: 3,
      miniAppSessionsToday: 4,
      miniAppMutationsToday: 2,
      updatedAt: Math.floor(Date.now() / 1000),
      updatedEverySeconds: 300,
      watcherHistory: [
        {
          date: "2026-04-01",
          timestamp: 1_775_001_600_000,
          newWatchers: 1,
          activeWatchers: 8,
          churnedWatchers: 2,
          reactivatedWatchers: 0,
        },
      ],
    };
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          {
            key: "telegram:pulse:snapshot",
            value: JSON.stringify(cachedPulse),
            updated_at: Math.floor(Date.now() / 1000),
          },
        ],
      },
    ]);

    const response = await handleTelegramPulse(db);
    expect(await readJsonResponse(response, 200)).toEqual({
      ...cachedPulse,
      newWatchersToday: null,
      pendingDeliveries: null,
      miniAppSessionsToday: null,
      miniAppMutationsToday: null,
      watcherHistory: [
        {
          ...cachedPulse.watcherHistory[0],
          newWatchers: null,
          churnedWatchers: null,
        },
      ],
      currentSnapshotAt: cachedPulse.updatedAt,
      lifecycleHistoryUpdatedAt: null,
      lifecycleHistoryEverySeconds: 900,
      quality: { status: "complete", unavailableFields: [] },
      privacy: {
        exactActiveWatchers: true,
        lowCardinalityThreshold: 5,
        suppressedFields: [
          "miniAppMutationsToday",
          "miniAppSessionsToday",
          "newWatchersToday",
          "pendingDeliveries",
          "watcherHistory.churnedWatchers",
          "watcherHistory.newWatchers",
        ],
      },
    });
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM telegram_subscribers s"))).toBe(false);
  });

  it("rejects malformed cached pulse payloads and rebuilds a safe response", async () => {
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          {
            key: "telegram:pulse:snapshot",
            value: JSON.stringify({
              activeWatchers: 1,
              coinSubscriptions: 1,
              updatedAt: Math.floor(Date.now() / 1000),
              updatedEverySeconds: 300,
              watcherHistory: [],
            }),
            updated_at: Math.floor(Date.now() / 1000),
          },
        ],
      },
      {
        match: "FROM telegram_subscribers s",
        first: pulseAggregate({ active_watchers: 9, new_watchers: 0, explicit_coin_follows: 12, active_preset_followers: 0, active_dews_opt_ins: 9, active_depeg_opt_ins: 9, active_safety_opt_ins: 0, active_launch_opt_ins: 0, active_all_types_opt_ins: 0, quiet_hours_enabled_chats: 0 }),
        rows: [],
      },
      {
        match: "ORDER BY day DESC",
        first: null,
        rows: [],
      },
      {
        match: "FROM telegram_preset_subscriptions",
        rows: [],
      },
      {
        match: "ORDER BY day ASC",
        rows: [],
      },
      {
        match: "GROUP BY day",
        rows: [],
      },
      {
        match: "FROM telegram_subscriptions",
        rows: [{ stablecoin_id: "usdc-circle", subscribers: 12 }],
      },
      {
        match: "FROM telegram_pending_alerts",
        first: { pending_count: 0 },
        rows: [],
      },
    ]);

    const response = await handleTelegramPulse(db);
    const body = (await readJsonResponse(response, 200)) as { activeWatchers: number; topCoins: string[]; quality: { status: string } };

    expect(body.activeWatchers).toBe(9);
    expect(body.topCoins).toEqual(["USDC"]);
    expect(body.quality.status).toBe("complete");
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM telegram_subscribers s"))).toBe(true);
  });

  it("serves a fresh one-point snapshot cache without live aggregate reads", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const cachedPulse = {
      activeWatchers: 519,
      coinSubscriptions: 3080,
      explicitCoinSubscriptions: 3080,
      presetImpliedCoinSubscriptions: 0,
      activePresetFollowers: 43,
      newWatchersToday: 305,
      churnedWatchersToday: 0,
      reactivatedWatchersToday: 0,
      historySource: "snapshot",
      topCoins: ["USDC"],
      watcherHistory: [
        {
          date: "2026-05-13",
          timestamp: 1_778_630_400_000,
          snapshotAt: 1_778_680_000,
          newWatchers: 305,
          activeWatchers: 519,
          churnedWatchers: 0,
          reactivatedWatchers: 0,
        },
      ],
      pendingDeliveries: 0,
      currentSnapshotAt: 1_778_681_248,
      lifecycleHistoryUpdatedAt: 1_778_680_000,
      lifecycleHistoryEverySeconds: 900,
      quality: { status: "complete", unavailableFields: [] },
      privacy: { exactActiveWatchers: true, lowCardinalityThreshold: 5, suppressedFields: [] },
      updatedAt: nowSec,
      updatedEverySeconds: 300,
    };
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          {
            key: "telegram:pulse:snapshot",
            value: JSON.stringify(cachedPulse),
            updated_at: nowSec,
          },
        ],
      },
    ]);

    const response = await handleTelegramPulse(db);
    const body = (await readJsonResponse(response, 200)) as {
      historySource: string;
      watcherHistory: Array<{ date: string; activeWatchers: number }>;
    };

    expect(body.historySource).toBe("snapshot");
    expect(body.watcherHistory.map((point) => point.date)).toEqual(["2026-05-13"]);
    expect(body.watcherHistory[0]?.activeWatchers).toBe(519);
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM telegram_subscribers s"))).toBe(false);
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM telegram_watcher_lifecycle_daily"))).toBe(false);
  });

  it("counts launch-only, overlapping preset, global-only and inert watchers using real SQL", async () => {
    const { db, sqlite } = fixtures.open();
    const now = Math.floor(Date.now() / 1000);
    const addSubscriber = sqlite.prepare("INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at, global_alert_launch) VALUES (?, ?, ?, ?)");
    for (const id of ["launch", "overlap", "global", "inert"]) {
      addSubscriber.run(id, now - 86400, now, id === "global" ? 1 : 0);
    }
    sqlite.exec(`
      INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_launch)
      VALUES ('launch', 'usdpt-western-union', 0, 0, 0, 1),
             ('overlap', 'usdc-circle', 1, 0, 0, 0),
             ('inert', 'usdt-tether', 0, 0, 0, 0);
      INSERT INTO telegram_preset_subscriptions (chat_id, preset_id, alert_dews, alert_depeg, alert_safety, created_at, updated_at)
      VALUES ('overlap', 'mcap-ge-1b', 1, 0, 0, 1, 1);
    `);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('stablecoins', ?, ?)").run(JSON.stringify({
      peggedAssets: [{ id: "usdc-circle", symbol: "USDC", name: "USD Coin", circulating: { peggedUSD: 1_000_000_000 } }],
    }), now);
    const body = await readJsonResponse(await handleTelegramPulse(db), 200);
    expect(body).toMatchObject({
      activeWatchers: 3,
      explicitCoinSubscriptions: 2,
      presetImpliedCoinSubscriptions: 1,
      coinSubscriptions: 3,
      activePresetFollowers: 1,
      topCoins: ["USDC", "USDPT"],
      quality: { status: "complete", unavailableFields: [] },
    });
  });

  it("publishes only pending delivery rows in pendingDeliveries", async () => {
    const { db, sqlite } = fixtures.open();
    const now = Math.floor(Date.now() / 1000);
    const insert = sqlite.prepare(
      "INSERT INTO telegram_pending_alerts (chat_id, message_html, created_at, delivery_state) VALUES (?, 'test', ?, ?)",
    );
    for (let index = 0; index < 5; index += 1) {
      insert.run(`pending-${index}`, now, "pending");
    }
    for (const state of ["sending", "sent", "execution_unknown"] as const) {
      for (let index = 0; index < 4; index += 1) {
        insert.run(`${state}-${index}`, now, state);
      }
    }

    const body = await readJsonResponse<{ pendingDeliveries: number | null }>(await handleTelegramPulse(db), 200);

    expect(body.pendingDeliveries).toBe(5);
  });

  it("suppresses low-cardinality Mini App usage counts but exposes abuse-health counts", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_watcher_lifecycle_daily",
        rows: [],
      },
      {
        match: "FROM telegram_subscribers s",
        first: pulseAggregate(),
        rows: [],
      },
      {
        match: "FROM telegram_preset_subscriptions",
        rows: [],
      },
      {
        match: "FROM telegram_subscriptions",
        rows: [],
      },
      {
        match: "FROM telegram_pending_alerts",
        first: { pending_count: 0 },
        rows: [],
      },
      {
        match: "FROM telegram_usage_daily",
        first: {
          mini_app_sessions: 3,
          mini_app_mutations: 4,
          mini_app_denied: 2,
          mini_app_replay_claimed: 1,
        },
        rows: [],
      },
    ]);

    const response = await handleTelegramPulse(db);
    const body = (await response.json()) as {
      miniAppSessionsToday: number | null;
      miniAppMutationsToday: number | null;
      miniAppDeniedToday: number | null;
      miniAppReplayClaimsToday: number | null;
      privacy: { suppressedFields: string[] };
    };

    expect(body.miniAppSessionsToday).toBeNull();
    expect(body.miniAppMutationsToday).toBeNull();
    expect(body.miniAppDeniedToday).toBe(2);
    expect(body.miniAppReplayClaimsToday).toBe(1);
    expect(body.privacy.suppressedFields).toEqual([
      "miniAppMutationsToday",
      "miniAppSessionsToday",
    ]);
  });

  it("reports unavailable pending deliveries through quality instead of privacy suppression", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_watcher_lifecycle_daily",
        rows: [],
      },
      {
        match: "FROM telegram_subscribers s",
        first: pulseAggregate(),
        rows: [],
      },
      {
        match: "FROM telegram_preset_subscriptions",
        rows: [],
      },
      {
        match: "FROM telegram_subscriptions",
        rows: [],
      },
      {
        match: "FROM telegram_pending_alerts",
        throwError: new Error("pending table unavailable"),
        rows: [],
      },
      {
        match: "FROM telegram_usage_daily",
        first: {
          mini_app_sessions: 0,
          mini_app_mutations: 0,
          mini_app_denied: 0,
          mini_app_replay_claimed: 0,
        },
        rows: [],
      },
    ]);

    const response = await handleTelegramPulse(db);
    const body = (await response.json()) as {
      pendingDeliveries: number | null;
      quality: { status: string; unavailableFields: string[] };
      privacy: { suppressedFields: string[] };
    };

    expect(body.pendingDeliveries).toBeNull();
    expect(body.quality).toEqual({
      status: "partial",
      unavailableFields: ["pendingDeliveries"],
    });
    expect(body.privacy.suppressedFields).not.toContain("pendingDeliveries");
  });

  it("publishes only completed snapshot days as lifecycle history", async () => {
    const nowSec = Math.floor(Date.parse("2026-05-13T12:00:00.000Z") / 1000);
    const db = mockD1([
      {
        match: "FROM telegram_watcher_lifecycle_daily",
        rows: [
          {
            day: "2026-05-12",
            snapshot_at: nowSec - 86_400,
            active_watchers: 500,
            new_watchers: 20,
            churned_watchers: 7,
            reactivated_watchers: 3,
          },
          {
            day: "2026-05-13",
            snapshot_at: nowSec,
            active_watchers: 519,
            new_watchers: 19,
            churned_watchers: 0,
            reactivated_watchers: 0,
          },
        ],
      },
      {
        match: "FROM telegram_subscribers s",
        first: pulseAggregate({ active_watchers: 519 }),
        rows: [],
      },
      { match: "FROM telegram_preset_subscriptions", rows: [] },
      { match: "FROM telegram_subscriptions", rows: [] },
      { match: "FROM telegram_pending_alerts", first: { pending_count: 0 }, rows: [] },
    ]);

    const pulse = await publishTelegramPulseSnapshot(db, nowSec);

    expect(pulse.historySource).toBe("snapshot");
    expect(pulse.watcherHistory.map((point) => point.date)).toEqual(["2026-05-12"]);
    expect(db.getHistory().some((entry) => entry.sql.includes("GROUP BY day"))).toBe(false);
  });


});

describe("publishTelegramPulseSnapshot", () => {
  it("reuses heavy public sections on the slower pulse cadence", async () => {
    const nowSec = Math.floor(Date.parse("2026-05-12T12:00:00.000Z") / 1000);
    const cachedPulse = buildCachedPulse(nowSec - 600, {
      lifecycleHistoryUpdatedAt: nowSec - 3_600,
      watcherHistory: [
        {
          date: "2026-05-10",
          timestamp: 1_778_371_200_000,
          snapshotAt: nowSec - 4_500,
          newWatchers: 3,
          activeWatchers: 6,
          churnedWatchers: 0,
          reactivatedWatchers: 0,
        },
        {
          date: "2026-05-11",
          timestamp: 1_778_457_600_000,
          snapshotAt: nowSec - 3_600,
          newWatchers: 5,
          activeWatchers: 8,
          churnedWatchers: 0,
          reactivatedWatchers: 0,
        },
      ],
    });
    const db = mockD1([
      ...pulseCacheTables(cachedPulse, nowSec - 600),
      {
        match: "FROM telegram_subscribers s",
        first: pulseAggregate({ new_watchers: 6, explicit_coin_follows: 18, active_preset_followers: 2, active_dews_opt_ins: 10, active_depeg_opt_ins: 9, active_safety_opt_ins: 8, active_launch_opt_ins: 7, quiet_hours_enabled_chats: 6 }),
        rows: [],
      },
      {
        match: "ORDER BY day DESC",
        first: null,
        rows: [],
      },
      {
        match: "FROM telegram_preset_subscriptions",
        rows: [],
      },
    ]);

    const pulse = await publishTelegramPulseSnapshot(db, nowSec, {
      pendingCapacitySnapshot: { active: 42 },
    });

    expect(pulse.activeWatchers).toBe(12);
    expect(pulse.coinSubscriptions).toBe(18);
    expect(pulse.pendingDeliveries).toBe(42);
    expect(pulse.topCoins).toEqual(["USDC"]);
    expect(pulse.watcherHistory).toEqual([
      { ...cachedPulse.watcherHistory[0], newWatchers: null },
      cachedPulse.watcherHistory[1],
    ]);
    expect(pulse.miniAppSessionsToday).toBe(7);
    expect(pulse.lifecycleHistoryUpdatedAt).toBe(nowSec - 3_600);
    expect(pulse.privacy.suppressedFields).toContain("watcherHistory.newWatchers");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("FROM telegram_pending_alerts"))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("GROUP BY stablecoin_id"))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("ORDER BY day ASC"))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("GROUP BY day"))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("FROM telegram_usage_daily"))).toBe(false);
  });

  it("reloads daily Mini App counters across UTC midnight", async () => {
    const nowSec = Math.floor(Date.parse("2026-05-12T00:05:00.000Z") / 1000);
    const previousDaySec = Math.floor(Date.parse("2026-05-11T23:55:00.000Z") / 1000);
    const cachedPulse = buildCachedPulse(previousDaySec, {
      miniAppSessionsToday: 99,
      miniAppMutationsToday: 98,
      miniAppDeniedToday: 97,
      miniAppReplayClaimsToday: 96,
      watcherHistory: [
        {
          date: "2026-05-10",
          timestamp: 1_778_371_200_000,
          snapshotAt: previousDaySec - 900,
          newWatchers: 3,
          activeWatchers: 6,
          churnedWatchers: 0,
          reactivatedWatchers: 0,
        },
        {
          date: "2026-05-11",
          timestamp: 1_778_457_600_000,
          snapshotAt: previousDaySec,
          newWatchers: 5,
          activeWatchers: 8,
          churnedWatchers: 0,
          reactivatedWatchers: 0,
        },
      ],
    });
    const db = mockD1([
      ...pulseCacheTables(cachedPulse, previousDaySec),
      {
        match: "FROM telegram_subscribers s",
        first: pulseAggregate({ new_watchers: 6, explicit_coin_follows: 18, active_preset_followers: 2, active_dews_opt_ins: 10, active_depeg_opt_ins: 9, active_safety_opt_ins: 8, active_launch_opt_ins: 7, quiet_hours_enabled_chats: 6 }),
        rows: [],
      },
      { match: "ORDER BY day DESC", first: null, rows: [] },
      { match: "FROM telegram_preset_subscriptions", rows: [] },
      { match: "FROM telegram_subscriptions", rows: [{ stablecoin_id: "usdc-circle", subscribers: 12 }] },
      { match: "ORDER BY day ASC", rows: [] },
      { match: "GROUP BY day", rows: [] },
      {
        match: "FROM telegram_usage_daily",
        first: {
          mini_app_sessions: 7,
          mini_app_mutations: 6,
          mini_app_denied: 2,
          mini_app_replay_claimed: 1,
        },
        rows: [],
      },
    ]);

    const pulse = await publishTelegramPulseSnapshot(db, nowSec, {
      pendingCapacitySnapshot: { active: 42 },
    });

    expect(pulse.miniAppSessionsToday).toBe(7);
    expect(pulse.miniAppMutationsToday).toBe(6);
    expect(pulse.miniAppDeniedToday).toBe(2);
    expect(pulse.miniAppReplayClaimsToday).toBe(1);
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM telegram_usage_daily"))).toBe(true);
  });

  it.each([300, 301])("serves cache through age 300, rebuilding at age %i", async (age) => {
    const now = 1_800_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue((now - age) * 1000);
    const { db, sqlite } = persistedPulseDb();
    await publishTelegramPulseSnapshot(db, now - age);
    clock.mockReturnValue(now * 1000);
    sqlite.prepare("INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at, global_alert_launch) VALUES ('new', ?, ?, 1)").run(now, now);
    const body = await readJsonResponse(await handleTelegramPulse(db), 200);
    expect(body).toMatchObject({ activeWatchers: age === 300 ? 0 : 1 });
  });

  it.each([899, 900])("reuses heavy sections strictly below 900 seconds (age %i)", async (age) => {
    const now = 1_800_000_000;
    const { db, sqlite } = persistedPulseDb();
    await publishTelegramPulseSnapshot(db, now - age);
    const outcome = await publishTelegramPulseSnapshotWithOutcome(db, now);
    expect(outcome.heavySectionsRecomputed).toBe(age === 900);
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = 'telegram:pulse:heavy-sections-updated-at'").get())
      .toEqual({ value: String(age === 900 ? now : now - age) });
  });

  it("preserves unavailable heavy metrics on reuse and clears quality after recovery", async () => {
    const now = 1_800_000_000;
    const { db, sqlite } = persistedPulseDb();
    let injected = false;
    const failingDb = createSqliteD1(sqlite, { onAll(sql) {
      if (sql.includes("GROUP BY stablecoin_id")) {
        injected = true;
        throw new Error("top coins unavailable");
      }
    } });
    const failed = await publishTelegramPulseSnapshotWithOutcome(failingDb, now);
    expect(injected).toBe(true);
    expect(failed.status).toBe("degraded");
    expect(failed.pulse.quality).toEqual({ status: "partial", unavailableFields: ["topCoins"] });
    expect(failed.pulse.privacy.suppressedFields).not.toContain("topCoins");
    const reused = await publishTelegramPulseSnapshotWithOutcome(db, now + 899);
    expect(reused.heavySectionsRecomputed).toBe(false);
    expect(reused.pulse.quality).toEqual({ status: "partial", unavailableFields: ["topCoins"] });
    const recovered = await publishTelegramPulseSnapshotWithOutcome(db, now + 900);
    expect(recovered.heavySectionsRecomputed).toBe(true);
    expect(recovered.status).toBe("ok");
    expect(recovered.pulse.quality).toEqual({ status: "complete", unavailableFields: [] });
  });
});

describe("publishTelegramPulseSnapshotWithOutcome", () => {
  const PULSE_SNAPSHOT_KEY = "telegram:pulse:snapshot";
  const HEAVY_MARKER_KEY = "telegram:pulse:heavy-sections-updated-at";

  /** Fail only cache writes for one key so publication ordering stays observable. */
  function failCacheWritesForKey(inner: MockD1Database, failKey: string): MockD1Database {
    return {
      ...inner,
      prepare: (sql: string) => {
        const statement = inner.prepare(sql) as MockPreparedStatement;
        if (!sql.includes("INTO cache")) return statement;
        return {
          ...statement,
          bind: (...binds: unknown[]) => {
            const bound = statement.bind(...binds) as MockPreparedStatement;
            if (binds[0] !== failKey) return bound;
            return {
              ...bound,
              run: async () => {
                throw new Error(`simulated D1 cache write failure for ${failKey}`);
              },
            } as unknown as MockPreparedStatement;
          },
        } as unknown as MockPreparedStatement;
      },
    } as unknown as MockD1Database;
  }

  function buildRebuildSourceDb(): MockD1Database {
    return mockD1([
      {
        match: "FROM telegram_watcher_lifecycle_daily",
        rows: [],
      },
      {
        match: "FROM telegram_subscribers s",
        first: pulseAggregate(),
        rows: [],
      },
      {
        match: "FROM telegram_preset_subscriptions",
        rows: [],
      },
      {
        match: "FROM telegram_subscriptions",
        rows: [],
      },
      {
        match: "FROM telegram_pending_alerts",
        first: { pending_count: 0 },
        rows: [],
      },
      {
        match: "FROM telegram_usage_daily",
        first: {
          mini_app_sessions: 0,
          mini_app_mutations: 0,
          mini_app_denied: 0,
          mini_app_replay_claimed: 0,
        },
        rows: [],
      },
    ]);
  }

  it("reports a failed snapshot write and does not advance the heavy-section marker", async () => {
    const inner = buildRebuildSourceDb();
    const db = failCacheWritesForKey(inner, PULSE_SNAPSHOT_KEY);

    const outcome = await publishTelegramPulseSnapshotWithOutcome(db);

    expect(outcome.status).toBe("error");
    expect(outcome.snapshotPublished).toBe(false);
    expect(outcome.heavySectionsRecomputed).toBe(true);
    expect(outcome.heavyMarkerAdvanced).toBe(false);
    expect(outcome.error).toContain("simulated D1 cache write failure");
    expect(outcome.pulse.activeWatchers).toBe(12);

    const markerWrites = inner.getHistory().filter(
      (entry) => entry.sql.includes("INSERT OR REPLACE INTO cache") && entry.binds[0] === HEAVY_MARKER_KEY,
    );
    expect(markerWrites).toEqual([]);
  });

  it("publishes the snapshot but degrades when the heavy-marker write fails", async () => {
    const inner = buildRebuildSourceDb();
    const db = failCacheWritesForKey(inner, HEAVY_MARKER_KEY);

    const outcome = await publishTelegramPulseSnapshotWithOutcome(db);

    expect(outcome.status).toBe("degraded");
    expect(outcome.snapshotPublished).toBe(true);
    expect(outcome.heavySectionsRecomputed).toBe(true);
    expect(outcome.heavyMarkerAdvanced).toBe(false);
    expect(outcome.error).toContain("simulated D1 cache write failure");

    const snapshotWrites = inner.getHistory().filter(
      (entry) => entry.sql.includes("INSERT INTO cache") && entry.binds[0] === PULSE_SNAPSHOT_KEY,
    );
    expect(snapshotWrites).toHaveLength(1);
  });

  it("does not let an older pulse generation replace a newer publication", async () => {
    const newerAt = Math.floor(Date.parse("2027-01-15T12:00:00.000Z") / 1000);
    const { db, sqlite } = persistedPulseDb();

    const newer = await publishTelegramPulseSnapshotWithOutcome(db, newerAt);
    const older = await publishTelegramPulseSnapshotWithOutcome(db, newerAt - 60);
    const stored = sqlite.prepare(
      "SELECT value, updated_at FROM cache WHERE key = 'telegram:pulse:snapshot'",
    ).get() as { value: string; updated_at: number };

    expect(newer.snapshotPublished).toBe(true);
    expect(older.status).toBe("ok");
    expect(older.snapshotPublished).toBe(false);
    expect(older.staleWriteSkipped).toBe(true);
    expect(older.pulse.updatedAt).toBe(newerAt);
    expect(stored.updated_at).toBe(newerAt);
    expect(JSON.parse(stored.value)).toMatchObject({ updatedAt: newerAt });
  });
});

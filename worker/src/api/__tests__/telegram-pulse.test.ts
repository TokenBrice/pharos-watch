import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { describe, expect, it } from "vitest";
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
    { match: "FROM telegram_adoption_daily", rows: [] },
    { match: "FROM telegram_usage_daily", rows: [], first: null },
    { match: "FROM telegram_adoption_retention_daily", rows: [] },
    { match: "INSERT INTO telegram_adoption_retention_daily", rows: [] },
    { match: "INSERT OR REPLACE INTO cache", rows: [] },
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
      historySource: "live-fallback",
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
        first: {
          active_watchers: 9,
          new_watchers: 0,
          explicit_coin_follows: 12,
          active_preset_followers: 0,
          active_dews_opt_ins: 9,
          active_depeg_opt_ins: 9,
          active_safety_opt_ins: 0,
          active_launch_opt_ins: 0,
          active_all_types_opt_ins: 0,
          quiet_hours_enabled_chats: 0,
        },
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

  it("returns launch-aware public pulse metrics from active subscription rows", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_watcher_lifecycle_daily",
        rows: [
          {
            day: "2026-04-01",
            snapshot_at: 1_775_002_000,
            active_watchers: 2,
            new_watchers: 2,
            churned_watchers: 0,
            reactivated_watchers: 0,
          },
          {
            day: "2026-04-03",
            snapshot_at: 1_775_174_800,
            active_watchers: 5,
            new_watchers: 3,
            churned_watchers: 1,
            reactivated_watchers: 1,
          },
        ],
      },
      {
        match: "FROM telegram_subscribers s",
        first: {
          active_watchers: 5,
          new_watchers: 2,
          explicit_coin_follows: 7,
          active_preset_followers: 2,
          active_dews_opt_ins: 4,
          active_depeg_opt_ins: 3,
          active_safety_opt_ins: 2,
          active_launch_opt_ins: 1,
          active_all_types_opt_ins: 1,
          quiet_hours_enabled_chats: 2,
        },
        rows: [],
      },
      {
        match: "ORDER BY day DESC",
        first: {
          day: "2026-05-12",
          snapshot_at: 1_778_608_800,
          active_watchers: 2,
          new_watchers: 0,
          churned_watchers: 0,
          reactivated_watchers: 0,
        },
        rows: [],
      },
      {
        match: "FROM telegram_preset_subscriptions",
        rows: [],
      },
      {
        match: "FROM telegram_subscriptions",
        rows: [
          { stablecoin_id: "usdpt-western-union", subscribers: 5 },
          { stablecoin_id: "usdc-circle", subscribers: 2 },
        ],
      },
      {
        match: "FROM telegram_pending_alerts",
        first: { pending_count: 3 },
        rows: [],
      },
    ]);

    const response = await handleTelegramPulse(db);
    const body = (await response.json()) as {
      activeWatchers: number;
      coinSubscriptions: number;
      explicitCoinSubscriptions: number;
      presetImpliedCoinSubscriptions: number;
      activePresetFollowers: number;
      newWatchersToday: number;
      churnedWatchersToday: number;
      reactivatedWatchersToday: number;
      historySource: string;
      topCoins: string[];
      pendingDeliveries: number | null;
      currentSnapshotAt: number;
      lifecycleHistoryUpdatedAt: number | null;
      lifecycleHistoryEverySeconds: number;
      quality: { status: string; unavailableFields: string[] };
      privacy: { exactActiveWatchers: boolean; lowCardinalityThreshold: number; suppressedFields: string[] };
      updatedAt: number;
      updatedEverySeconds: number;
      watcherHistory: Array<{
        date: string;
        timestamp: number;
        snapshotAt?: number | null;
        newWatchers?: number | null;
        activeWatchers: number;
        churnedWatchers?: number | null;
        reactivatedWatchers?: number | null;
      }>;
    };

    const history = db.getHistory();
    const aggregateQuery = history.find((entry) => entry.sql.includes("FROM telegram_subscribers s"));
    const topCoinsQuery = history.find(
      (entry) =>
        entry.sql.includes("FROM telegram_subscriptions") &&
        entry.sql.includes("GROUP BY stablecoin_id"),
    );
    const watcherHistoryQuery = history.find((entry) => entry.sql.includes("ORDER BY day ASC"));

    expect(aggregateQuery?.sql).toContain("global_alert_launch");
    expect(aggregateQuery?.sql).toContain("alert_launch = 1");
    expect(aggregateQuery?.sql).toContain("SUM(COALESCE(sub.active_sub_count, 0)) AS explicit_coin_follows");
    expect(aggregateQuery?.sql).toContain("quiet_hours_enabled_chats");
    expect(aggregateQuery?.sql).toContain("active_all_types_opt_ins");
    expect(topCoinsQuery?.sql).toContain("alert_launch = 1");
    expect(watcherHistoryQuery?.sql).toContain("telegram_watcher_lifecycle_daily");
    expect(body).toEqual({
      activeWatchers: 5,
      coinSubscriptions: 7,
      explicitCoinSubscriptions: 7,
      presetImpliedCoinSubscriptions: 0,
      activePresetFollowers: 2,
      newWatchersToday: null,
      churnedWatchersToday: 0,
      reactivatedWatchersToday: null,
      historySource: "snapshot",
      topCoins: ["USDPT", "USDC"],
      pendingDeliveries: null,
      miniAppSessionsToday: 0,
      miniAppMutationsToday: 0,
      miniAppDeniedToday: 0,
      miniAppReplayClaimsToday: 0,
      miniAppOpenToFirstMutationP50Sec: null,
      currentSnapshotAt: expect.any(Number),
      lifecycleHistoryUpdatedAt: 1775174800,
      lifecycleHistoryEverySeconds: 900,
      quality: { status: "complete", unavailableFields: [] },
      privacy: {
        exactActiveWatchers: true,
        lowCardinalityThreshold: 5,
        suppressedFields: [
          "newWatchersToday",
          "pendingDeliveries",
          "reactivatedWatchersToday",
          "watcherHistory.churnedWatchers",
          "watcherHistory.newWatchers",
          "watcherHistory.reactivatedWatchers",
        ],
      },
      updatedAt: expect.any(Number),
      updatedEverySeconds: 300,
      watcherHistory: [
        {
          date: "2026-04-01",
          timestamp: 1775001600000,
          snapshotAt: 1775002000,
          newWatchers: null,
          activeWatchers: 2,
          churnedWatchers: 0,
          reactivatedWatchers: 0,
        },
        {
          date: "2026-04-03",
          timestamp: 1775174400000,
          snapshotAt: 1775174800,
          newWatchers: null,
          activeWatchers: 5,
          churnedWatchers: null,
          reactivatedWatchers: null,
        },
      ],
    });
  });

  it("suppresses low-cardinality Mini App usage counts but exposes abuse-health counts", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_watcher_lifecycle_daily",
        rows: [],
      },
      {
        match: "FROM telegram_subscribers s",
        first: {
          active_watchers: 12,
          new_watchers: 0,
          explicit_coin_follows: 12,
          active_preset_followers: 0,
          active_dews_opt_ins: 12,
          active_depeg_opt_ins: 8,
          active_safety_opt_ins: 7,
          active_launch_opt_ins: 6,
          active_all_types_opt_ins: 6,
          quiet_hours_enabled_chats: 0,
        },
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
        first: {
          active_watchers: 12,
          new_watchers: 0,
          explicit_coin_follows: 12,
          active_preset_followers: 0,
          active_dews_opt_ins: 12,
          active_depeg_opt_ins: 8,
          active_safety_opt_ins: 7,
          active_launch_opt_ins: 6,
          active_all_types_opt_ins: 6,
          quiet_hours_enabled_chats: 0,
        },
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

  it("prefixes snapshot history with active-chat lifecycle fallback during bootstrap", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_watcher_lifecycle_daily",
        rows: [
          {
            day: "2026-05-13",
            snapshot_at: 1_778_680_000,
            active_watchers: 519,
            new_watchers: 305,
            churned_watchers: 0,
            reactivated_watchers: 0,
          },
        ],
      },
      {
        match: "GROUP BY day",
        rows: [
          { day: "2026-05-11", day_ts: 1_778_457_600, new_watchers: 214 },
          { day: "2026-05-13", day_ts: 1_778_630_400, new_watchers: 305 },
        ],
      },
      {
        match: "FROM telegram_subscribers s",
        first: {
          active_watchers: 519,
          new_watchers: 305,
          explicit_coin_follows: 3080,
          active_preset_followers: 43,
          active_dews_opt_ins: 216,
          active_depeg_opt_ins: 479,
          active_safety_opt_ins: 86,
          active_launch_opt_ins: 9,
          active_all_types_opt_ins: 5,
          quiet_hours_enabled_chats: 6,
        },
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
        match: "FROM telegram_subscriptions",
        rows: [{ stablecoin_id: "usdc-circle", subscribers: 479 }],
      },
      {
        match: "FROM telegram_pending_alerts",
        first: { pending_count: 0 },
        rows: [],
      },
    ]);

    const response = await handleTelegramPulse(db);
    const body = (await response.json()) as {
      historySource: string;
      lifecycleHistoryUpdatedAt: number | null;
      watcherHistory: Array<{ date: string; activeWatchers: number; snapshotAt?: number | null }>;
    };

    expect(body.historySource).toBe("live-fallback");
    expect(body.lifecycleHistoryUpdatedAt).toBe(1_778_680_000);
    expect(body.watcherHistory).toEqual([
      {
        date: "2026-05-11",
        timestamp: 1_778_457_600_000,
        newWatchers: 214,
        activeWatchers: 214,
      },
      {
        date: "2026-05-13",
        timestamp: 1_778_630_400_000,
        snapshotAt: 1_778_680_000,
        newWatchers: 305,
        activeWatchers: 519,
        churnedWatchers: 0,
        reactivatedWatchers: 0,
      },
    ]);
  });

  it("prefixes pre-snapshot fallback cohorts even after multiple snapshot days exist", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_watcher_lifecycle_daily",
        rows: [
          {
            day: "2026-05-13",
            snapshot_at: 1_778_680_000,
            active_watchers: 519,
            new_watchers: 305,
            churned_watchers: 0,
            reactivated_watchers: 0,
          },
          {
            day: "2026-05-14",
            snapshot_at: 1_778_766_000,
            active_watchers: 540,
            new_watchers: 0,
            churned_watchers: 0,
            reactivated_watchers: 0,
          },
        ],
      },
      {
        match: "GROUP BY day",
        rows: [
          { day: "2026-03-08", day_ts: 1_741_392_000, new_watchers: 10 },
          { day: "2026-05-11", day_ts: 1_778_457_600, new_watchers: 509 },
          { day: "2026-05-13", day_ts: 1_778_630_400, new_watchers: 21 },
        ],
      },
      {
        match: "FROM telegram_subscribers s",
        first: {
          active_watchers: 540,
          new_watchers: 0,
          explicit_coin_follows: 3233,
          active_preset_followers: 48,
          active_dews_opt_ins: 222,
          active_depeg_opt_ins: 500,
          active_safety_opt_ins: 87,
          active_launch_opt_ins: 9,
          active_all_types_opt_ins: 5,
          quiet_hours_enabled_chats: 6,
        },
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
        match: "FROM telegram_subscriptions",
        rows: [{ stablecoin_id: "usdc-circle", subscribers: 3233 }],
      },
      {
        match: "FROM telegram_pending_alerts",
        first: { pending_count: 0 },
        rows: [],
      },
    ]);

    const response = await handleTelegramPulse(db);
    const body = (await response.json()) as {
      historySource: string;
      lifecycleHistoryUpdatedAt: number | null;
      watcherHistory: Array<{ date: string; activeWatchers: number; snapshotAt?: number | null }>;
    };

    // The full available lifecycle stays visible: cohort points that predate
    // the first daily snapshot lead the series, snapshots follow.
    expect(body.historySource).toBe("live-fallback");
    expect(body.lifecycleHistoryUpdatedAt).toBe(1_778_766_000);
    expect(body.watcherHistory.map((point) => point.date)).toEqual([
      "2026-03-08",
      "2026-05-11",
      "2026-05-13",
      "2026-05-14",
    ]);
    expect(body.watcherHistory[0]?.activeWatchers).toBe(10);
    const lastPoint = body.watcherHistory[body.watcherHistory.length - 1];
    expect(lastPoint?.activeWatchers).toBe(540);
    expect(lastPoint?.snapshotAt).toBe(1_778_766_000);
  });

  it("serves a one-point lifecycle snapshot only when live fallback history is empty", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_watcher_lifecycle_daily",
        rows: [
          {
            day: "2026-05-13",
            snapshot_at: 1_778_680_000,
            active_watchers: 519,
            new_watchers: 305,
            churned_watchers: 0,
            reactivated_watchers: 0,
          },
        ],
      },
      {
        match: "GROUP BY day",
        rows: [],
      },
      {
        match: "FROM telegram_subscribers s",
        first: {
          active_watchers: 519,
          new_watchers: 305,
          explicit_coin_follows: 3080,
          active_preset_followers: 43,
          active_dews_opt_ins: 216,
          active_depeg_opt_ins: 479,
          active_safety_opt_ins: 86,
          active_launch_opt_ins: 9,
          active_all_types_opt_ins: 5,
          quiet_hours_enabled_chats: 6,
        },
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
        match: "FROM telegram_subscriptions",
        rows: [{ stablecoin_id: "usdc-circle", subscribers: 479 }],
      },
      {
        match: "FROM telegram_pending_alerts",
        first: { pending_count: 0 },
        rows: [],
      },
    ]);

    const response = await handleTelegramPulse(db);
    const body = (await response.json()) as {
      historySource: string;
      lifecycleHistoryUpdatedAt: number | null;
      watcherHistory: Array<{ date: string; activeWatchers: number; snapshotAt?: number | null }>;
    };

    expect(body.historySource).toBe("snapshot");
    expect(body.lifecycleHistoryUpdatedAt).toBe(1_778_680_000);
    expect(body.watcherHistory).toEqual([
      {
        date: "2026-05-13",
        timestamp: 1_778_630_400_000,
        snapshotAt: 1_778_680_000,
        newWatchers: 305,
        activeWatchers: 519,
        churnedWatchers: 0,
        reactivatedWatchers: 0,
      },
    ]);
  });
});

describe("publishTelegramPulseSnapshot", () => {
  it("reuses heavy public sections on the slower pulse cadence", async () => {
    const nowSec = Math.floor(Date.parse("2026-05-12T12:00:00.000Z") / 1000);
    const cachedPulse = {
      activeWatchers: 8,
      coinSubscriptions: 13,
      explicitCoinSubscriptions: 10,
      presetImpliedCoinSubscriptions: 3,
      activePresetFollowers: 2,
      newWatchersToday: 5,
      churnedWatchersToday: 0,
      reactivatedWatchersToday: 0,
      historySource: "live-fallback",
      topCoins: ["USDC"],
      pendingDeliveries: 5,
      miniAppSessionsToday: 7,
      miniAppMutationsToday: 6,
      miniAppDeniedToday: 2,
      miniAppReplayClaimsToday: 1,
      miniAppOpenToFirstMutationP50Sec: null,
      currentSnapshotAt: nowSec - 600,
      lifecycleHistoryUpdatedAt: nowSec - 3_600,
      lifecycleHistoryEverySeconds: 900,
      quality: { status: "complete", unavailableFields: [] },
      privacy: {
        exactActiveWatchers: true,
        lowCardinalityThreshold: 5,
        suppressedFields: [],
      },
      updatedAt: nowSec - 600,
      updatedEverySeconds: 300,
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
    };
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          {
            key: "telegram:pulse:snapshot",
            value: JSON.stringify(cachedPulse),
            updated_at: nowSec - 600,
          },
          {
            key: "telegram:pulse:heavy-sections-updated-at",
            value: String(nowSec - 600),
            updated_at: nowSec - 600,
          },
        ],
      },
      {
        match: "FROM telegram_subscribers s",
        first: {
          active_watchers: 12,
          new_watchers: 6,
          explicit_coin_follows: 18,
          active_preset_followers: 2,
          active_dews_opt_ins: 10,
          active_depeg_opt_ins: 9,
          active_safety_opt_ins: 8,
          active_launch_opt_ins: 7,
          active_all_types_opt_ins: 6,
          quiet_hours_enabled_chats: 6,
        },
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
    const cachedPulse = {
      activeWatchers: 8,
      coinSubscriptions: 13,
      explicitCoinSubscriptions: 10,
      presetImpliedCoinSubscriptions: 3,
      activePresetFollowers: 2,
      newWatchersToday: 5,
      churnedWatchersToday: 0,
      reactivatedWatchersToday: 0,
      historySource: "live-fallback",
      topCoins: ["USDC"],
      pendingDeliveries: 5,
      miniAppSessionsToday: 99,
      miniAppMutationsToday: 98,
      miniAppDeniedToday: 97,
      miniAppReplayClaimsToday: 96,
      miniAppOpenToFirstMutationP50Sec: null,
      currentSnapshotAt: previousDaySec,
      lifecycleHistoryUpdatedAt: previousDaySec,
      lifecycleHistoryEverySeconds: 900,
      quality: { status: "complete", unavailableFields: [] },
      privacy: {
        exactActiveWatchers: true,
        lowCardinalityThreshold: 5,
        suppressedFields: [],
      },
      updatedAt: previousDaySec,
      updatedEverySeconds: 300,
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
    };
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          {
            key: "telegram:pulse:snapshot",
            value: JSON.stringify(cachedPulse),
            updated_at: previousDaySec,
          },
          {
            key: "telegram:pulse:heavy-sections-updated-at",
            value: String(previousDaySec),
            updated_at: previousDaySec,
          },
        ],
      },
      {
        match: "FROM telegram_subscribers s",
        first: {
          active_watchers: 12,
          new_watchers: 6,
          explicit_coin_follows: 18,
          active_preset_followers: 2,
          active_dews_opt_ins: 10,
          active_depeg_opt_ins: 9,
          active_safety_opt_ins: 8,
          active_launch_opt_ins: 7,
          active_all_types_opt_ins: 6,
          quiet_hours_enabled_chats: 6,
        },
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
        if (!sql.includes("INSERT OR REPLACE INTO cache")) return statement;
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
        first: {
          active_watchers: 12,
          new_watchers: 0,
          explicit_coin_follows: 12,
          active_preset_followers: 0,
          active_dews_opt_ins: 12,
          active_depeg_opt_ins: 8,
          active_safety_opt_ins: 7,
          active_launch_opt_ins: 6,
          active_all_types_opt_ins: 6,
          quiet_hours_enabled_chats: 0,
        },
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
      (entry) => entry.sql.includes("INSERT OR REPLACE INTO cache") && entry.binds[0] === PULSE_SNAPSHOT_KEY,
    );
    expect(snapshotWrites).toHaveLength(1);
  });
});

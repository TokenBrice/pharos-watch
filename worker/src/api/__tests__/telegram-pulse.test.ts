import { describe, expect, it } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleTelegramPulse } from "../telegram-pulse";

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
      alertTypeChats: { dews: 4, depeg: 5, safety: 6, launch: 1, allTypes: 1 },
      quietHoursEnabledChats: 2,
      pendingDeliveries: 0,
      updatedAt: Math.floor(Date.now() / 1000),
      updatedEverySeconds: 300,
      watcherHistory: [],
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
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(cachedPulse);
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM telegram_subscribers s"))).toBe(false);
  });

  it("returns launch-aware public pulse metrics from active subscription rows", async () => {
    const db = mockD1([
      {
        match: "ORDER BY day ASC",
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
      alertTypeChats: { dews: number; depeg: number; safety: number; launch: number; allTypes: number };
      quietHoursEnabledChats: number;
      pendingDeliveries: number;
      updatedAt: number;
      updatedEverySeconds: number;
      watcherHistory: Array<{
        date: string;
        timestamp: number;
        newWatchers: number;
        activeWatchers: number;
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
      newWatchersToday: 2,
      churnedWatchersToday: 0,
      reactivatedWatchersToday: 1,
      historySource: "snapshot",
      topCoins: ["USDPT", "USDC"],
      alertTypeChats: {
        dews: 4,
        depeg: 3,
        safety: 2,
        launch: 1,
        allTypes: 1,
      },
      quietHoursEnabledChats: 2,
      pendingDeliveries: 3,
      updatedAt: expect.any(Number),
      updatedEverySeconds: 300,
      watcherHistory: [
        {
          date: "2026-04-01",
          timestamp: 1775001600000,
          newWatchers: 2,
          activeWatchers: 2,
          churnedWatchers: 0,
          reactivatedWatchers: 0,
        },
        {
          date: "2026-04-03",
          timestamp: 1775174400000,
          newWatchers: 3,
          activeWatchers: 5,
          churnedWatchers: 1,
          reactivatedWatchers: 1,
        },
      ],
    });
  });
});

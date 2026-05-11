import { describe, expect, it } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleTelegramPulse } from "../telegram-pulse";

describe("handleTelegramPulse", () => {
  it("returns launch-aware public pulse metrics from active subscription rows", async () => {
    const db = mockD1([
      {
        match: "ORDER BY day ASC",
        rows: [
          { day: "2026-04-01", day_ts: "1775001600", new_watchers: 2 },
          { day: "2026-04-03", day_ts: "1775174400", new_watchers: 3 },
        ],
      },
      {
        match: "FROM telegram_subscribers s",
        first: {
          active_watchers: 5,
          coin_subscriptions: 7,
          dews_chats: 4,
          depeg_chats: 3,
          safety_chats: 2,
          launch_chats: 1,
          all_types_chats: 1,
          quiet_hours_enabled_chats: 2,
        },
        rows: [],
      },
      {
        match: "FROM telegram_subscriptions",
        rows: [
          { stablecoin_id: "usdpt-western-union" },
          { stablecoin_id: "usdc-circle" },
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
    expect(aggregateQuery?.sql).toContain("SUM(COALESCE(sub.active_sub_count, 0)) AS coin_subscriptions");
    expect(aggregateQuery?.sql).toContain("quiet_hours_enabled_chats");
    expect(aggregateQuery?.sql).toContain("all_types_chats");
    expect(topCoinsQuery?.sql).toContain("alert_launch = 1");
    expect(watcherHistoryQuery?.sql).toContain("date(s.created_at, 'unixepoch')");
    expect(watcherHistoryQuery?.sql).toContain("global_alert_launch");
    expect(watcherHistoryQuery?.sql).toContain("COALESCE(sub.active_sub_count, 0) > 0");
    expect(body).toEqual({
      activeWatchers: 5,
      coinSubscriptions: 7,
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
        { date: "2026-04-01", timestamp: 1775001600000, newWatchers: 2, activeWatchers: 2 },
        { date: "2026-04-03", timestamp: 1775174400000, newWatchers: 3, activeWatchers: 5 },
      ],
    });
  });
});

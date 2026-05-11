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
    ]);

    const response = await handleTelegramPulse(db);
    const body = (await response.json()) as {
      activeWatchers: number;
      coinSubscriptions: number;
      topCoins: string[];
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
    expect(topCoinsQuery?.sql).toContain("alert_launch = 1");
    expect(watcherHistoryQuery?.sql).toContain("date(s.created_at, 'unixepoch')");
    expect(watcherHistoryQuery?.sql).toContain("global_alert_launch");
    expect(watcherHistoryQuery?.sql).toContain("COALESCE(sub.active_sub_count, 0) > 0");
    expect(body).toEqual({
      activeWatchers: 5,
      coinSubscriptions: 7,
      topCoins: ["USDPT", "USDC"],
      watcherHistory: [
        { date: "2026-04-01", timestamp: 1775001600000, newWatchers: 2, activeWatchers: 2 },
        { date: "2026-04-03", timestamp: 1775174400000, newWatchers: 3, activeWatchers: 5 },
      ],
    });
  });
});

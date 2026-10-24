import { describe, expect, it } from "vitest";
import { PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { buildLatestLaunchNews, buildUpcomingCurrencyGroups, LATEST_LAUNCH_NEWS_LIMIT } from "@/lib/upcoming-static-content";

const flags = { governance: "centralized", backing: "rwa-backed", yieldBearing: false, rwa: true, navToken: false } as const;

describe("buildLatestLaunchNews", () => {
  it("returns the newest milestones across coins, newest first, linked to the profile", () => {
    const news = buildLatestLaunchNews([
      {
        id: "a-coin",
        name: "A",
        symbol: "AAA",
        flags: { ...flags, pegCurrency: "HKD" },
        milestones: [
          { date: "2026-03-02", type: "milestone", title: "Licence granted" },
          { date: "2026-09-10", type: "partnership", title: "Bank partner" },
        ],
      },
      {
        id: "b-coin",
        name: "B",
        symbol: "BBB",
        flags: { ...flags, pegCurrency: "JPY" },
        milestones: [{ date: "2026-06-15", type: "announcement", title: "Announced" }],
      },
    ], 2);
    expect(news.map((item) => `${item.dateLabel} · ${item.symbol}: ${item.title}`)).toEqual([
      "Sep 10, 2026 · AAA: Bank partner",
      "Jun 15, 2026 · BBB: Announced",
    ]);
    expect(news[0].href).toBe("/stablecoin/a-coin/");
  });

  it("caps the registry list at the authored limit", () => {
    const total = PRE_LAUNCH_STABLECOINS.reduce((sum, coin) => sum + (coin.milestones?.length ?? 0), 0);
    expect(buildLatestLaunchNews(PRE_LAUNCH_STABLECOINS)).toHaveLength(Math.min(total, LATEST_LAUNCH_NEWS_LIMIT));
  });
});

describe("buildUpcomingCurrencyGroups", () => {
  it("groups every pre-launch coin once, with ISO-coded headings and hub links where hubs exist", () => {
    const groups = buildUpcomingCurrencyGroups(PRE_LAUNCH_STABLECOINS);
    const ids = groups.flatMap((group) => group.coins.map((coin) => coin.id));
    expect(ids.sort()).toEqual(PRE_LAUNCH_STABLECOINS.map((coin) => coin.id).sort());

    const hkd = groups.find((group) => group.peg === "HKD");
    expect(hkd?.heading).toBe("Upcoming Hong Kong Dollar (HKD) stablecoins");
    expect(hkd?.hubHref).toBe("/stablecoins/hkd/");
    expect(groups.find((group) => group.peg === "GOLD")?.heading).toBe("Upcoming Gold stablecoins");
    // Sizes descend, with the non-currency bucket last.
    const ranked = groups.filter((group) => group.peg !== "OTHER").map((group) => group.coins.length);
    expect(ranked).toEqual([...ranked].sort((a, b) => b - a));
    if (groups.some((group) => group.peg === "OTHER")) expect(groups.at(-1)?.peg).toBe("OTHER");
  });
});

import { describe, expect, it } from "vitest";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "../api-query-descriptors";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { getPollingWindow } from "../api-query-polling";

describe("homepage projection query identities", () => {
  it("separates compact live and history views from full publication keys", () => {
    const { homepageSnapshot, homepageHistory, stablecoins, stablecoinCharts, pegSummary } = FRONTEND_API_QUERY_DESCRIPTORS;
    expect(homepageSnapshot.path).toBe("/api/homepage-snapshot");
    expect(homepageHistory.path).toBe("/api/homepage-history");
    expect(homepageSnapshot.queryKey).not.toEqual(stablecoins.queryKey);
    expect(homepageSnapshot.queryKey).not.toEqual(pegSummary.queryKey);
    expect(homepageHistory.queryKey).not.toEqual(stablecoinCharts.queryKey);
    expect(homepageSnapshot.responseMode).toBe("plain");
  });
  it("keeps polling on the existing producer cadences", () => {
    const market = FRONTEND_API_QUERY_DESCRIPTORS.homepageSnapshot;
    const history = FRONTEND_API_QUERY_DESCRIPTORS.homepageHistory;
    expect(market.producerIntervalMs).toBe(CRON_INTERVALS["sync-stablecoins"] * 1000);
    expect(history.producerIntervalMs).toBe(CRON_INTERVALS["sync-stablecoin-charts"] * 1000);
    expect(getPollingWindow(history.producerIntervalMs)).toEqual({ staleTime: history.producerIntervalMs, refetchInterval: history.producerIntervalMs * 2 });
  });
});

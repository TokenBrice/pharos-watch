import { describe, expect, it, vi } from "vitest";
import { handleRequestSourceStats } from "../request-source-stats";
import { mockD1 } from "./helpers/mock-d1";

describe("handleRequestSourceStats", () => {
  it("returns aggregated request-source stats for the requested window", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const db = mockD1([
      {
        match: "FROM api_request_source_stats",
        matchBinds: [1_699_913_600, 1_700_000_000],
        rows: [],
        first: { web_requests: 120, external_requests: 80 },
      },
      {
        match: "GROUP BY route_key, route_path",
        matchBinds: [1_699_913_600, 1_700_000_000, 2],
        rows: [
          {
            route_key: "stablecoins",
            route_path: "/api/stablecoins",
            web_requests: 100,
            external_requests: 40,
          },
          {
            route_key: "stablecoin-detail",
            route_path: "/api/stablecoin/:id",
            web_requests: 20,
            external_requests: 40,
          },
        ],
      },
      {
        match: "GROUP BY CAST(bucket_start / ? AS INTEGER) * ?",
        matchBinds: [3600, 3600, 1_699_913_600, 1_700_000_000, 3600, 3600],
        rows: [
          { bucket_start: 1_699_996_400, web_requests: 70, external_requests: 30 },
          { bucket_start: 1_700_000_000 - 3600, web_requests: 50, external_requests: 50 },
        ],
      },
    ], { requireMatch: true });

    const request = new Request("https://ops-api.pharos.watch/api/request-source-stats?hours=24&bucketSec=3600&routeLimit=2");
    const response = await handleRequestSourceStats(db, true, request);
    const body = await response.json() as {
      totals: { webRequests: number; externalRequests: number; totalRequests: number; externalSharePct: number };
      routes: Array<{ routeKey: string; totalRequests: number; externalSharePct: number }>;
      buckets: Array<{ bucketStart: number; totalRequests: number }>;
      window: { routeLimit: number; bucketSizeSec: number; durationSec: number };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.totals).toEqual({
      webRequests: 120,
      externalRequests: 80,
      totalRequests: 200,
      webSharePct: 60,
      externalSharePct: 40,
    });
    expect(body.routes).toEqual([
      {
        routeKey: "stablecoins",
        routePath: "/api/stablecoins",
        webRequests: 100,
        externalRequests: 40,
        totalRequests: 140,
        webSharePct: 71.43,
        externalSharePct: 28.57,
      },
      {
        routeKey: "stablecoin-detail",
        routePath: "/api/stablecoin/:id",
        webRequests: 20,
        externalRequests: 40,
        totalRequests: 60,
        webSharePct: 33.33,
        externalSharePct: 66.67,
      },
    ]);
    expect(body.buckets).toHaveLength(2);
    expect(body.window).toEqual({
      from: 1_699_913_600,
      to: 1_700_000_000,
      durationSec: 86_400,
      bucketSizeSec: 3600,
      routeLimit: 2,
      retentionDays: 35,
    });
  });
});

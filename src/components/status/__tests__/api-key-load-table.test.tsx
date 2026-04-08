// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ApiRequestAttributionResponse } from "@shared/types";
import { ApiKeyLoadTable } from "../api-key-load-table";

function makeStats(overrides: Partial<ApiRequestAttributionResponse> = {}): ApiRequestAttributionResponse {
  return {
    generatedAt: 1_700_000_000,
    window: {
      from: 1_699_913_600,
      to: 1_700_000_000,
      durationSec: 86_400,
      bucketSizeSec: 3600,
      routeLimit: 5,
      apiKeyLimit: 25,
      retentionDays: 35,
    },
    totals: {
      siteRequests: 600,
      externalRequests: 400,
      totalRequests: 1000,
      siteSharePct: 60,
      externalSharePct: 40,
    },
    siteDelivery: {
      totalSiteRequests: 600,
      pagesCacheHits: 420,
      pagesUpstreamFetches: 150,
      pagesUpstreamTimeouts: 20,
      pagesUpstreamErrors: 10,
      publicApiSiteRequests: 120,
    },
    lanes: [],
    routes: [],
    buckets: [],
    keyedPublicApi: {
      keyedRequests: 220,
      unkeyedRequests: 280,
      totalRequests: 500,
      keyedSharePct: 44,
      unkeyedSharePct: 56,
      totalKeys: 3,
      returnedKeys: 2,
      omittedKeys: 1,
      omittedRequests: 20,
      truncated: true,
    },
    apiKeys: [
      {
        apiKeyId: 7,
        name: "Partner A",
        maskedToken: "ph_live_0123456789abcdef_********",
        trafficClass: "external",
        isActive: true,
        expiresAt: 1_700_100_000,
        rateLimitPerMinute: 180,
        requestCount: 150,
        shareOfKeyedRequestsPct: 68.18,
        shareOfTotalPublicApiRequestsPct: 30,
      },
      {
        apiKeyId: 9,
        name: "Site Automation",
        maskedToken: "ph_live_fedcba9876543210_********",
        trafficClass: "site",
        isActive: false,
        expiresAt: null,
        rateLimitPerMinute: 120,
        requestCount: 50,
        shareOfKeyedRequestsPct: 22.73,
        shareOfTotalPublicApiRequestsPct: 10,
      },
    ],
    scope: {
      countsTotalSiteDemand: true,
      countsWorkerLoad: true,
      includesPagesProxyCacheHits: true,
    },
    ...overrides,
  };
}

describe("ApiKeyLoadTable", () => {
  it("renders keyed request rows and truncation copy", () => {
    render(<ApiKeyLoadTable stats={makeStats()} />);

    expect(screen.getByText("API Key Load")).toBeTruthy();
    expect(screen.getByText("Partner A")).toBeTruthy();
    expect(screen.getByText("Site Automation")).toBeTruthy();
    expect(screen.getByText(/Showing the top 25 keys by volume/i)).toBeTruthy();
    expect(screen.getByText("external")).toBeTruthy();
    expect(screen.getByText("site")).toBeTruthy();
  });

  it("renders an empty state when there is no keyed traffic", () => {
    render(<ApiKeyLoadTable stats={makeStats({
      keyedPublicApi: {
        keyedRequests: 0,
        unkeyedRequests: 500,
        totalRequests: 500,
        keyedSharePct: 0,
        unkeyedSharePct: 100,
        totalKeys: 0,
        returnedKeys: 0,
        omittedKeys: 0,
        omittedRequests: 0,
        truncated: false,
      },
      apiKeys: [],
    })} />);

    expect(screen.getByText(/No authenticated API-key load recorded in this window/i)).toBeTruthy();
  });

  it("renders loading and error states", () => {
    const { rerender } = render(<ApiKeyLoadTable stats={null} isLoading />);
    expect(screen.getByText(/Loading API key load/i)).toBeTruthy();

    rerender(<ApiKeyLoadTable stats={null} error="upstream failed" />);
    expect(screen.getByText("upstream failed")).toBeTruthy();
  });
});

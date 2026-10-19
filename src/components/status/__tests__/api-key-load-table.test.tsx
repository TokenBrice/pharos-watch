// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ApiRequestAttributionResponse } from "@pharos/contracts/request-source";
import { ApiKeyLoadTable } from "../api-key-load-table";
import { makeApiRequestAttributionResponse, makeAttributionMeasurement } from "@/test-utils/status-fixtures";

afterEach(cleanup);

function makeStats(overrides: Partial<ApiRequestAttributionResponse> = {}): ApiRequestAttributionResponse {
  return {
    ...makeApiRequestAttributionResponse(),
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
      measurement: makeApiRequestAttributionResponse().totals.measurement,
    },
    siteDelivery: {
      totalSiteRequests: 600,
      pagesCacheHits: 420,
      pagesUpstreamFetches: 150,
      pagesUpstreamTimeouts: 20,
      pagesUpstreamErrors: 10,
      publicApiSiteRequests: 120,
      measurement: makeApiRequestAttributionResponse().siteDelivery.measurement,
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
      measurement: makeApiRequestAttributionResponse().keyedPublicApi.measurement,
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
        measurement: {
          requestCount: makeAttributionMeasurement(), shareOfKeyedRequestsPct: makeAttributionMeasurement(),
          shareOfTotalPublicApiRequestsPct: makeAttributionMeasurement(),
        },
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
        measurement: {
          requestCount: makeAttributionMeasurement(), shareOfKeyedRequestsPct: makeAttributionMeasurement(),
          shareOfTotalPublicApiRequestsPct: makeAttributionMeasurement(),
        },
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
  it("renders an empty state when there is no keyed traffic", () => {
    render(
      <ApiKeyLoadTable
        stats={makeStats({
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
            measurement: makeApiRequestAttributionResponse().keyedPublicApi.measurement,
          },
          apiKeys: [],
        })}
      />,
    );

    expect(screen.getByText(/No authenticated API-key load recorded in this window/i)).toBeTruthy();
  });

  it("renders loading and error states", () => {
    const { rerender } = render(<ApiKeyLoadTable stats={null} isLoading />);
    expect(screen.getByText(/Loading API key load/i)).toBeTruthy();

    rerender(<ApiKeyLoadTable stats={null} error="upstream failed" />);
    expect(screen.getByText("upstream failed")).toBeTruthy();
  });
  it("keeps recorded key load while labeling an estimated public denominator", () => {
    const stats = makeStats();
    const mixed = makeAttributionMeasurement({
      kind: "mixed", recordedCount: 220, observedSampleCount: 35,
      probabilityStrata: [{ inverseRate: 64, observedSampleCount: 35 }], standardError: 375,
    });
    stats.keyedPublicApi.measurement.totalRequests = mixed;
    stats.keyedPublicApi.measurement.keyedSharePct = mixed;
    stats.apiKeys[0].measurement.shareOfTotalPublicApiRequestsPct = mixed;
    render(<ApiKeyLoadTable stats={stats} />);
    expect(screen.getByText(/Mixed recorded and estimated basis/)).toBeTruthy();
    expect(screen.getByText("Est. 30.0%")).toBeTruthy();
    expect(screen.getByText("150")).toBeTruthy();
    expect(screen.getByText(/Per-key counts and keyed shares are recorded, unsampled/)).toBeTruthy();
  });

  it("renders an unavailable keyed denominator without substituting zero", () => {
    const stats = makeStats();
    const unavailable = makeAttributionMeasurement({ kind: "unavailable", coverage: "unknown", reason: "invalid-key-regime", standardError: null });
    stats.keyedPublicApi.totalRequests = null;
    stats.keyedPublicApi.unkeyedRequests = null;
    stats.keyedPublicApi.keyedSharePct = null;
    stats.keyedPublicApi.measurement.totalRequests = unavailable;
    stats.keyedPublicApi.measurement.unkeyedRequests = unavailable;
    stats.keyedPublicApi.measurement.keyedSharePct = unavailable;
    stats.apiKeys[0].shareOfTotalPublicApiRequestsPct = null;
    stats.apiKeys[0].measurement.shareOfTotalPublicApiRequestsPct = unavailable;
    render(<ApiKeyLoadTable stats={stats} />);
    expect(screen.getByText(/Unavailable: invalid-key-regime/)).toBeTruthy();
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
    expect(screen.getByText("150")).toBeTruthy();
    expect(screen.queryByText(/No authenticated API-key load/)).toBeNull();
  });
});

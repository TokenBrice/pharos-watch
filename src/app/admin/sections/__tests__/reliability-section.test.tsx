// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
});
import type { ApiRequestAttributionResponse, EndpointProbeResult, HealthResponse } from "@shared/types";

vi.mock("@/components/status/api-key-load-table", () => ({
  ApiKeyLoadTable: () => <div data-testid="api-key-load-table">api key load</div>,
}));

vi.mock("@/components/status/cache-freshness-table", () => ({
  CacheFreshnessTable: () => <div data-testid="cache-freshness">cache freshness</div>,
}));

vi.mock("@/components/status/circuit-breaker-table", () => ({
  CircuitBreakerTable: ({ circuits }: { circuits?: Record<string, { state: string }> }) => (
    <div data-testid="circuit-breakers">
      open:{Object.values(circuits ?? {}).filter((c) => c.state === "open").length}
    </div>
  ),
}));

vi.mock("@/components/status/endpoint-health-grid", () => ({
  EndpointHealthGrid: ({ probes }: { probes?: EndpointProbeResult[] }) => (
    <div data-testid="endpoint-health">probes:{probes?.length ?? 0}</div>
  ),
}));

vi.mock("@/components/status/request-source-attribution-card", () => ({
  RequestSourceAttributionCard: () => <div data-testid="request-source-attribution">request source</div>,
}));

import { ReliabilitySection } from "@/app/admin/sections/reliability-section";
import { degraded, makeHealthyStatusResponse } from "@/test-utils/status-fixtures";

const HEALTHY_HEALTH: HealthResponse = {
  status: "healthy",
  timestamp: 1_700_000_000,
  warnings: [],
  caches: {},
  blacklist: {
    totalEvents: 0,
    missingAmounts: 0,
    recentMissingAmounts: 0,
    recentWindowSec: 86_400,
    missingRatio: 0,
  },
  mintBurn: {
    totalEvents: 0,
    latestEventTs: null,
    latestHourlyTs: null,
    freshnessAgeSec: null,
    majorStaleCount: 0,
    staleMajorSymbols: [],
    sync: {
      lastSuccessfulSyncAt: null,
      freshnessStatus: "fresh",
      warning: null,
      criticalLaneHealthy: true,
    },
  },
  circuits: {},
};

const HEALTHY_PROBES: EndpointProbeResult[] = [
  { path: "/api/health", status: 200, latencyMs: 80, semanticStatus: "healthy", semanticScope: "health" },
  { path: "/api/status", status: 200, latencyMs: 90, semanticStatus: "healthy", semanticScope: "status" },
];

const REQUEST_STATS: ApiRequestAttributionResponse = {
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
    siteRequests: 700,
    externalRequests: 300,
    totalRequests: 1000,
    siteSharePct: 70,
    externalSharePct: 30,
  },
  siteDelivery: {
    totalSiteRequests: 700,
    pagesCacheHits: 500,
    pagesUpstreamFetches: 150,
    pagesUpstreamTimeouts: 10,
    pagesUpstreamErrors: 5,
    publicApiSiteRequests: 60,
  },
  lanes: [],
  routes: [],
  buckets: [],
  keyedPublicApi: {
    keyedRequests: 180,
    unkeyedRequests: 120,
    totalRequests: 300,
    keyedSharePct: 60,
    unkeyedSharePct: 40,
    totalKeys: 2,
    returnedKeys: 2,
    omittedKeys: 0,
    omittedRequests: 0,
    truncated: false,
  },
  apiKeys: [],
  scope: {
    countsTotalSiteDemand: true,
    countsWorkerLoad: true,
    includesPagesProxyCacheHits: true,
  },
};

describe("ReliabilitySection", () => {
  it("renders the healthy probe pass/sample counts and public health badge", () => {
    const data = makeHealthyStatusResponse();

    render(
      <ReliabilitySection
        data={data}
        healthData={HEALTHY_HEALTH}
        requestSourceStats={REQUEST_STATS}
        requestSourceError={null}
        requestSourceLoading={false}
        browserProbeSummary={{ sampleCount: 4, passCount: 4, failCount: 0, status: "healthy" }}
        isReliabilityOpen={false}
        setIsReliabilityOpen={vi.fn()}
        probes={HEALTHY_PROBES}
        probesLoading={false}
      />,
    );

    expect(screen.getByText("Probes, breakers, and cache pressure")).toBeTruthy();
    expect(screen.getByText("Public vs operator impact")).toBeTruthy();
    expect(screen.getByText("No public health surface is currently reporting user-visible impact.")).toBeTruthy();
    expect(screen.getByText("Admin service state is healthy.")).toBeTruthy();
    expect(screen.getAllByText("healthy").length).toBeGreaterThan(0);
    expect(screen.getByText("4/4")).toBeTruthy();
    // No "probe fail" hint when failCount is zero
    expect(screen.queryByText(/probe fail/)).toBeNull();
  });

  it("surfaces probe failure count and open-breaker count when probes degrade", () => {
    const data = degraded(makeHealthyStatusResponse(), {
      summary: {
        ...makeHealthyStatusResponse().summary,
        worstCacheRatio: 1.8,
      },
    });
    const degradedHealth: HealthResponse = {
      ...HEALTHY_HEALTH,
      status: "degraded",
      circuits: {
        "binance-spot": {
          state: "open",
          consecutiveFailures: 4,
          lastFailureAt: 1_699_999_900,
          lastSuccessAt: 1_699_980_000,
          openedAt: 1_699_999_900,
        },
      },
    };

    render(
      <ReliabilitySection
        data={data}
        healthData={degradedHealth}
        requestSourceStats={REQUEST_STATS}
        requestSourceError={null}
        requestSourceLoading={false}
        browserProbeSummary={{ sampleCount: 4, passCount: 2, failCount: 2, status: "degraded" }}
        isReliabilityOpen={false}
        setIsReliabilityOpen={vi.fn()}
        probes={HEALTHY_PROBES}
        probesLoading={false}
      />,
    );

    expect(screen.getAllByText("degraded").length).toBeGreaterThan(0);
    expect(screen.getByText("2/4")).toBeTruthy();
    expect(screen.getByText("1.80x")).toBeTruthy();
    // Hint text appears beside the summary label
    expect(screen.getByText(/2 probe fail · cache 1.8x/)).toBeTruthy();
  });

  it("opens the probes/breakers details when isReliabilityOpen is true", () => {
    const data = makeHealthyStatusResponse();

    render(
      <ReliabilitySection
        data={data}
        healthData={HEALTHY_HEALTH}
        requestSourceStats={REQUEST_STATS}
        requestSourceError={null}
        requestSourceLoading={false}
        browserProbeSummary={{ sampleCount: 4, passCount: 4, failCount: 0, status: "healthy" }}
        isReliabilityOpen={true}
        setIsReliabilityOpen={vi.fn()}
        probes={HEALTHY_PROBES}
        probesLoading={false}
      />,
    );

    const details = screen.getByText(/Endpoint probes, circuit breakers, and cache freshness/).closest("details");
    expect(details).toBeTruthy();
    expect(details?.hasAttribute("open")).toBe(true);
  });
});

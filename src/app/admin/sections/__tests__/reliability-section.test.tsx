// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiRequestAttributionResponse } from "@shared/types";
import { degraded, makeHealthyHealthResponse, makeHealthyStatusResponse } from "@/test-utils/status-fixtures";

vi.mock("@/components/status/reliability-impact-panel", () => ({
  ReliabilityImpactPanel: () => <div>Impact panel mounted</div>,
}));
vi.mock("@/components/status/reliability-endpoints-panel", () => ({
  ReliabilityEndpointsPanel: () => <div>Endpoints panel mounted</div>,
}));
vi.mock("@/components/status/reliability-dependencies-panel", () => ({
  ReliabilityDependenciesPanel: () => <div>Dependencies panel mounted</div>,
}));
vi.mock("@/components/status/request-source-attribution-card", () => ({
  RequestSourceAttributionCard: () => <div>Demand attribution mounted</div>,
}));
vi.mock("@/components/status/api-key-load-table", () => ({
  ApiKeyLoadTable: () => <div>API load mounted</div>,
}));
vi.mock("@/components/status/cache-freshness-table", () => ({
  CacheFreshnessTable: () => <div>Cache panel mounted</div>,
}));

import { ReliabilitySection } from "../reliability-section";

const REQUEST_STATS = {
  generatedAt: 1_700_000_000,
  window: { from: 1, to: 2, durationSec: 1, bucketSizeSec: 1, routeLimit: 1, apiKeyLimit: 1, retentionDays: 1 },
  totals: { siteRequests: 0, externalRequests: 0, totalRequests: 0, siteSharePct: 0, externalSharePct: 0 },
  siteDelivery: {
    totalSiteRequests: 0,
    pagesCacheHits: 0,
    pagesUpstreamFetches: 0,
    pagesUpstreamTimeouts: 0,
    pagesUpstreamErrors: 0,
    publicApiSiteRequests: 0,
  },
  lanes: [],
  routes: [],
  buckets: [],
  keyedPublicApi: {
    keyedRequests: 0,
    unkeyedRequests: 0,
    totalRequests: 0,
    keyedSharePct: 0,
    unkeyedSharePct: 0,
    totalKeys: 0,
    returnedKeys: 0,
    omittedKeys: 0,
    omittedRequests: 0,
    truncated: false,
  },
  apiKeys: [],
  scope: { countsTotalSiteDemand: true, countsWorkerLoad: true, includesPagesProxyCacheHits: true },
} as ApiRequestAttributionResponse;

function completeData() {
  const base = makeHealthyStatusResponse();
  return degraded(base, {
    caches: { fixture: { ageSeconds: 30, maxAge: 60, healthy: true } },
    dependencyHealth: {
      checkedAt: base.timestamp,
      dependencies: {},
      rootCauseGroups: [],
      summary: { total: 0, healthy: 0, degraded: 0, stale: 0, unknown: 0, rootCauseGroupCount: 0 },
    },
    providerCircuitHealth: {
      checkedAt: base.timestamp,
      status: "healthy",
      totalTracked: 0,
      closedCount: 0,
      halfOpenCount: 0,
      openCount: 0,
      openProviders: [],
      byFamily: {},
    },
    canaries: {
      checkedAt: base.timestamp,
      status: "healthy",
      latestRunAt: base.timestamp,
      maxAgeSec: 900,
      totalChecks: 0,
      okCount: 0,
      degradedCount: 0,
      errorCount: 0,
      skippedCount: 0,
      staleCount: 0,
      checks: {},
    },
  });
}

function props() {
  const data = completeData();
  return {
    data,
    healthData: makeHealthyHealthResponse(),
    healthError: null,
    healthLoading: false,
    requestSourceStats: REQUEST_STATS,
    requestSourceError: null,
    requestSourceLoading: false,
    browserProbeSummary: {
      sampleCount: 1,
      passCount: 1,
      failCount: 0,
      degradedCount: 0,
      staleCount: 0,
      p95LatencyMs: 20,
      status: "healthy" as const,
      updatedAt: data.timestamp,
    },
    probes: [{ path: "/api/health", status: 200, latencyMs: 20, semanticStatus: "healthy" as const }],
    probesError: null,
    probesLoading: false,
  };
}

beforeEach(() => {
  window.history.replaceState({}, "", "/admin/reliability/?view=impact");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ReliabilitySection", () => {
  it("syncs keyboard mode selection to the URL and lazy-mounts active content", async () => {
    render(<ReliabilitySection {...props()} />);

    const impact = screen.getByRole("tab", { name: /^Impact/ });
    const endpoints = screen.getByRole("tab", { name: /^Endpoints/ });
    const tablist = screen.getByRole("tablist", { name: "Reliability views" });
    expect(screen.getByText("Impact panel mounted")).toBeTruthy();
    expect(screen.queryByText("Endpoints panel mounted")).toBeNull();
    expect(impact.getAttribute("aria-controls")).toBe("reliability-panel-impact");
    expect(endpoints.getAttribute("aria-controls")).toBeNull();
    expect(tablist.className).toContain("min-w-0");
    expect(tablist.className).toContain("max-w-full");

    fireEvent.keyDown(impact, { key: "ArrowRight" });

    await waitFor(() => expect(screen.getByText("Endpoints panel mounted")).toBeTruthy());
    expect(screen.queryByText("Impact panel mounted")).toBeNull();
    expect(window.location.search).toContain("view=endpoints");
    expect(document.activeElement).toBe(endpoints);
    expect(endpoints.getAttribute("aria-controls")).toBe("reliability-panel-endpoints");
    expect(impact.getAttribute("aria-controls")).toBeNull();
  });

  it("keeps demand subordinate in its own mode", async () => {
    render(<ReliabilitySection {...props()} />);

    fireEvent.click(screen.getByRole("tab", { name: /^Demand/ }));
    await waitFor(() => expect(screen.getByText("Demand attribution mounted")).toBeTruthy());
    expect(screen.getByText("API load mounted")).toBeTruthy();
    expect(screen.queryByText("Impact panel mounted")).toBeNull();
    expect(screen.queryByText("Endpoints panel mounted")).toBeNull();
  });

  it("surfaces an inactive dependency loader failure in the workspace summary", () => {
    const baseProps = props();
    const data = degraded(baseProps.data, {
      dependencyHealth: null,
      sectionErrors: {
        dependencyHealth: { code: "dependency_query_failed", message: "Dependency inventory timed out" },
      },
    });

    render(<ReliabilitySection {...baseProps} data={data} />);

    expect(screen.getByText("Reliability evidence is incomplete")).toBeTruthy();
    expect(screen.getByText("Dependency health")).toBeTruthy();
    expect(screen.getByText(/dependencyHealth · dependency_query_failed/)).toBeTruthy();
    expect(screen.getByText("Impact panel mounted")).toBeTruthy();
    expect(screen.queryByText("Dependencies panel mounted")).toBeNull();
  });
});

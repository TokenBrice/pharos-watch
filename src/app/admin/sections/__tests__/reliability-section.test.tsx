// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { degraded, makeApiRequestAttributionResponse, makeHealthyHealthResponse, makeHealthyReliabilityStatusResponse } from "@/test-utils/status-fixtures";

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

const REQUEST_STATS = makeApiRequestAttributionResponse({
  window: { from: 1, to: 2, durationSec: 1, bucketSizeSec: 1, routeLimit: 1, apiKeyLimit: 1, retentionDays: 1 },
});

function completeData() {
  return degraded(makeHealthyReliabilityStatusResponse(), {
    caches: { fixture: { ageSeconds: 30, maxAge: 60, healthy: true } },
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

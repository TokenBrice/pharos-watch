import { describe, expect, it } from "vitest";
import { STATUS_CACHE_RATIO_THRESHOLDS } from "@shared/lib/status-thresholds";
import type { ApiRequestAttributionResponse, HealthResponse, StatusCause, StatusResponse } from "@shared/types";
import {
  buildReliabilityModeUrl,
  buildReliabilityWorkspaceModel,
  parseReliabilityMode,
  type ReliabilityWorkspaceInput,
} from "@/lib/reliability-workspace-model";
import {
  degraded,
  makeHealthyHealthResponse,
  makeHealthyStatusResponse,
  makeOperationalDependencyFailureStatusResponse,
} from "@/test-utils/status-fixtures";

function requestStats(): ApiRequestAttributionResponse {
  return {
    generatedAt: 1_700_000_000,
    window: {
      from: 1_699_913_600,
      to: 1_700_000_000,
      durationSec: 86_400,
      bucketSizeSec: 3_600,
      routeLimit: 5,
      apiKeyLimit: 25,
      retentionDays: 35,
    },
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
  };
}

function completeStatus(base = makeHealthyStatusResponse()): StatusResponse {
  return degraded(base, {
    caches: {
      stablecoins: { ageSeconds: 60, maxAge: 60, healthy: true },
    },
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

function input(overrides: Partial<ReliabilityWorkspaceInput> = {}): ReliabilityWorkspaceInput {
  const data = completeStatus();
  const healthData = makeHealthyHealthResponse();
  return {
    data,
    healthData,
    healthLoading: false,
    probes: [{ path: "/api/health", status: 200, latencyMs: 20, semanticStatus: "healthy", semanticScope: "health" }],
    probesLoading: false,
    browserProbeSummary: {
      sampleCount: 1,
      passCount: 1,
      failCount: 0,
      degradedCount: 0,
      staleCount: 0,
      p95LatencyMs: 20,
      status: "healthy",
      updatedAt: data.timestamp,
    },
    requestSourceStats: requestStats(),
    requestSourceLoading: false,
    ...overrides,
  };
}

describe("reliability URL modes", () => {
  it("parses valid modes and preserves unrelated URL state", () => {
    expect(parseReliabilityMode("?view=dependencies&scope=all")).toBe("dependencies");
    expect(parseReliabilityMode("?view=invalid")).toBeNull();
    expect(
      buildReliabilityModeUrl(
        { pathname: "/admin/reliability/", search: "?scope=all", hash: "#root" } as Location,
        "endpoints",
      ),
    ).toBe("/admin/reliability/?scope=all&view=endpoints#root");
  });
});

describe("reliability issue model", () => {
  it("classifies probes through the shared triage classifier, including non-2xx below 400", () => {
    const model = buildReliabilityWorkspaceModel(
      input({
        probes: [
          { path: "/api/redirected", status: 302, latencyMs: 15 },
          { path: "/api/degraded", status: 200, latencyMs: 15, semanticStatus: "degraded" },
          { path: "/api/ok", status: 204, latencyMs: 15, semanticStatus: "healthy" },
        ],
      }),
    );

    // A non-2xx response below 400 without a semantic status reads as stale on
    // the triage dashboard, so it is critical here too rather than healthy.
    expect(model.endpoints.unhealthyProbes.map((probe) => probe.path)).toEqual([
      "/api/redirected",
      "/api/degraded",
    ]);
    expect(model.endpoints.healthyProbes.map((probe) => probe.path)).toEqual(["/api/ok"]);
    expect(model.issues.find((issue) => issue.id === "endpoint:/api/redirected")?.kind).toBe("critical");
    expect(model.issues.find((issue) => issue.id === "endpoint:/api/degraded")?.kind).toBe("warning");
  });

  it("deduplicates the same cause across overall, availability, and data-quality arrays", () => {
    const cause: StatusCause = {
      code: "fixture_duplicate",
      layer: "availability",
      severity: "warning",
      message: "One repeated availability warning.",
      metric: "fixtureMetric",
    };
    const base = completeStatus();
    const data = degraded(base, {
      causes: { overall: [cause], availability: [cause], dataQuality: [cause] },
    });
    const model = buildReliabilityWorkspaceModel(input({ data }));

    expect(model.issues.filter((issue) => issue.rawCode === "fixture_duplicate")).toHaveLength(1);
    expect(model.modeSummaries.find((mode) => mode.id === "impact")?.issueCount).toBe(1);
  });

  it("uses shared degraded and stale cache thresholds instead of worstCacheRatio > 1", () => {
    const withRatio = (ratio: number) => {
      const base = completeStatus();
      const data = degraded(base, {
        summary: { ...base.summary, worstCacheRatio: ratio },
        caches: { fixture: { ageSeconds: ratio * 60, maxAge: 60, healthy: ratio <= 1 } },
      });
      return buildReliabilityWorkspaceModel(input({ data })).modeSummaries.find((mode) => mode.id === "cache");
    };

    expect(withRatio(1.1)).toMatchObject({ severity: "healthy", issueCount: 0 });
    expect(withRatio(STATUS_CACHE_RATIO_THRESHOLDS.degraded + 0.1)).toMatchObject({
      severity: "watch",
      issueCount: 1,
    });
    expect(withRatio(STATUS_CACHE_RATIO_THRESHOLDS.stale + 0.1)).toMatchObject({
      severity: "critical",
      issueCount: 1,
    });
  });

  it("keeps missing cache evidence Unknown while preserving a real zero-demand response", () => {
    const base = completeStatus();
    const data = degraded(base, {
      caches: { fixture: { ageSeconds: null, maxAge: 60, healthy: false } },
    });
    const model = buildReliabilityWorkspaceModel(input({ data, requestSourceStats: requestStats() }));

    expect(model.modeSummaries.find((mode) => mode.id === "cache")).toMatchObject({
      severity: "unknown",
      issueCount: 1,
    });
    expect(model.modeSummaries.find((mode) => mode.id === "demand")).toMatchObject({
      severity: "healthy",
      issueCount: 0,
    });
  });

  it("surfaces absent inactive evidence in the workspace summary", () => {
    const data = degraded(makeHealthyStatusResponse(), { caches: {} });
    const model = buildReliabilityWorkspaceModel(
      input({
        data,
        healthData: null,
        probes: undefined,
        browserProbeSummary: null,
        requestSourceStats: null,
      }),
    );

    expect(model.evidenceGaps.map((gap) => gap.rawCode)).toEqual(
      expect.arrayContaining([
        "publicHealth",
        "browserProbes",
        "requestSourceStats",
        "dependencyHealth",
        "providerCircuitHealth",
        "canaries",
        "caches",
      ]),
    );
    expect(model.issues.filter((issue) => issue.mode === "impact" && issue.label === "Public health")).toHaveLength(1);
  });

  it("covers dependency roots, provider circuits, canaries, and deduplicates matching circuit ids", () => {
    const data = makeOperationalDependencyFailureStatusResponse(completeStatus());
    const healthData: HealthResponse = {
      ...makeHealthyHealthResponse(),
      circuits: {
        "fixture-provider-a": {
          state: "open",
          consecutiveFailures: 5,
          lastFailureAt: data.timestamp - 30,
          lastSuccessAt: data.timestamp - 3_600,
          openedAt: data.timestamp - 600,
        },
      },
    };
    const model = buildReliabilityWorkspaceModel(input({ data, healthData }));

    expect(model.dependencies.roots[0]).toMatchObject({ id: "fixture-market-cache", status: "stale" });
    expect(model.dependencies.providerCircuits[0]?.providerId).toBe("fixture-provider-a");
    expect(model.dependencies.canaryChecks[0]?.checkId).toBe("fixture-publication-check");
    expect(model.issues.filter((issue) => issue.id === "circuit:fixture-provider-a")).toHaveLength(1);
  });

  it("keeps advisory provider circuits out of the public-service circuit model", () => {
    const base = completeStatus();
    const data = degraded(base, {
      providerCircuitHealth: {
        checkedAt: base.timestamp,
        status: "stale",
        totalTracked: 1,
        closedCount: 0,
        halfOpenCount: 0,
        openCount: 1,
        openProviders: [
          {
            providerId: "dexscreener-liquidity",
            family: "dex-liquidity",
            state: "open",
            consecutiveFailures: 3,
            openedAt: base.timestamp - 600,
            openAgeSec: 600,
            lastFailureAt: base.timestamp - 30,
            lastSuccessAt: base.timestamp - 3_600,
          },
        ],
        byFamily: {
          "dex-liquidity": { total: 1, closed: 0, halfOpen: 0, open: 1 },
        },
      },
    });
    const healthData: HealthResponse = {
      ...makeHealthyHealthResponse(),
      circuits: {
        "dexscreener-liquidity": {
          state: "open",
          consecutiveFailures: 3,
          lastFailureAt: base.timestamp - 30,
          lastSuccessAt: base.timestamp - 3_600,
          openedAt: base.timestamp - 600,
        },
        "defillama-stablecoins": {
          state: "half-open",
          consecutiveFailures: 4,
          lastFailureAt: base.timestamp - 60,
          lastSuccessAt: base.timestamp - 7_200,
          openedAt: base.timestamp - 900,
        },
      },
    };

    const model = buildReliabilityWorkspaceModel(input({ data, healthData }));

    expect(model.dependencies.providerCircuits.map((circuit) => circuit.providerId)).toContain(
      "dexscreener-liquidity",
    );
    expect(model.dependencies.publicCircuits.map(([name]) => name)).toEqual(["defillama-stablecoins"]);
    expect(
      model.issues.some(
        (issue) => issue.label === "dexscreener-liquidity" && issue.rawCode === "public_health_circuit",
      ),
    ).toBe(false);
  });

  it("builds copy diagnostics from allowlisted fields without probe errors or query strings", () => {
    const secret = "Bearer should-never-copy";
    const data = completeStatus();
    const model = buildReliabilityWorkspaceModel(
      input({
        data,
        probes: [
          {
            path: "/api/status?token=should-never-copy",
            status: null,
            latencyMs: 500,
            semanticStatus: "stale",
            error: secret,
          },
        ],
        browserProbeSummary: {
          sampleCount: 1,
          passCount: 0,
          failCount: 1,
          degradedCount: 0,
          staleCount: 1,
          p95LatencyMs: 500,
          status: "stale",
          updatedAt: data.timestamp,
        },
      }),
    );

    expect(model.endpoints.diagnosticText).toContain('"path": "/api/status"');
    expect(model.endpoints.diagnosticText).not.toContain(secret);
    expect(model.endpoints.diagnosticText).not.toContain("should-never-copy");
    expect(model.endpoints.workerPlane.sampledAt).toBe(data.probe.timestamp);
    expect(model.endpoints.browserPlane?.updatedAt).toBe(data.timestamp);
  });
});

import { describe, expect, it } from "vitest";
import { STATUS_CACHE_RATIO_THRESHOLDS } from "@shared/lib/status-thresholds";
import { getCacheImpactStatus } from "@shared/lib/cache-health";
import type { StatusResponse } from "@shared/types";
import { buildReliabilityWorkspaceModel } from "@/lib/reliability-workspace-issue-builder";
import type { ReliabilityWorkspaceInput } from "@/lib/reliability-workspace-model";
import {
  degraded,
  makeApiRequestAttributionResponse,
  makeAttributionMeasurement,
  makeHealthyHealthResponse,
  makeHealthyReliabilityStatusResponse,
  makeHealthyStatusResponse,
} from "@/test-utils/status-fixtures";

function requestStats() {
  return makeApiRequestAttributionResponse({
    window: {
      from: 1_699_913_600,
      to: 1_700_000_000,
      durationSec: 86_400,
      bucketSizeSec: 3_600,
      routeLimit: 5,
      apiKeyLimit: 25,
      retentionDays: 35,
    },
  });
}

function completeStatus(base = makeHealthyStatusResponse()): StatusResponse {
  return degraded(makeHealthyReliabilityStatusResponse(base), {
    caches: {
      stablecoins: { ageSeconds: 60, maxAge: 60, healthy: true },
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

  it.each([2, 2.01, 4, 4.01])("uses the yield-data override at %sx its availability budget", (ratio) => {
    const cache = { ageSeconds: ratio * 3_600, maxAge: 3_600, healthy: ratio <= 2 };
    const data = degraded(completeStatus(), { caches: { "yield-data": cache } });
    const model = buildReliabilityWorkspaceModel(input({ data }));
    const status = getCacheImpactStatus(cache, "yield-data");
    expect(model.modeSummaries.find((mode) => mode.id === "cache")).toMatchObject({
      severity: status === "stale" ? "critical" : status === "degraded" ? "watch" : "healthy",
      issueCount: status === "healthy" ? 0 : 1,
    });
  });

  it("keeps fresh cached-fallback rows degraded through the shared cache-impact helper", () => {
    const data = degraded(completeStatus(), {
      caches: { fixture: { ageSeconds: 0, maxAge: 60, healthy: true, mode: "cached-fallback" } },
    });
    expect(buildReliabilityWorkspaceModel(input({ data })).issues.find((issue) => issue.id === "cache:fixture"))
      .toMatchObject({ kind: "warning" });
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

  it("keeps sampling precision and inconsistent key bases as evidence gaps, not healthy zero traffic", () => {
    const stats = requestStats();
    stats.totals.measurement.totalRequests = makeAttributionMeasurement({
      kind: "estimated", coverage: "unknown", reason: "low-sample", standardError: null,
      probabilityStrata: [{ inverseRate: 64, observedSampleCount: 0 }],
    });
    stats.keyedPublicApi.measurement.totalRequests = makeAttributionMeasurement({
      kind: "unavailable", coverage: "unknown", reason: "invalid-key-regime", standardError: null,
    });
    const model = buildReliabilityWorkspaceModel(input({ requestSourceStats: stats }));
    expect(model.evidenceGaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ mode: "demand", code: "low-sample" }),
      expect.objectContaining({ mode: "demand", code: "invalid-key-regime" }),
    ]));
    expect(model.modeSummaries.find((mode) => mode.id === "impact")?.severity).toBe("healthy");
    expect(model.modeSummaries.find((mode) => mode.id === "demand")?.severity).toBe("unknown");
  });

  it.each([
    ["degraded", "warning"],
    ["stale", "critical"],
    ["unknown", "unknown"],
  ] as const)("raises one dependencies issue for a %s canary aggregate", (status, kind) => {
    const base = makeHealthyReliabilityStatusResponse();
    const data = degraded(base, {
      canaries: {
        ...base.canaries!,
        status,
        totalChecks: 8,
        okCount: 5,
        staleCount: 1,
        failedCount: 1,
        unknownExecutionCount: 1,
        missingCheckIds: ["check-a", "check-b"],
      },
    });

    const issue = buildReliabilityWorkspaceModel(input({ data })).issues.find(
      (candidate) => candidate.id === "canary:aggregate",
    );
    expect(issue).toMatchObject({ mode: "dependencies", kind });
    expect(issue?.detail).toBe("5/8 checks ok; 1 stale, 1 failed, 1 unknown execution, 2 missing.");
  });

  it("adds no canary aggregate issue for a healthy aggregate and leaves per-check issues to their loop", () => {
    const base = makeHealthyReliabilityStatusResponse();
    const model = buildReliabilityWorkspaceModel(input({ data: base }));

    expect(model.issues.find((issue) => issue.id === "canary:aggregate")).toBeUndefined();
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


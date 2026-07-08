import { describe, expect, it } from "vitest";
import type { EndpointProbeResult } from "@shared/types";
import {
  makeHealthyHealthResponse,
  makeHealthyStatusResponse,
  makePublicationFailureStatusResponse,
  makeScheduledSlotEventMarkerQueryFailedStatusResponse,
  makeScheduledSlotRunningQueryFailedStatusResponse,
} from "@/test-utils/status-fixtures";
import { buildBrowserProbeSummary, buildStatusDashboardData } from "../status-dashboard-model";

const BASE_STATUS = makeHealthyStatusResponse();
const BASE_HEALTH = makeHealthyHealthResponse();
const BASE_QUERY_SYNCS = {
  statusUpdatedAt: 1_000_000,
  healthUpdatedAt: 1_000_000,
  probesUpdatedAt: 1_000_000,
  historyUpdatedAt: 1_000_000,
  requestSourceUpdatedAt: 1_000_000,
};

function buildModel(data = makeHealthyStatusResponse()) {
  return buildStatusDashboardData({
    data,
    healthData: BASE_HEALTH,
    probes: [],
    querySyncs: BASE_QUERY_SYNCS,
    nowMs: 1_000_000,
    healthError: null,
    probesError: null,
    historyError: null,
    requestSourceError: null,
    historyTransitions: undefined,
  });
}

describe("status dashboard model", () => {
  it("treats semantic degradation as an unhealthy browser probe", () => {
    const probes: EndpointProbeResult[] = [
      {
        path: "/api/health",
        status: 200,
        latencyMs: 80,
        semanticStatus: "degraded",
        semanticDetail: "Mint/burn sync warning",
        semanticScope: "health",
      },
      {
        path: "/api/stablecoins",
        status: 200,
        latencyMs: 40,
      },
    ];

    expect(buildBrowserProbeSummary(probes, 10_000)).toEqual({
      sampleCount: 2,
      passCount: 1,
      failCount: 1,
      degradedCount: 1,
      staleCount: 0,
      p95LatencyMs: 80,
      status: "degraded",
      updatedAt: 10,
    });
  });

  it("uses the oldest critical query timestamp as the freshness floor", () => {
    const model = buildStatusDashboardData({
      data: BASE_STATUS,
      healthData: BASE_HEALTH,
      probes: [],
      querySyncs: {
        statusUpdatedAt: 900_000,
        healthUpdatedAt: 870_000,
        probesUpdatedAt: 900_000,
        historyUpdatedAt: 900_000,
        requestSourceUpdatedAt: 900_000,
      },
      nowMs: 1_000_000,
      healthError: null,
      probesError: null,
      historyError: null,
      requestSourceError: null,
      historyTransitions: undefined,
    });

    expect(model.clientDataAgeSec).toBe(130);
    expect(model.clientDataStale).toBe(true);
    expect(model.querySyncs.find((sync) => sync.key === "health")?.stale).toBe(true);
    expect(model.notices.some((notice) => notice.id === "client-stale")).toBe(true);
  });

  it("surfaces endpoint errors as operator notices", () => {
    const model = buildStatusDashboardData({
      data: BASE_STATUS,
      healthData: BASE_HEALTH,
      probes: [],
      querySyncs: BASE_QUERY_SYNCS,
      nowMs: 1_000_000,
      healthError: new Error("health down"),
      probesError: new Error("probes down"),
      historyError: new Error("history down"),
      requestSourceError: new Error("request source down"),
      historyTransitions: undefined,
    });

    expect(model.notices.map((notice) => notice.id)).toEqual([
      "health-error",
      "probe-error",
      "history-error",
      "request-source-error",
    ]);
    expect(model.notices.map((notice) => notice.detail)).toEqual([
      "health down",
      "probes down",
      "history down",
      "request source down",
    ]);
  });

  it("surfaces public health divergence with mint/burn context", () => {
    const healthData = {
      ...BASE_HEALTH,
      status: "degraded" as const,
      blacklist: { ...BASE_HEALTH.blacklist, missingAmounts: 3 },
      mintBurn: {
        ...BASE_HEALTH.mintBurn,
        majorStaleCount: 2,
        staleMajorSymbols: ["USDC", "USDT"],
        sync: {
          ...BASE_HEALTH.mintBurn.sync,
          lastSuccessfulSyncAt: BASE_STATUS.timestamp - 600,
          warning: "critical lane delayed",
        },
      },
    };

    const model = buildStatusDashboardData({
      data: BASE_STATUS,
      healthData,
      probes: [],
      querySyncs: BASE_QUERY_SYNCS,
      nowMs: 1_000_000,
      healthError: null,
      probesError: null,
      historyError: null,
      requestSourceError: null,
      historyTransitions: undefined,
    });

    expect(model.healthDiffersFromStatus).toBe(true);
    expect(model.publicHealthNeedsCallout).toBe(true);
    expect(model.notices.find((notice) => notice.id === "public-health")).toMatchObject({
      title: "Public /api/health reports degraded",
      tone: "warning",
    });
    expect(model.notices.find((notice) => notice.id === "public-health")?.detail).toContain(
      "Public /api/health differs from /api/status (healthy). critical lane delayed",
    );
    expect(model.notices.find((notice) => notice.id === "public-health")?.detail).toContain(
      "Impacted majors: USDC, USDT.",
    );
  });

  it("keeps healthy dashboard output byte-identical when failure metadata is absent or empty", () => {
    const healthy = makeHealthyStatusResponse();
    const healthyWithEmptyFailureMetadata = {
      ...healthy,
      publicationHealth: {
        checkedAt: healthy.timestamp,
        surfaces: {},
        failedSurfaces: [],
      },
      summary: {
        ...healthy.summary,
        scheduledSlotRunningQueryFailed: false,
        scheduledSlotEventMarkerQueryFailed: false,
      },
    };

    expect(JSON.stringify(buildModel(healthyWithEmptyFailureMetadata))).toBe(JSON.stringify(buildModel(healthy)));
  });

  it("surfaces publication surface failures as watch-level operator notices", () => {
    const model = buildModel(makePublicationFailureStatusResponse());

    expect(model.notices).toContainEqual({
      id: "publication-failed-dex-liquidity-publication_query_failed-0",
      title: "Publication surface failed: DEX Liquidity (dex-liquidity)",
      detail: "dex-liquidity reported publication_query_failed: Publication ledger latest-generation query failed.",
      tone: "neutral",
    });
    expect(model.attentionSections).toEqual([]);
  });

  it("surfaces scheduled-slot running query failures as watch-level operator notices", () => {
    const model = buildModel(makeScheduledSlotRunningQueryFailedStatusResponse());

    expect(model.notices).toContainEqual({
      id: "scheduled-slot-running-query-failed",
      title: "Scheduled-slot running query failed",
      detail: "Status could not inspect running scheduled slots; stale-slot detection may be incomplete.",
      tone: "neutral",
    });
    expect(model.attentionSections).toEqual([]);
  });

  it("surfaces scheduled-slot event-marker query failures as watch-level operator notices", () => {
    const model = buildModel(makeScheduledSlotEventMarkerQueryFailedStatusResponse());

    expect(model.notices).toContainEqual({
      id: "scheduled-slot-event-marker-query-failed",
      title: "Scheduled-slot event-marker query failed",
      detail: "Status could not inspect scheduled-slot event markers; slot-abandonment diagnostics may be incomplete.",
      tone: "neutral",
    });
    expect(model.attentionSections).toEqual([]);
  });

  it("orders attention sections by operational priority", () => {
    const data = {
      ...BASE_STATUS,
      dataQualityStatus: "stale" as const,
      causes: {
        availability: [],
        overall: [],
        dataQuality: [{
          code: "missing-prices",
          layer: "data-quality" as const,
          severity: "critical" as const,
          message: "Missing prices",
        }],
      },
      summary: {
        ...BASE_STATUS.summary,
        availabilityImpactingUnhealthyCrons: 1,
        availabilityImpactingCronErrors: 1,
        degradedCrons: 1,
      },
    };

    const model = buildStatusDashboardData({
      data,
      healthData: BASE_HEALTH,
      probes: [],
      querySyncs: BASE_QUERY_SYNCS,
      nowMs: 1_000_000,
      healthError: null,
      probesError: null,
      historyError: null,
      requestSourceError: null,
      historyTransitions: undefined,
    });

    expect(model.attentionSections.map((section) => section.id).slice(0, 3)).toEqual([
      "pipeline",
      "crons",
      "reliability",
    ]);
  });
});

import { describe, expect, it } from "vitest";
import type { EndpointProbeResult, StatusCause } from "@shared/types";
import {
  makeHealthyHealthResponse,
  makeHealthyStatusResponse,
  makeActionRecommendedStatusResponse,
  makePublicationFailureStatusResponse,
  makeScheduledSlotEventMarkerQueryFailedStatusResponse,
  makeScheduledSlotRunningQueryFailedStatusResponse,
} from "@/test-utils/status-fixtures";
import {
  STATUS_DASHBOARD_FRESHNESS_POLICY,
  type DashboardQuerySync,
  buildBrowserProbeSummary,
  buildDashboardEvidence,
  buildStatusDashboardData,
} from "../status-dashboard-model";

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

  it("uses the oldest required query timestamp and the shared polling tolerance as the freshness floor", () => {
    const model = buildStatusDashboardData({
      data: BASE_STATUS,
      healthData: BASE_HEALTH,
      probes: [],
      querySyncs: {
        statusUpdatedAt: 900_000,
        healthUpdatedAt: 810_000,
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

    expect(STATUS_DASHBOARD_FRESHNESS_POLICY.staleAfterMs).toBe(180_000);
    expect(model.clientDataAgeSec).toBe(190);
    expect(model.clientDataStale).toBe(true);
    expect(model.querySyncs.find((sync) => sync.key === "health")?.stale).toBe(true);
    expect(model.evidence.state).toBe("stale");
    expect(model.decision.nextStep).toBe("refresh-evidence");
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
      "client-partial",
      "health-error",
      "probe-error",
      "history-error",
      "request-source-error",
    ]);
    expect(model.notices.map((notice) => notice.detail)).toEqual([
      "Public health, Browser probes are unavailable or failed to refresh. Refresh evidence before acting.",
      "Using the last successful response. health down",
      "Using the last successful response. probes down",
      "history down",
      "request source down",
    ]);
  });

  it("deduplicates causes once and separates impacting, warning, maintenance, and watch issues", () => {
    const causes: StatusCause[] = [
      {
        code: "missing_prices_stale",
        layer: "data-quality",
        severity: "critical",
        message: "Missing prices are stale.",
      },
      {
        code: "reserve_sync_degraded",
        layer: "data-quality",
        severity: "warning",
        message: "Reserve coverage is degraded.",
      },
      {
        code: "ddr_repair_debt_present",
        layer: "data-quality",
        severity: "warning",
        message: "Four DDR source events await repair.",
      },
      {
        code: "missing_prices_elevated",
        layer: "data-quality",
        severity: "info",
        message: "Missing prices are elevated.",
      },
    ];
    const data = {
      ...BASE_STATUS,
      causes: {
        overall: causes,
        availability: [],
        dataQuality: causes,
      },
    };

    const model = buildModel(data);

    expect(model.normalizedIssues).toHaveLength(4);
    expect(model.issueGroups.impacting.map((issue) => issue.code)).toEqual(["missing_prices_stale"]);
    expect(model.issueGroups.warnings.map((issue) => issue.code)).toEqual(["reserve_sync_degraded"]);
    expect(model.issueGroups.maintenance.map((issue) => issue.code)).toEqual(["ddr_repair_debt_present"]);
    expect(model.issueGroups.watches.map((issue) => issue.code)).toEqual(["missing_prices_elevated"]);
    expect(model.overallCauseCount).toBe(1);
  });

  it("keeps a healthy system healthy when only planned maintenance remains", () => {
    const maintenanceCause: StatusCause = {
      code: "ddr_repair_debt_present",
      layer: "data-quality",
      severity: "warning",
      message: "Four DDR source events await repair.",
    };
    const data = {
      ...BASE_STATUS,
      causes: {
        overall: [maintenanceCause],
        availability: [],
        dataQuality: [maintenanceCause],
      },
    };

    const model = buildModel(data);

    expect(model.decision).toMatchObject({
      systemState: "healthy",
      evidenceState: "current",
      nextStep: "no-action",
    });
    expect(model.decision.summary).toBe(
      "Public service healthy. Evidence current. No immediate action; one maintenance item is queued.",
    );
    expect(model.blockerCauses).toEqual([]);
  });

  it("treats a never-loaded required query as partial evidence instead of a zero-age success", () => {
    const model = buildStatusDashboardData({
      data: BASE_STATUS,
      healthData: null,
      probes: [],
      querySyncs: {
        ...BASE_QUERY_SYNCS,
        healthUpdatedAt: 0,
      },
      nowMs: 1_000_000,
      healthError: null,
      probesError: null,
      historyError: null,
      requestSourceError: null,
      historyTransitions: undefined,
    });

    expect(model.evidence).toMatchObject({
      state: "partial",
      missingLabels: ["Public health"],
      oldestRequiredSuccessAtMs: null,
      oldestRequiredAgeSec: null,
    });
    expect(model.clientDataAgeSec).toBeNull();
    expect(model.clientDataStale).toBe(true);
    expect(model.decision.nextStep).toBe("refresh-evidence");
    expect(model.notices.some((notice) => notice.id === "client-partial")).toBe(true);
  });

  it("reports evidence unavailable when the primary status query has never loaded", () => {
    const statusSync: DashboardQuerySync = {
      key: "status",
      label: "Status API",
      required: true,
      hasData: false,
      updatedAtMs: 0,
      updatedAtSec: null,
      lastSuccessAtMs: null,
      lastAttemptAtMs: null,
      ageSec: null,
      errorMessage: "initial request failed",
      state: "unavailable",
      stale: false,
    };

    expect(buildDashboardEvidence([statusSync], 1_000_000)).toMatchObject({
      state: "unavailable",
      label: "Unavailable",
      missingLabels: ["Status API"],
      oldestRequiredAgeSec: null,
    });
  });

  it("marks retained last-good data with a refresh error as partial evidence", () => {
    const model = buildStatusDashboardData({
      data: BASE_STATUS,
      healthData: BASE_HEALTH,
      probes: [],
      querySyncs: {
        ...BASE_QUERY_SYNCS,
        healthAttemptedAt: 1_010_000,
      },
      nowMs: 1_010_000,
      healthError: new Error("refresh timed out"),
      probesError: null,
      historyError: null,
      requestSourceError: null,
      historyTransitions: undefined,
    });

    expect(model.evidence).toMatchObject({
      state: "partial",
      refreshErrorLabels: ["Public health"],
    });
    expect(model.querySyncs.find((sync) => sync.key === "health")).toMatchObject({
      hasData: true,
      state: "partial",
      lastAttemptAtMs: 1_010_000,
      lastSuccessAtMs: 1_000_000,
      updatedAtMs: 1_000_000,
    });
    expect(model.decision.nextStep).toBe("refresh-evidence");
  });

  it("keeps retained status data in the model when its background refresh fails", () => {
    const model = buildStatusDashboardData({
      data: BASE_STATUS,
      healthData: BASE_HEALTH,
      probes: [],
      querySyncs: {
        ...BASE_QUERY_SYNCS,
        statusAttemptedAt: 1_010_000,
      },
      nowMs: 1_010_000,
      statusError: new Error("status refresh timed out"),
      healthError: null,
      probesError: null,
      historyError: null,
      requestSourceError: null,
      historyTransitions: undefined,
    });

    expect(model.evidence).toMatchObject({
      state: "partial",
      refreshErrorLabels: ["Status API"],
    });
    expect(model.notices.find((notice) => notice.id === "status-error")).toMatchObject({
      title: "Operator status endpoint failed to refresh",
      detail: "status refresh timed out",
      tone: "critical",
    });
    expect(model.decision.nextStep).toBe("refresh-evidence");
  });

  it("separates public/admin divergence from evidence quality", () => {
    const healthData = { ...BASE_HEALTH, status: "degraded" as const };
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

    expect(model.decision).toMatchObject({
      systemState: "degraded",
      publicState: "degraded",
      adminState: "healthy",
      evidenceState: "current",
      nextStep: "investigate",
      hasPublicAdminDivergence: true,
    });
    expect(model.decision.summary).toBe("Public service degraded. Admin state healthy. Evidence current. Investigate.");
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

  it("keeps a nonzero Comms queue out of attention while shared delivery policy is healthy", () => {
    const healthy = makeHealthyStatusResponse();
    const data = {
      ...healthy,
      telegramBot: {
        ...healthy.telegramBot!,
        pendingDeliveries: 2,
        oldestPendingDeliveryAgeSec: 60,
        oldestDuePendingAgeSec: 60,
        estimatedDrainTimeSec: 60,
        pendingDeliveryBacklog: {
          ...healthy.telegramBot!.pendingDeliveryBacklog!,
          claimable: 2,
          due: 2,
        },
      },
    };

    const model = buildModel(data);
    const comms = model.sections.find((section) => section.id === "comms");

    expect(model.attentionSections.some((section) => section.id === "comms")).toBe(false);
    expect(comms).toMatchObject({ value: "2 pending", valueClassName: "text-green-700 dark:text-green-400" });
  });

  it("surfaces missing Comms telemetry as Unknown attention", () => {
    const data = { ...makeHealthyStatusResponse(), telegramBot: null };
    const model = buildModel(data);
    const comms = model.sections.find((section) => section.id === "comms");

    expect(model.attentionSections.some((section) => section.id === "comms")).toBe(true);
    expect(comms).toMatchObject({ value: "Unknown", valueClassName: "text-muted-foreground" });
    expect(comms?.summary).toContain("Telegram delivery telemetry is unavailable");
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
        dataQuality: [
          {
            code: "missing-prices",
            layer: "data-quality" as const,
            severity: "critical" as const,
            message: "Missing prices",
          },
        ],
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

    expect(model.attentionSections.map((section) => section.id).slice(0, 2)).toEqual(["pipeline", "crons"]);
  });

  it("orders severity before issue volume and keeps Actions out of the causal queue", () => {
    const warnings = Array.from({ length: 150 }, (_, index) => ({
      code: `fixture-warning-${index}`,
      layer: "data-quality" as const,
      severity: "warning" as const,
      message: `Fixture warning ${index}`,
    }));
    const base = makeActionRecommendedStatusResponse();
    const data = {
      ...base,
      dataQualityStatus: "degraded" as const,
      causes: { availability: [], overall: warnings, dataQuality: warnings },
      summary: {
        ...base.summary,
        availabilityImpactingConsecutiveCronErrors: 1,
        availabilityImpactingUnhealthyCrons: 1,
        availabilityImpactingCronErrors: 1,
      },
    };

    const model = buildModel(data);
    expect(model.attentionSections.map((section) => section.id).slice(0, 2)).toEqual(["crons", "pipeline"]);

    const actionModel = buildModel(makeActionRecommendedStatusResponse());
    expect(actionModel.recommendedActions.length).toBeGreaterThan(0);
    expect(actionModel.attentionSections.some((section) => section.id === "actions")).toBe(false);
  });
});

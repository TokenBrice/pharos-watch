import { describe, expect, it } from "vitest";
import type { EndpointProbeResult, StatusCause, StatusResponse } from "@shared/types";
import { StatusResponseSchema } from "@shared/types/status";
import { projectPublicStatus } from "@shared/lib/public-status-components";
import { buildReliabilityWorkspaceModel } from "@/lib/reliability-workspace-issue-builder";
import { buildTriageHeadline } from "@/lib/status/triage-inbox";
import {
  makeActivePriceCoverage,
  makeCompleteTelegramBotStatus,
  makeDispatchMetadata,
  makeHealthyHealthResponse,
  makeHealthyStatusResponse,
  makeMissingActiveAsset,
  makeScheduledSlotEventMarkerQueryFailedStatusResponse,
  makeScheduledSlotRunningQueryFailedStatusResponse,
} from "@/test-utils/status-fixtures";
import {
  STATUS_DASHBOARD_FRESHNESS_POLICY,
  type DashboardQuerySync,
  buildBrowserProbeSummary,
  buildDashboardEvidence,
  buildStatusDashboardData,
  normalizeStatusIssues,
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

function buildModel(
  data: StatusResponse = makeHealthyStatusResponse(),
  overrides: Partial<Parameters<typeof buildStatusDashboardData>[0]> = {},
) {
  return buildStatusDashboardData({
    data,
    healthData: makeHealthyHealthResponse(),
    probes: [],
    querySyncs: { ...BASE_QUERY_SYNCS },
    nowMs: 1_000_000,
    healthError: null,
    probesError: null,
    historyError: null,
    requestSourceError: null,
    historyTransitions: undefined,
    ...overrides,
  });
}

describe("triage and detailed cache parity", () => {
  it.each([
    ["stablecoins", 3, undefined, "healthy", false],
    ["stablecoins", 8, undefined, "healthy", false],
    ["stablecoins", 8.01, undefined, "watch", true],
    ["stablecoins", 12, undefined, "watch", true],
    ["stablecoins", 12.01, undefined, "critical", true],
    ["yield-data", 3, undefined, "healthy", false],
    ["yield-data", 3.01, undefined, "watch", true],
    ["yield-data", 6, undefined, "watch", true],
    ["yield-data", 6.01, undefined, "critical", true],
    ["stablecoins", 0.5, "cached-fallback", "watch", true],
    ["stablecoins", null, undefined, "unknown", true],
  ] as const)("agrees for %s at %sx (%s)", (key, ratio, mode, severity, attention) => {
    const data = {
      ...makeHealthyStatusResponse(),
      caches: { [key]: { ageSeconds: ratio == null ? null : ratio * 100, maxAge: 100, healthy: severity === "healthy", ...(mode ? { mode } : {}) } },
      summary: { ...BASE_STATUS.summary, worstCacheRatio: ratio },
    };
    const healthData = makeHealthyHealthResponse();
    const detail = buildReliabilityWorkspaceModel({
      data, healthData, probes: [], browserProbeSummary: null, requestSourceStats: undefined,
    });
    expect(detail.modeSummaries.find((summary) => summary.id === "cache"))
      .toMatchObject({ severity, issueCount: attention ? 1 : 0 });
    const triage = buildModel(data, { healthData });
    expect(triage.attentionSections.some((section) => section.id === "reliability")).toBe(attention);
    if (severity === "unknown") expect(triage.evidence.state).toBe("current");
  });
});

describe("status dashboard model", () => {
  it("uses the served blacklist component rather than treating queued proof counts as an incident", () => {
    const healthData = makeHealthyHealthResponse();
    healthData.blacklist = { ...healthData.blacklist, missingAmounts: 5, missingRatio: 0.05, recentMissingAmounts: 0 };
    Object.assign(healthData, projectPublicStatus(healthData, undefined, "healthy"));
    healthData.status = "degraded";
    healthData.warnings = ["named-provider-warning"];
    const detail = buildModel(undefined, { healthData }).notices.find((entry) => entry.id === "public-health")?.detail;
    expect(detail).toContain("named-provider-warning");
    expect(detail).not.toContain("Blacklist gaps");
  });

  it.each(["unattributed", "cache age", "cache quality", "unknown coverage", "served projection"])(
    "uses canonical component summaries for warningless unhealthy health (%s)",
    (scenario) => {
      const healthData = makeHealthyHealthResponse();
      healthData.status = "degraded";
      if (scenario === "cache age" || scenario === "served projection") {
        healthData.caches = { stablecoins: { ageSeconds: 13 * 600, maxAge: 600, healthy: false } };
      } else if (scenario === "cache quality") {
        healthData.caches = { "yield-data": { ageSeconds: 30, maxAge: 3600, healthy: false, mode: "cached-fallback" } };
      } else if (scenario === "unknown coverage") {
        healthData.activePriceCoverage = makeActivePriceCoverage([], { status: "unknown", observedAt: null });
      }
      const projection = projectPublicStatus(healthData);
      const summaries = projection.components.filter((component) => component.state !== "operational")
        .map((component) => component.summary);
      if (scenario === "served projection") {
        Object.assign(healthData, projection);
        healthData.caches = {};
      }
      const notice = buildModel(undefined, { healthData }).notices.find((entry) => entry.id === "public-health");
      expect(summaries.length).toBeGreaterThan(0);
      expect(notice?.detail.endsWith(summaries.join(" "))).toBe(true);
    },
  );

  it.each([96_534_823.01, 500_000_000, 2_400_000_000])("keeps a single missing listing operational at a last-known cap of %s", (cap) => {
    const healthData = makeHealthyHealthResponse();
    healthData.stablecoinPublication = {
      status: "incomplete", missingActiveIds: ["hbd-hive"], expectedActiveCount: 396,
      presentActiveCount: 395, waivedActiveCount: 0, waivedActiveIds: [], expiredWaiverIds: [], observedAt: healthData.timestamp,
    };
    healthData.activePriceCoverage = makeActivePriceCoverage([makeMissingActiveAsset({
      stablecoinId: "hbd-hive", marketCapUsd: null, lastKnownMarketCapUsd: cap,
      lastKnownMarketCapObservedAt: healthData.timestamp, lastKnownMarketCapSource: "supply_history",
    })]);
    const component = projectPublicStatus(healthData).components.find((entry) => entry.id === "stablecoin-data");
    expect(component?.state).toBe("operational");
  });

  it("retains named warnings, mint/burn details and blacklist gaps before fallback summaries", () => {
    const healthData = makeHealthyHealthResponse();
    healthData.status = "degraded";
    healthData.warnings = ["named-provider-warning"];
    healthData.mintBurn = { ...healthData.mintBurn, majorStaleCount: 1, staleMajorSymbols: ["USDT"],
      sync: { ...healthData.mintBurn.sync, criticalLaneHealthy: false,
        lastSuccessfulSyncAt: healthData.timestamp - 30, warning: "named-mint-burn-warning" } };
    healthData.blacklist = { ...healthData.blacklist, missingAmounts: 20, missingRatio: 0.02 };
    const detail = buildModel(undefined, { healthData }).notices.find((entry) => entry.id === "public-health")?.detail;
    expect(detail).toContain("named-provider-warning");
    expect(detail).toContain("named-mint-burn-warning");
    expect(detail).toContain("USDT");
    expect(detail).toMatch(/\b20\b/);
  });

  it("admits failed cron history as unavailable Crons attention with its named reason", () => {
    const data = makeHealthyStatusResponse();
    Object.assign(data.summary, {
      unhealthyCrons: null, availabilityImpactingUnhealthyCrons: null, watchUnhealthyCrons: null,
      degradedCrons: null, cronErrors: null, availabilityImpactingCronErrors: null,
      availabilityImpactingConsecutiveCronErrors: null, cronHistoryUnavailableReason: "cron-history-read-failed",
    });
    data.sectionErrors.crons = { code: "cron-history-read-failed", message: "Cron history unavailable." };
    const admitted = StatusResponseSchema.parse(data);
    expect(admitted.summary.cronHistoryUnavailableReason).toBe("cron-history-read-failed");
    const crons = buildModel(admitted).attentionSections.find((section) => section.id === "crons");
    expect(crons?.value).toBe("Unavailable");
    expect(crons?.summary).toContain("cron-history-read-failed");
    expect(crons?.summary).not.toContain("0 watch unhealthy");
    expect(crons?.summary).not.toContain("0 degraded jobs");
    expect(buildModel(makeHealthyStatusResponse()).attentionSections.some((section) => section.id === "crons")).toBe(false);
  });

  it.each([
    ["stablecoins", { stablecoinsCacheStatus: "error" }, "Price coverage unavailable", "0 missing prices"],
    ["blacklist", { blacklistGapStatus: "failed" }, "Blacklist gap evidence unavailable", "0 blacklist gaps"],
    ["onchain read", { onchainSupplyQueryStatus: "failed" }, "On-chain feed evidence unavailable", "0 stale on-chain feeds"],
    ["onchain monitor", { onchainSupplyMonitoring: "unavailable" }, "On-chain feed evidence unavailable", "0 stale on-chain feeds"],
  ] as const)("keeps failed %s counts out of the Triage Pipeline summary", (_source, failure, unavailable, falseZero) => {
    const data = makeHealthyStatusResponse();
    Object.assign(data.dataQuality!, {
      stablecoinsCacheStatus: "ok", blacklistGapStatus: "ok", onchainSupplyQueryStatus: "ok",
      onchainSupplyMonitoring: "active", missingPrices: 0, blacklistMissingAmounts: 0, staleOnchainSupply: 0,
      ...failure,
    });
    const summary = buildModel(data).attentionSections.find((section) => section.id === "pipeline")?.summary;
    expect(summary).toContain(unavailable);
    expect(summary).not.toContain(falseZero);
    expect(summary).toContain(_source === "blacklist" ? "0 missing prices" : "0 blacklist gaps");
  });

  it("retains independently observed zero Pipeline measurements", () => {
    const data = makeHealthyStatusResponse();
    Object.assign(data.dataQuality!, {
      stablecoinsCacheStatus: "ok", blacklistGapStatus: "ok", onchainSupplyQueryStatus: "ok",
      onchainSupplyMonitoring: "active", missingPrices: 0, blacklistMissingAmounts: 0, staleOnchainSupply: 0,
    });
    data.dataQualityStatus = "degraded";
    expect(buildModel(data).attentionSections.find((section) => section.id === "pipeline")?.summary)
      .toBe("0 missing prices, 0 stale on-chain feeds, 0 blacklist gaps");
  });

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
    const reliability = buildModel(BASE_STATUS, { probes }).attentionSections.find((section) => section.id === "reliability");
    expect(reliability?.summary).toContain("browser probes: 1 degraded, 0 stale");
    expect(reliability?.summary).not.toContain("failing browser probes");
  });

  it("uses the oldest required query timestamp and the shared polling tolerance as the freshness floor", () => {
    const model = buildModel(BASE_STATUS, {
      querySyncs: {
        statusUpdatedAt: 900_000,
        healthUpdatedAt: 810_000,
        probesUpdatedAt: 900_000,
        historyUpdatedAt: 900_000,
        requestSourceUpdatedAt: 900_000,
      },
    });

    expect(STATUS_DASHBOARD_FRESHNESS_POLICY.staleAfterMs).toBe(180_000);
    expect(model.evidence.oldestRequiredAgeSec).toBe(190);
    expect(model.clientDataStale).toBe(true);
    expect(model.querySyncs.find((sync) => sync.key === "health")?.stale).toBe(true);
    expect(model.evidence.state).toBe("stale");
    expect(model.decision.nextStep).toBe("refresh-evidence");
    expect(model.notices.some((notice) => notice.id === "client-stale")).toBe(true);
  });

  it("surfaces endpoint errors as operator notices", () => {
    const model = buildModel(BASE_STATUS, {
      healthError: new Error("health down"),
      probesError: new Error("probes down"),
      historyError: new Error("history down"),
      requestSourceError: new Error("request source down"),
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

  it("treats a never-loaded required query as partial evidence instead of a zero-age success", () => {
    const model = buildModel(BASE_STATUS, {
      healthData: null,
      querySyncs: {
        ...BASE_QUERY_SYNCS,
        healthUpdatedAt: 0,
      },
    });

    expect(model.evidence).toMatchObject({
      state: "partial",
      missingLabels: ["Public health"],
      oldestRequiredSuccessAtMs: null,
      oldestRequiredAgeSec: null,
    });
    // A missing required source is not a "current" read, and the triage line
    // refuses to answer rather than reporting nothing to do.
    expect(model.evidence.label).not.toMatch(/^Current/);
    expect(
      buildTriageHeadline({ items: [], act: [], watch: [], informational: [] }, model.evidence),
    ).toEqual({ verdict: "unavailable", text: "Cannot answer: Public health unavailable. Showing the last good read." });
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
    const model = buildModel(BASE_STATUS, {
      nowMs: 1_010_000,
      healthError: new Error("refresh timed out"),
    });

    expect(model.evidence).toMatchObject({
      state: "partial",
      refreshErrorLabels: ["Public health"],
    });
    expect(model.querySyncs.find((sync) => sync.key === "health")).toMatchObject({
      hasData: true,
      state: "partial",
      errorMessage: "refresh timed out",
      updatedAtMs: 1_000_000,
    });
    expect(model.decision.nextStep).toBe("refresh-evidence");
  });

  it("keeps retained status data in the model when its background refresh fails", () => {
    const model = buildModel(BASE_STATUS, {
      nowMs: 1_010_000,
      statusError: new Error("status refresh timed out"),
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
    const model = buildModel(BASE_STATUS, { healthData });

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

  it("creates a warning triage issue for incomplete active-price coverage", () => {
    const rawActivePriceCause: StatusCause = {
      code: "active_price_coverage_incomplete",
      layer: "data-quality",
      severity: "warning",
      message: "Live prices are missing for 1 active asset(s): nxusd-nereus.",
      metric: "missingActivePrices",
      value: 1,
      threshold: 1,
      runbookUrl: "https://example.com/stablecoins-cache",
    };
    const statusData = {
      ...BASE_STATUS,
      causes: {
        overall: [rawActivePriceCause],
        availability: [],
        dataQuality: [rawActivePriceCause],
      },
    };
    const healthData = {
      ...BASE_HEALTH,
      status: "healthy" as const,
      warnings: ["active-price-coverage-incomplete:nxusd-nereus"],
      activePriceCoverage: makeActivePriceCoverage([
        makeMissingActiveAsset({
          stablecoinId: "nxusd-nereus",
          symbol: "NXUSD",
          marketCapUsd: 1_500_000,
          consecutiveMissingGenerations: 2,
          lastAcceptedPrice: 1,
          lastAcceptedSource: "coingecko",
          lastAcceptedObservedAt: BASE_HEALTH.timestamp - 900,
          alertEligible: true,
        }),
      ]),
    };

    const model = buildModel(statusData, { healthData });

    expect(model.issueGroups.impacting).toHaveLength(0);
    expect(model.issueGroups.warnings).toHaveLength(1);
    expect(model.issueGroups.warnings[0]).toMatchObject({
      code: "active_price_coverage_incomplete",
      publicImpacting: false,
      affectedSurface: "Stablecoin prices",
      value: 1,
    });
    expect(model.issueGroups.warnings[0]?.message).toBe(
      "Live prices are unavailable for 1 active asset: NXUSD. Stablecoin listings and price-dependent analytics may be incomplete until coverage recovers.",
    );
    expect(model.issueGroups.warnings[0]?.runbookUrl).toBe("https://example.com/stablecoins-cache");
    expect(model.decision.nextStep).toBe("observe-next-run");
  });

  it("does not synthesize active-price warning issues without a health warning", () => {
    const healthData = {
      ...BASE_HEALTH,
      status: "healthy" as const,
      warnings: [],
      activePriceCoverage: makeActivePriceCoverage([], {
        pricedActiveCount: 189,
        missingPriceCount: 1,
        missingActiveIds: ["test-dollar"],
        affectedMarketCapUsd: 500_000,
        maxConsecutiveMissingGenerations: 1,
      }),
    };

    const model = buildModel(BASE_STATUS, { healthData });

    expect(model.issueGroups.warnings.some((issue) => issue.code === "active_price_coverage_incomplete")).toBe(false);
    expect(model.issueGroups.impacting).toHaveLength(0);
  });

  it("maps unknown exact active-price coverage to the stablecoin price surface", () => {
    const issues = normalizeStatusIssues({
      overall: [
        {
          code: "active_price_coverage_unknown",
          layer: "data-quality",
          severity: "warning",
          message: "Exact active stablecoin live-price coverage evidence is unavailable.",
        },
      ],
      availability: [],
      dataQuality: [],
    });

    expect(issues[0]).toMatchObject({
      publicImpacting: true,
      affectedSurface: "Stablecoin prices",
    });
  });

  it.each(["healthy", "degraded"] as const)("keeps Safety divergence visible only while effective status still lags (%s)", (effectiveStatus) => {
    const cause: StatusCause = {
      code: "safety_score_publication_held", layer: "availability", severity: "warning",
      message: "Safety Score publication is held while required inputs recover (redemption-stale).",
    };
    const data = makeHealthyStatusResponse();
    data.overallStatus = effectiveStatus;
    data.rawOverallStatus = "degraded";
    data.availabilityStatus = "degraded";
    data.causes = { availability: [cause], dataQuality: [], overall: [cause] };
    const healthData = makeHealthyHealthResponse();
    healthData.status = "degraded";
    healthData.warnings = ["safety-score-publication-held"];
    const model = buildModel(data, { healthData });
    expect(model.issueGroups.impacting).toContainEqual(expect.objectContaining({
      code: "safety_score_publication_held", publicImpacting: true,
    }));
    const notice = model.notices.find((entry) => entry.id === "public-health");
    if (effectiveStatus === "healthy") expect(notice?.detail).toContain("Public /api/health differs from /api/status");
    else expect(notice?.detail).not.toContain("Public /api/health differs from /api/status");
  });

  it("keeps reviewed nominal price references out of the dashboard issues and watch count", () => {
    const nominal: StatusCause = {
      code: "active_price_coverage_nominal_reference",
      layer: "data-quality",
      severity: "info",
      message: "Reviewed nominal references, not observed market prices, cover: sBOLD. These are not missing-price gaps.",
      metric: "nominalReferenceCount",
      value: 1,
    };
    const watch: StatusCause = {
      code: "mint_burn_public_degraded",
      layer: "availability",
      severity: "info",
      message: "Fresh healthy lane; execution notice.",
    };
    const data: StatusResponse = {
      ...BASE_STATUS,
      causes: { overall: [nominal, watch], availability: [watch], dataQuality: [nominal] },
    };

    const issues = normalizeStatusIssues(data.causes);
    expect(issues.map((issue) => issue.code)).toEqual(["mint_burn_public_degraded"]);

    const model = buildModel(data);
    expect(model.issueGroups.watches.map((issue) => issue.code)).toEqual(["mint_burn_public_degraded"]);
    expect(model.decision.summary).toContain("1 informational watch remains");
    // The by-design cause stays in the status payload it was read from.
    expect(data.causes.dataQuality).toEqual([nominal]);
  });

  it("surfaces missing Comms telemetry as Unavailable attention", () => {
    const data = { ...makeHealthyStatusResponse(), telegramBot: null };
    const model = buildModel(data);
    const comms = model.attentionSections.find((section) => section.id === "comms");

    expect(comms).toMatchObject({ value: "Unavailable", valueClassName: "text-muted-foreground" });
    expect(comms?.summary).toContain("Telegram delivery telemetry is unavailable");
  });

  it("names source suppression and labels eligible chats separately from delivery counts", () => {
    const data = makeHealthyStatusResponse();
    data.telegramBot = { ...makeCompleteTelegramBotStatus(), deliverableChats: 783 };
    data.crons["dispatch-telegram-alerts"].latestRunFacts = makeDispatchMetadata({
      safetyAlertsSuppressed: true, safetyAlertSourceState: "stale",
    });
    const comms = buildModel(data).attentionSections.find((section) => section.id === "comms");
    expect(comms?.summary).toContain("Safety alerts are suppressed because their source input is stale.");
    expect(comms?.summary).toContain("Eligible alert audience: 783 chats (not a delivery count).");
    expect(comms?.summary).not.toContain("dispatch reported a degraded outcome");
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

});

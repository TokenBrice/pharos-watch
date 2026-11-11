import { describe, expect, it } from "vitest";
import type { EndpointProbeResult } from "@shared/types/status/public-health";
import type { StatusCause } from "@shared/types/status/core";
import type { StatusResponse } from "@shared/types/status/response";
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

function cause(code: string, severity: StatusCause["severity"] = "info", layer: StatusCause["layer"] = "data-quality"): StatusCause {
  return { code, severity, layer, message: code };
}

const ZERO_PIPELINE = {
  stablecoinsCacheStatus: "ok", blacklistGapStatus: "ok", onchainSupplyQueryStatus: "ok",
  onchainSupplyMonitoring: "active", missingPrices: 0, blacklistMissingAmounts: 0, staleOnchainSupply: 0,
};

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
  it("uses served blacklist health despite queued proofs", () => {
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
    "summarizes warningless unhealthy health (%s)",
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

  it.each([96_534_823.01, 500_000_000, 2_400_000_000])("keeps one missing listing operational at cap %s", (cap) => {
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

  it("retains named health warnings before fallback summaries", () => {
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

  it("admits cron history failure with its reason", () => {
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
  ] as const)("does not report failed %s counts as zero", (_source, failure, unavailable, falseZero) => {
    const data = makeHealthyStatusResponse();
    Object.assign(data.dataQuality!, {
      ...ZERO_PIPELINE,
      ...failure,
    });
    const summary = buildModel(data).attentionSections.find((section) => section.id === "pipeline")?.summary;
    expect(summary).toContain(unavailable);
    expect(summary).not.toContain(falseZero);
    expect(summary).toContain(_source === "blacklist" ? "0 missing prices" : "0 blacklist gaps");
  });

  it("retains observed Pipeline zeroes", () => {
    const data = makeHealthyStatusResponse();
    Object.assign(data.dataQuality!, ZERO_PIPELINE);
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

  it("ages evidence from the oldest required query", () => {
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

  it("surfaces endpoint errors", () => {
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

  it("marks never-loaded required evidence partial", () => {
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
    // Missing required evidence is not answerable.
    expect(model.evidence.label).not.toMatch(/^Current/);
    expect(
      buildTriageHeadline({ items: [], act: [], watch: [], informational: [] }, model.evidence),
    ).toEqual({ verdict: "unavailable", text: "Cannot answer: Public health unavailable. Showing the last good read." });
    expect(model.clientDataStale).toBe(true);
    expect(model.decision.nextStep).toBe("refresh-evidence");
    expect(model.notices.some((notice) => notice.id === "client-partial")).toBe(true);
  });

  it("marks never-loaded status unavailable", () => {
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

  it.each([
    ["health", "Public health", "refresh timed out"],
    ["status", "Status API", "status refresh timed out"],
  ] as const)("retains %s after a failed refresh", (key, label, message) => {
    const model = buildModel(BASE_STATUS, { nowMs: 1_010_000, [`${key}Error`]: new Error(message) });
    expect(model.evidence).toMatchObject({ state: "partial", refreshErrorLabels: [label], missingLabels: [] });
    expect(buildTriageHeadline({ items: [], act: [], watch: [], informational: [] }, model.evidence).verdict).toBe("unavailable");
    if (key === "health") {
      expect(model.querySyncs.find((sync) => sync.key === key)).toMatchObject({
        hasData: true, state: "partial", errorMessage: message, updatedAtMs: 1_000_000,
      });
    } else {
      expect(model.notices.find((notice) => notice.id === "status-error")).toMatchObject({
        title: "Operator status endpoint failed to refresh", detail: message, tone: "critical",
      });
    }
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

  it("warns on incomplete active-price coverage", () => {
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

  it("watches first-generation price gaps without warnings", () => {
    const healthData = {
      ...BASE_HEALTH,
      activePriceCoverage: makeActivePriceCoverage([makeMissingActiveAsset()]),
    };

    const gap = cause("active_price_coverage_incomplete");
    const model = buildModel({ ...BASE_STATUS, causes: { overall: [gap], availability: [], dataQuality: [gap] } }, { healthData });

    expect(model.issueGroups.warnings.some((issue) => issue.code === "active_price_coverage_incomplete")).toBe(false);
    expect(model.issueGroups.impacting).toHaveLength(0);
    expect(model.issueGroups.watches.map((issue) => issue.code)).toEqual([gap.code]);
  });

  it("maps unknown price coverage to Stablecoin prices", () => {
    const issues = normalizeStatusIssues({
      overall: [cause("active_price_coverage_unknown", "warning")], availability: [], dataQuality: [],
    });

    expect(issues[0]).toMatchObject({
      publicImpacting: true,
      affectedSurface: "Stablecoin prices",
    });
  });

  it.each(["healthy", "degraded"] as const)("shows Safety divergence only while status lags (%s)", (effectiveStatus) => {
    const cause: StatusCause = {
      code: "safety_score_publication_held", layer: "availability", severity: "warning",
      message: "Safety publication held.",
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

  it("excludes standing notices from watch counts", () => {
    const watchCodes = ["depeg_blind_event_reviews_expiring", "mint_burn_public_degraded", "supply_carry_reviews_expired", "supply_carry_reviews_expiring"];
    const watches = watchCodes.map((code) => cause(code));
    const standing = [
      "active_price_coverage_nominal_reference", "reserve_feed_reviews_acknowledged",
      "supply_carry_reviews_acknowledged", "depeg_blind_event_reviews_acknowledged", "active_price_coverage_incomplete",
    ].map((code) => cause(code));
    const data = { ...BASE_STATUS, causes: { overall: [...standing, ...watches], availability: watches, dataQuality: standing } };
    const healthData = makeHealthyHealthResponse();
    healthData.activePriceCoverage = makeActivePriceCoverage(
      ["reviewed", "closed"].map((stablecoinId) => makeMissingActiveAsset({ stablecoinId })),
      { acknowledgedGapIds: ["reviewed"], scheduledClosureGapIds: ["closed"] },
    );
    const model = buildModel(data, { healthData });
    expect(model.issueGroups.watches.map((issue) => issue.code)).toEqual(watchCodes);
    expect(model.decision.summary).toContain("4 informational watches remain");
    healthData.activePriceCoverage.missingActiveIds.push("first-generation-unacknowledged");
    expect(buildModel(data, { healthData }).issueGroups.watches.map((issue) => issue.code))
      .toEqual(["active_price_coverage_incomplete", ...watchCodes]);
    expect(data.causes.dataQuality).toEqual(standing);
  });

  it("marks missing Comms telemetry unavailable", () => {
    const data = { ...makeHealthyStatusResponse(), telegramBot: null };
    const model = buildModel(data);
    const comms = model.attentionSections.find((section) => section.id === "comms");

    expect(comms).toMatchObject({ value: "Unavailable", valueClassName: "text-muted-foreground" });
    expect(comms?.summary).toContain("Telegram delivery telemetry is unavailable");
  });

  it("names suppression and distinguishes audience from delivery", () => {
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

  it.each([
    ["running", makeScheduledSlotRunningQueryFailedStatusResponse,
      "Status could not inspect running scheduled slots; stale-slot detection may be incomplete."],
    ["event-marker", makeScheduledSlotEventMarkerQueryFailedStatusResponse,
      "Status could not inspect scheduled-slot event markers; slot-abandonment diagnostics may be incomplete."],
  ] as const)("surfaces scheduled-slot %s query failures as watches", (kind, fixture, detail) => {
    const model = buildModel(fixture());
    expect(model.notices).toContainEqual({
      id: `scheduled-slot-${kind}-query-failed`, title: `Scheduled-slot ${kind} query failed`, detail, tone: "neutral",
    });
    expect(model.attentionSections).toEqual([]);
  });
});

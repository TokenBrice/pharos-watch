import { describe, expect, it } from "vitest";
import { StatusResponseSchema, TELEGRAM_ALERT_TYPES } from "@shared/types/status";
import { buildActionReadinessChecks } from "@/lib/status/admin-ops-insights";
import { deriveStatusActionRecommendations } from "@/lib/status/action-recommendations";
import { buildStatusDashboardData } from "@/lib/status-dashboard-model";
import {
  makeActionBlockedStatusResponse,
  makeActionRecommendedStatusResponse,
  makeBackgroundRefreshFailureInputs,
  makeCurrentStatusDashboardInputs,
  makeDegradedPublicHealthResponse,
  makeDegradedPublicImpactStatusResponse,
  makeFullyHealthyCurrentStatusResponse,
  makeHealthyHealthResponse,
  makeHealthyStatusResponse,
  makeLongCommsStatusResponse,
  makeMaintenanceDebtStatusResponse,
  makeMissingNeverLoadedEvidenceInputs,
  makeOperationalDependencyFailureStatusResponse,
  makePublicationFailureStatusResponse,
  makeRecoveryHoldStatusResponse,
  makeSectionLoaderFailureStatusResponse,
  makeStaleEvidenceInputs,
} from "@/test-utils/status-fixtures";

describe("status review fixtures", () => {
  it("keeps every status variant inside the runtime response schema", () => {
    const variants = {
      healthy: makeFullyHealthyCurrentStatusResponse(),
      maintenance: makeMaintenanceDebtStatusResponse(),
      publicImpact: makeDegradedPublicImpactStatusResponse(),
      recoveryHold: makeRecoveryHoldStatusResponse(),
      sectionFailure: makeSectionLoaderFailureStatusResponse(),
      operationalFailure: makeOperationalDependencyFailureStatusResponse(),
      actionRecommended: makeActionRecommendedStatusResponse(),
      actionBlocked: makeActionBlockedStatusResponse(),
      longComms: makeLongCommsStatusResponse(),
    };

    for (const [name, status] of Object.entries(variants)) {
      const result = StatusResponseSchema.safeParse(status);
      expect(result.success, `${name}: ${result.success ? "" : result.error.message}`).toBe(true);
    }
  });

  it("keeps healthy, public-impact degraded, and publication-query-unavailable dashboard tuples aligned", () => {
    const publicationFixture = makePublicationFailureStatusResponse();
    const publicationQueryUnavailable = StatusResponseSchema.parse({
      ...publicationFixture,
      publicationHealth: {
        checkedAt: publicationFixture.timestamp,
        surfaces: {},
        failedSurfaces: [{
          surface: "yield-rankings",
          code: "publication_surface_query_failed",
          message: "Publication surface query failed.",
        }],
      },
    });
    const scenarios = [
      {
        name: "healthy",
        data: makeFullyHealthyCurrentStatusResponse(),
        healthData: makeHealthyHealthResponse(),
        expected: {
          states: ["healthy", "healthy", "healthy", "current", "no-action"],
          issues: [],
          noticeIds: [],
        },
      },
      {
        name: "degraded public impact",
        data: makeDegradedPublicImpactStatusResponse(),
        healthData: makeDegradedPublicHealthResponse(),
        expected: {
          states: ["degraded", "degraded", "degraded", "current", "investigate"],
          issues: [["cache_ratio_degraded", "impacting", true]],
          noticeIds: ["public-health"],
        },
      },
      {
        name: "supplement query unavailable",
        data: publicationQueryUnavailable,
        healthData: makeHealthyHealthResponse(),
        expected: {
          states: ["healthy", "healthy", "healthy", "current", "no-action"],
          issues: [],
          noticeIds: ["publication-failed-yield-rankings-publication_surface_query_failed-0"],
        },
      },
    ];

    for (const scenario of scenarios) {
      const parsed = StatusResponseSchema.parse(scenario.data);
      const dashboard = buildStatusDashboardData(
        makeCurrentStatusDashboardInputs({ data: parsed, healthData: scenario.healthData }),
      );

      expect({
        states: [dashboard.decision.systemState, dashboard.decision.publicState, dashboard.decision.adminState, dashboard.evidence.state, dashboard.decision.nextStep],
        issues: dashboard.normalizedIssues.map(({ code, kind, publicImpacting }) => [code, kind, publicImpacting]),
        noticeIds: dashboard.notices.map((notice) => notice.id),
      }).toEqual(scenario.expected);
    }

    const degraded = makeDegradedPublicImpactStatusResponse();
    const changedCauseCode = structuredClone(degraded);
    changedCauseCode.causes.availability[0]!.code = "cache_ratio_unknown";
    changedCauseCode.causes.overall[0]!.code = "cache_ratio_unknown";
    const changedDashboard = buildStatusDashboardData(
      makeCurrentStatusDashboardInputs({ data: changedCauseCode, healthData: makeDegradedPublicHealthResponse() }),
    );
    expect(changedDashboard.normalizedIssues.map(({ code, kind, publicImpacting }) => [code, kind, publicImpacting]))
      .toEqual([["cache_ratio_unknown", "warning", false]]);

    const publicationWithoutFailureNotice = structuredClone(publicationQueryUnavailable);
    delete publicationWithoutFailureNotice.publicationHealth?.failedSurfaces;
    const noticeIds = buildStatusDashboardData(
      makeCurrentStatusDashboardInputs({ data: publicationWithoutFailureNotice, healthData: makeHealthyHealthResponse() }),
    ).notices.map((notice) => notice.id);
    expect(noticeIds).not.toContain("publication-failed-yield-rankings-publication_surface_query_failed-0");
  });

  it("builds deterministic variants without mutating a supplied baseline", () => {
    const baseline = makeHealthyStatusResponse();
    const before = structuredClone(baseline);

    expect(makeMaintenanceDebtStatusResponse(baseline)).toEqual(makeMaintenanceDebtStatusResponse(baseline));
    expect(baseline).toEqual(before);
  });

  it("models fully current, missing, stale, and retained-last-good evidence distinctly", () => {
    const current = buildStatusDashboardData(makeCurrentStatusDashboardInputs());
    const missing = buildStatusDashboardData(makeMissingNeverLoadedEvidenceInputs());
    const stale = buildStatusDashboardData(makeStaleEvidenceInputs());
    const refreshFailure = buildStatusDashboardData(makeBackgroundRefreshFailureInputs());

    expect(current.evidence.state).toBe("current");
    expect(current.decision.nextStep).toBe("no-action");

    expect(missing.evidence.state).toBe("partial");
    expect(missing.evidence.missingLabels).toEqual(["Public health", "Browser probes"]);
    expect(missing.decision.nextStep).toBe("refresh-evidence");

    expect(stale.evidence.state).toBe("stale");
    expect(stale.evidence.staleLabels).toEqual(["Status API", "Public health", "Browser probes"]);
    expect(stale.decision.nextStep).toBe("refresh-evidence");

    expect(refreshFailure.evidence.state).toBe("partial");
    expect(refreshFailure.evidence.missingLabels).toEqual([]);
    expect(refreshFailure.evidence.refreshErrorLabels).toEqual(["Status API", "Public health", "Browser probes"]);
    expect(refreshFailure.notices.map((notice) => notice.id)).toEqual(
      expect.arrayContaining(["status-error", "health-error", "probe-error"]),
    );
    expect(refreshFailure.notices.find((notice) => notice.id === "health-error")?.detail).toContain(
      "Using the last successful response.",
    );
  });

  it("separates maintenance, public impact, recovery hold, and recommended-action decisions", () => {
    const maintenance = buildStatusDashboardData(
      makeCurrentStatusDashboardInputs({ data: makeMaintenanceDebtStatusResponse() }),
    );
    const publicImpact = buildStatusDashboardData(
      makeCurrentStatusDashboardInputs({
        data: makeDegradedPublicImpactStatusResponse(),
        healthData: makeDegradedPublicHealthResponse(),
      }),
    );
    const recoveryHold = buildStatusDashboardData(
      makeCurrentStatusDashboardInputs({ data: makeRecoveryHoldStatusResponse() }),
    );
    const actionRecommended = buildStatusDashboardData(
      makeCurrentStatusDashboardInputs({ data: makeActionRecommendedStatusResponse() }),
    );

    expect(maintenance.issueGroups.maintenance).toHaveLength(1);
    expect(maintenance.decision.nextStep).toBe("no-action");

    expect(publicImpact.issueGroups.impacting.map((issue) => issue.code)).toContain("cache_ratio_degraded");
    expect(publicImpact.decision.systemState).toBe("degraded");
    expect(publicImpact.decision.nextStep).toBe("investigate");

    expect(recoveryHold.decision.adminState).toBe("degraded");
    expect(recoveryHold.decision.nextStep).toBe("investigate");

    expect(actionRecommended.recommendedActions.map((item) => item.action.path)).toContain("/api/backfill-cg-prices");
    expect(actionRecommended.decision.nextStep).toBe("manual-action");
  });

  it("provides blocked readiness inputs without concrete execution-record coupling", () => {
    const data = makeActionBlockedStatusResponse();
    const recommendedActions = deriveStatusActionRecommendations(data);
    const checks = buildActionReadinessChecks({
      data,
      healthData: makeHealthyHealthResponse(),
      clientDataStale: false,
      recommendedActions,
    });

    expect(recommendedActions.length).toBeGreaterThan(0);
    expect(checks.find((check) => check.id === "d1-writes")?.state).toBe("blocked");
    expect(checks.find((check) => check.id === "reserve-lane")?.state).toBe("blocked");
  });

  it("exposes sanitized section and operational failure details", () => {
    const sectionFailure = makeSectionLoaderFailureStatusResponse();
    const operationalFailure = makeOperationalDependencyFailureStatusResponse();

    expect(sectionFailure.sectionErrors.dependencyHealth).toEqual({
      code: "fixture_dependencyHealth_query_failed",
      message: "Fixture section loader failed without exposing production data.",
    });
    expect(operationalFailure.dependencyHealth?.summary).toMatchObject({ stale: 1, rootCauseGroupCount: 1 });
    expect(operationalFailure.providerCircuitHealth?.openProviders[0]?.providerId).toBe("fixture-provider-a");
    expect(operationalFailure.canaries?.checks["fixture-publication-check"]?.status).toBe("error");
  });

  it("provides long Comms timestamps and a complete per-alert delivery matrix", () => {
    const data = makeLongCommsStatusResponse();
    const dispatch = data.crons["dispatch-telegram-alerts"]?.lastRun;
    const perAlertType = dispatch?.metadata?.perAlertType as Record<string, unknown> | undefined;

    expect(data.telegramBot?.lifecycleSnapshot?.snapshotAt).toBeLessThan(data.timestamp - 10_000_000);
    expect(data.telegramBot?.retryErrorClassCounts).toHaveProperty("gateway_timeout_after_fixture_retry_budget");
    expect(Object.keys(perAlertType ?? {})).toEqual([...TELEGRAM_ALERT_TYPES]);
    expect(dispatch?.durationMs).toBe(98_765);
  });
});

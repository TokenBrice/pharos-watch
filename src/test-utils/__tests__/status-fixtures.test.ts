import { describe, expect, it } from "vitest";
import { StatusResponseSchema } from "@shared/types/status";
import { buildStatusDashboardData, type DashboardIssueGroups } from "@/lib/status-dashboard-model";
import {
  makeActionRecommendedStatusResponse,
  makeCurrentStatusDashboardInputs,
  makeDegradedPublicHealthResponse,
  makeDegradedPublicImpactStatusResponse,
  makeFullyHealthyCurrentStatusResponse,
  makeHealthyHealthResponse,
  makeMaintenanceDebtStatusResponse,
  makePublicationFailureStatusResponse,
  makeRecoveryHoldStatusResponse,
} from "@/test-utils/status-fixtures";

/** Issue identity across every kind, in the dashboard's own kind order. */
function issueIdentities(groups: DashboardIssueGroups) {
  return [...groups.impacting, ...groups.warnings, ...groups.maintenance, ...groups.watches].map(
    ({ code, kind, publicImpacting }) => [code, kind, publicImpacting],
  );
}

describe("status review fixtures", () => {
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
        issues: issueIdentities(dashboard.issueGroups),
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
    expect(issueIdentities(changedDashboard.issueGroups)).toEqual([["cache_ratio_unknown", "warning", false]]);

    const publicationWithoutFailureNotice = structuredClone(publicationQueryUnavailable);
    delete publicationWithoutFailureNotice.publicationHealth?.failedSurfaces;
    const noticeIds = buildStatusDashboardData(
      makeCurrentStatusDashboardInputs({ data: publicationWithoutFailureNotice, healthData: makeHealthyHealthResponse() }),
    ).notices.map((notice) => notice.id);
    expect(noticeIds).not.toContain("publication-failed-yield-rankings-publication_surface_query_failed-0");
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

    expect(actionRecommended.recommendedActions.map((item) => item.action.path)).toContain("/api/remediate-blacklist-amount-gaps");
    expect(actionRecommended.decision.nextStep).toBe("manual-action");
  });

});

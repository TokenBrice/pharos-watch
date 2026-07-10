// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeHealthyHealthResponse, makeHealthyStatusResponse } from "@/test-utils/status-fixtures";
import { buildStatusDashboardData } from "@/lib/status-dashboard-model";

vi.mock("@/components/status/freshness-indicator", () => ({
  FreshnessIndicator: () => <span>freshness</span>,
}));

vi.mock("@/components/status/refresh-countdown", () => ({
  RefreshControl: () => <button type="button">Refresh</button>,
}));

vi.mock("@/components/status/recommended-action-strip", () => ({
  RecommendedActionStrip: () => <div>recommendations</div>,
}));

vi.mock("@/components/status/system-diagnostics", () => ({
  SystemDiagnostics: () => <div>diagnostics</div>,
}));

import { TriageSummary } from "../triage-summary";

afterEach(cleanup);

describe("TriageSummary workspace links", () => {
  it("routes attention lanes to their canonical workspace instead of legacy hashes", () => {
    const data = makeHealthyStatusResponse();
    const healthData = makeHealthyHealthResponse();
    const model = buildStatusDashboardData({
      data,
      healthData,
      probes: [
        { path: "/api/health", status: 200, latencyMs: 20 },
        { path: "/api/status", status: 200, latencyMs: 30 },
      ],
      probeLabel: "Critical browser probes",
      querySyncs: {
        statusUpdatedAt: 1_700_000_000_000,
        healthUpdatedAt: 1_700_000_000_000,
        probesUpdatedAt: 1_700_000_000_000,
        historyUpdatedAt: 0,
        requestSourceUpdatedAt: 0,
      },
      nowMs: 1_700_000_000_000,
      healthError: null,
      probesError: null,
      historyError: null,
      requestSourceError: null,
      historyTransitions: undefined,
    });
    const pipelineSection = model.sections.find((section) => section.id === "pipeline");
    if (!pipelineSection) throw new Error("Pipeline section fixture missing");

    render(
      <TriageSummary
        data={data}
        healthData={healthData}
        overallTone={model.overallTone}
        statusHoldingAge={model.statusHoldingAge}
        issueGroups={model.issueGroups}
        evidence={model.evidence}
        decision={model.decision}
        latestTransition={model.latestTransition}
        attentionSections={[pipelineSection]}
        recommendedActions={[]}
        isDiagnosticsOpen={false}
        setIsDiagnosticsOpen={vi.fn()}
        browserProbeSummary={model.browserProbeSummary}
        probeCoverageLabel="Critical Browser Probes"
        querySyncs={model.querySyncs}
        freshnessFloorMs={model.freshnessFloorMs}
        clientDataStale={model.clientDataStale}
        lastUpdated={1_700_000_000_000}
        handleRefresh={vi.fn()}
        showSignOut={false}
      />,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Triage" }).tagName).toBe("H1");
    expect(
      screen.getByRole("heading", { level: 1, name: "Triage" }).closest("section")?.getAttribute("aria-labelledby"),
    ).toBe("triage-title");
    const overviewHeading = screen.getByRole("heading", { level: 2, name: "Operational overview" });
    const issuesHeading = screen.getByRole("heading", { level: 3, name: "Current issues" });
    expect(overviewHeading.className).toContain("sr-only");
    expect(overviewHeading.compareDocumentPosition(issuesHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("diagnostics")).toBeNull();
    expect(screen.getByText("State machine, probe, and discrepancy diagnostics").className).toContain("min-h-11");
    expect(screen.getByRole("link", { name: /pipeline health/i }).getAttribute("href")).toBe("/admin/pipeline/");
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });
});

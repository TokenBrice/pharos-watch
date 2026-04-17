// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
});

vi.mock("@/components/status/status-facts", () => ({
  StatusFacts: ({ summary }: { summary: { worstCacheRatio: number } }) => (
    <div data-testid="status-facts">worst-cache:{summary.worstCacheRatio}</div>
  ),
}));

vi.mock("@/components/status/system-diagnostics", () => ({
  SystemDiagnostics: ({ error }: { error?: { code: string; message: string } | null }) => (
    <div data-testid="system-diagnostics">{error ? error.message : "ok"}</div>
  ),
}));

import { OverviewSection } from "@/app/admin/sections/overview-section";
import { getStatusTone, type DashboardQuerySync } from "@/lib/status-dashboard-model";
import { degraded, makeHealthyStatusResponse } from "@/app/admin/__tests__/fixtures/status-response";

function makeQuerySyncs(): DashboardQuerySync[] {
  return [
    { key: "status", label: "Status API", updatedAtMs: 1_700_000_000_000, updatedAtSec: 1_700_000_000, ageSec: 0, stale: false },
    { key: "health", label: "Public health", updatedAtMs: 1_700_000_000_000, updatedAtSec: 1_700_000_000, ageSec: 0, stale: false },
    { key: "probes", label: "Browser probes", updatedAtMs: 1_700_000_000_000, updatedAtSec: 1_700_000_000, ageSec: 0, stale: false },
    { key: "history", label: "Status history", updatedAtMs: 1_700_000_000_000, updatedAtSec: 1_700_000_000, ageSec: 0, stale: false },
    { key: "requestSource", label: "API attribution", updatedAtMs: 1_700_000_000_000, updatedAtSec: 1_700_000_000, ageSec: 0, stale: false },
  ];
}

const HEALTHY_TONE = getStatusTone("healthy");
const DEGRADED_TONE = getStatusTone("degraded");

describe("OverviewSection", () => {
  it("renders the healthy overall label, raw status, and confidence", () => {
    const data = makeHealthyStatusResponse();

    render(
      <OverviewSection
        data={data}
        handleRefresh={vi.fn()}
        overallTone={HEALTHY_TONE}
        isDiagnosticsOpen={false}
        setIsDiagnosticsOpen={vi.fn()}
        browserProbeSummary={null}
        querySyncs={makeQuerySyncs()}
        clientDataAgeSec={5}
        clientDataStale={false}
      />,
    );

    expect(screen.getByText("Current incident picture")).toBeTruthy();
    // "Overall" badge reflects the supplied tone label
    expect(screen.getByText("Healthy")).toBeTruthy();
    // "Raw" badge reflects data.rawOverallStatus
    expect(screen.getByText("healthy")).toBeTruthy();
    // "Confidence" badge
    expect(screen.getByText("100.0%")).toBeTruthy();
  });

  it("surfaces the client-stale badge when clientDataStale is true", () => {
    const data = degraded(makeHealthyStatusResponse(), {
      rawOverallStatus: "degraded",
      overallStatus: "degraded",
      confidence: 0.7,
      sectionErrors: {
        statusState: { code: "persist-failed", message: "status persistence degraded" },
      },
    });

    render(
      <OverviewSection
        data={data}
        handleRefresh={vi.fn()}
        overallTone={DEGRADED_TONE}
        isDiagnosticsOpen={false}
        setIsDiagnosticsOpen={vi.fn()}
        browserProbeSummary={null}
        querySyncs={makeQuerySyncs()}
        clientDataAgeSec={42}
        clientDataStale={true}
      />,
    );

    expect(screen.getByText("Degraded")).toBeTruthy();
    expect(screen.getByText("degraded")).toBeTruthy();
    expect(screen.getByText("70.0%")).toBeTruthy();

    const syncFloor = screen.getByText("Sync Floor").parentElement;
    expect(syncFloor?.textContent).toContain("42s");
    expect(syncFloor?.className).toContain("amber");
  });

  it("renders the diagnostics details open when isDiagnosticsOpen is true", () => {
    const data = makeHealthyStatusResponse();

    render(
      <OverviewSection
        data={data}
        handleRefresh={vi.fn()}
        overallTone={HEALTHY_TONE}
        isDiagnosticsOpen={true}
        setIsDiagnosticsOpen={vi.fn()}
        browserProbeSummary={null}
        querySyncs={makeQuerySyncs()}
        clientDataAgeSec={5}
        clientDataStale={false}
      />,
    );

    const details = screen
      .getByText("State machine, probe, and discrepancy diagnostics")
      .closest("details");
    expect(details).toBeTruthy();
    expect(details?.hasAttribute("open")).toBe(true);
  });
});

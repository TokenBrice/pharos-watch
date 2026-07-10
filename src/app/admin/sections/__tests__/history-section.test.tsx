// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StatusTransition } from "@shared/types";
import { DEFAULT_INCIDENT_HISTORY_QUERY } from "@/lib/incident-history-view-model";
import { makeHealthyStatusResponse } from "@/test-utils/status-fixtures";
import { HistorySection } from "../history-section";

afterEach(cleanup);

const transition: StatusTransition = {
  id: 7,
  scope: "global",
  from: "healthy",
  to: "degraded",
  rawStatus: "degraded",
  transitionType: "degrade",
  reason: "Fixture degradation",
  confidence: 0.9,
  causes: [
    {
      code: "db_unhealthy",
      layer: "availability",
      severity: "critical",
      message: "Database unavailable.",
    },
  ],
  at: 1_700_000_100,
};

function baseProps() {
  const status = makeHealthyStatusResponse();
  return {
    allTransitions: [transition],
    latestTransition: transition,
    reserveComposition: status.reserveComposition,
    releaseMetadataState: {
      status: "ready" as const,
      metadata: {
        commit: "abcdef1234567890",
        runId: "run-42",
        runAttempt: "1",
        createdAt: "2023-11-14T22:15:00.000Z",
        createdAtSec: 1_700_000_100,
      },
    },
    workerVersionEvidence: {
      status: "observed" as const,
      version: "worker-v2",
      observedAt: 1_700_000_200,
      sourceCount: 2,
      sources: ["producer:prices", "attempt:digest"],
    },
    adminActionLog: {
      entries: [],
      error: null,
      isLoading: false,
      isFetching: false,
      onRetry: vi.fn(),
    },
    credentialAudit: {
      entries: [],
      error: null,
      isLoading: false,
      isFetching: false,
      onRetry: vi.fn(),
    },
    nowSeconds: 1_700_001_000,
    transitionsLast24h: 4,
    historyWindow: "24h" as const,
    historyFilters: DEFAULT_INCIDENT_HISTORY_QUERY,
    setHistoryWindow: vi.fn(),
    setHistoryFilters: vi.fn(),
    historyLoading: false,
    historyEvidence: {
      source: "history" as const,
      state: "ready" as const,
      message: "Showing persisted transitions for the selected history window.",
    },
  };
}

describe("HistorySection", () => {
  it("separates Pages release correlation from Worker runtime observations", () => {
    render(<HistorySection {...baseProps()} />);

    const pageHeading = screen.getByRole("heading", { level: 1, name: "Incident History" });
    expect(pageHeading).toBeTruthy();
    expect(pageHeading.className).not.toContain("pharos-display");
    expect(screen.getByRole("heading", { name: "Pages deployment" })).toBeTruthy();
    expect(screen.getByText(/First degradation after release/i)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Worker deployment" })).toBeTruthy();
    expect(screen.getByText("worker-v2")).toBeTruthy();
    expect(screen.getAllByText(/runtime observation/i).length).toBeGreaterThan(0);
    expect(screen.getByText("Deployment correlation Unknown")).toBeTruthy();
    expect(screen.getByText(/No transition is attributed to this version/i)).toBeTruthy();
    expect(screen.getByText("Flapping")).toBeTruthy();
    expect(screen.getAllByText("4").length).toBeGreaterThan(0);
  });

  it("renders Worker deployment and observation fields as unavailable instead of synthesizing them", () => {
    const props = baseProps();
    render(
      <HistorySection
        {...props}
        workerVersionEvidence={{
          status: "unavailable",
          version: null,
          observedAt: null,
          sourceCount: 0,
          sources: [],
        }}
      />,
    );

    expect(screen.getByText("Runtime observation unavailable")).toBeTruthy();
    expect(screen.getByText(/Deploy time, deployment ID, and deploy commit are Unknown/i)).toBeTruthy();
  });

  it("keeps Pages correlation Unknown when its release timestamp is unavailable", () => {
    const props = baseProps();
    render(
      <HistorySection
        {...props}
        releaseMetadataState={{
          status: "ready",
          metadata: { ...props.releaseMetadataState.metadata!, createdAt: null, createdAtSec: null },
        }}
      />,
    );

    expect(screen.getByText(/Pages transition correlation is Unknown/i)).toBeTruthy();
  });

  it("labels a failed history query as partial fallback and avoids negative deployment conclusions", () => {
    const props = baseProps();
    render(
      <HistorySection
        {...props}
        allTransitions={[]}
        latestTransition={null}
        historyEvidence={{
          source: "status-fallback",
          state: "error",
          message: "History query failed; showing recent status transitions only.",
        }}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain("History query failed");
    expect(screen.getByText("Recent fallback")).toBeTruthy();
    expect(screen.getByText(/selected history window is unavailable/i)).toBeTruthy();
    expect(screen.getByText(/correlation is Unknown because only recent status fallback/i)).toBeTruthy();
    expect(screen.queryByText(/No degradation transition appears/i)).toBeNull();
  });
});

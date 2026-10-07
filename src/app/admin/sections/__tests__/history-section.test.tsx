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
    workerVersions: {
      public: { scriptName: "stablecoin-api", workerVersion: "public-v2", activatedAt: 1_700_000_100 },
      heavy: { scriptName: "stablecoin-heavy", workerVersion: "heavy-v3", activatedAt: 1_700_000_200 },
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
      completeness: "complete" as const,
      message: "Showing the complete persisted transition window.",
    },
  };
}

describe("HistorySection", () => {
  it("renders both verified Worker activations separately from Pages correlation", () => {
    render(<HistorySection {...baseProps()} />);

    const pageHeading = screen.getByRole("heading", { level: 1, name: "Incident History" });
    expect(pageHeading).toBeTruthy();
    expect(pageHeading.className).not.toContain("pharos-display");
    expect(screen.getByRole("heading", { name: "Pages deployment" })).toBeTruthy();
    expect(screen.getByText(/First degradation after release/i)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Worker deployments" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Public Worker" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Heavy Worker" })).toBeTruthy();
    expect(screen.getByText("stablecoin-api")).toBeTruthy();
    expect(screen.getByText("stablecoin-heavy")).toBeTruthy();
    expect(screen.getByText("public-v2")).toBeTruthy();
    expect(screen.getByText("heavy-v3")).toBeTruthy();
    expect(screen.getAllByText("Activated at")).toHaveLength(2);
    expect(screen.getByText(/Activation does not attribute a transition/i)).toBeTruthy();
    expect(screen.getByText("Flapping")).toBeTruthy();
    expect(screen.getAllByText("4").length).toBeGreaterThan(0);
  });

  it.each(["public", "heavy"] as const)("keeps missing %s evidence unavailable without hiding the other role", (role) => {
    const props = baseProps();
    render(<HistorySection {...props} workerVersions={{ ...props.workerVersions, [role]: null }} />);
    expect(screen.getByText(/Verified activation unavailable/i)).toBeTruthy();
    expect(screen.getByText(role === "public" ? "heavy-v3" : "public-v2")).toBeTruthy();
    expect(screen.queryByText(role === "public" ? "public-v2" : "heavy-v3")).toBeNull();
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
          completeness: "unknown",
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

  it("labels row-limited history as bounded and keeps negative deployment correlation unknown", () => {
    const props = baseProps();
    const boundedTransitions: StatusTransition[] = [{
      ...transition,
      from: "degraded",
      to: "healthy",
      rawStatus: "healthy",
      transitionType: "recover",
    }];
    render(
      <HistorySection
        {...props}
        allTransitions={boundedTransitions}
        latestTransition={boundedTransitions[0] ?? null}
        historyEvidence={{
          source: "history",
          state: "ready",
          completeness: "truncated",
          message: "The history result reached its row limit; older transitions are omitted.",
        }}
      />,
    );

    expect(screen.getByText("Bounded history")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("row limit");
    expect(screen.getByText(/correlation is Unknown because the history result reached its row limit/i)).toBeTruthy();
    expect(screen.queryByText(/No degradation transition appears/i)).toBeNull();
  });

  it("does not infer complete coverage when the API cannot determine hasMore", () => {
    const props = baseProps();
    render(
      <HistorySection
        {...props}
        allTransitions={[]}
        latestTransition={null}
        historyEvidence={{
          source: "history",
          state: "ready",
          completeness: "unknown",
          message: "History loaded, but completeness could not be determined.",
        }}
      />,
    );

    expect(screen.getByText("Coverage unknown")).toBeTruthy();
    expect(screen.getByText(/complete coverage of the selected history window is unproven/i)).toBeTruthy();
    expect(screen.queryByText(/No degradation transition appears/i)).toBeNull();
  });
});

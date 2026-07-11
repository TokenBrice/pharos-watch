// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildStatusDashboardData } from "@/lib/status-dashboard-model";
import { makeLargeApiKeyInventory } from "@/test-utils/api-key-fixtures";
import {
  STATUS_FIXTURE_NOW_MS,
  makeHealthyHealthResponse,
  makeHealthyStatusResponse,
} from "@/test-utils/status-fixtures";

const { useCriticalOpsModelMock, useApiKeysMock, useApiKeyAuditLogMock } = vi.hoisted(() => ({
  useCriticalOpsModelMock: vi.fn(),
  useApiKeysMock: vi.fn(),
  useApiKeyAuditLogMock: vi.fn(),
}));

vi.mock("@/hooks/use-critical-ops-model", () => ({
  useCriticalOpsModel: useCriticalOpsModelMock,
}));

vi.mock("@/hooks/use-api-keys", () => ({
  useApiKeys: useApiKeysMock,
}));

vi.mock("@/hooks/use-api-key-audit-log", () => ({
  useApiKeyAuditLog: useApiKeyAuditLogMock,
}));

import TriageClient from "../client";

function makeCriticalOpsResult() {
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
      statusUpdatedAt: STATUS_FIXTURE_NOW_MS,
      healthUpdatedAt: STATUS_FIXTURE_NOW_MS,
      probesUpdatedAt: STATUS_FIXTURE_NOW_MS,
      historyUpdatedAt: 0,
      requestSourceUpdatedAt: 0,
    },
    nowMs: STATUS_FIXTURE_NOW_MS,
    healthError: null,
    probesError: null,
    historyError: null,
    requestSourceError: null,
    historyTransitions: undefined,
  });

  return {
    data,
    handleRefresh: vi.fn(),
    healthData,
    initialLoadError: null,
    isLoading: false,
    lastUpdated: STATUS_FIXTURE_NOW_MS,
    model,
  };
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(STATUS_FIXTURE_NOW_MS);
  useCriticalOpsModelMock.mockReturnValue(makeCriticalOpsResult());
  // The credential summary must stay inside the Triage budgets even with a
  // large inventory behind it: it renders counts, never rows.
  useApiKeysMock.mockReturnValue({
    data: makeLargeApiKeyInventory(75),
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  useApiKeyAuditLogMock.mockReturnValue({ data: { entries: [] }, isLoading: false, isError: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("default Triage workspace performance budgets", () => {
  it("stays under 60 interactive main-area controls and 100 body rows on the initial healthy render", () => {
    const { container } = render(<TriageClient />);

    const interactiveControls = container.querySelectorAll(
      'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])',
    );
    expect(interactiveControls.length).toBeGreaterThan(0);
    expect(interactiveControls.length).toBeLessThan(60);

    const bodyRows = container.querySelectorAll("tbody tr");
    expect(bodyRows.length).toBeLessThan(100);
  });

  it("keeps the diagnostics disclosure closed and unmounted on a healthy initial render", () => {
    const { container } = render(<TriageClient />);

    const diagnostics = screen
      .getByText("State machine, probe, and discrepancy diagnostics")
      .closest("details") as HTMLDetailsElement;
    expect(diagnostics.open).toBe(false);
    // Closed disclosure must not keep its deep diagnostics subtree mounted.
    expect(screen.queryByText("State Eval")).toBeNull();
    expect(container.querySelectorAll("details > *:not(summary)").length).toBe(0);
  });
});

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReliabilityEndpointsPanel } from "../reliability-endpoints-panel";
import { buildReliabilityWorkspaceModel } from "@/lib/reliability-workspace-model";
import { makeHealthyHealthResponse, makeHealthyStatusResponse } from "@/test-utils/status-fixtures";

const writeText = vi.fn();

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  writeText.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ReliabilityEndpointsPanel", () => {
  it("explains both probe planes, prioritizes failures, collapses healthy rows, and copies safe diagnostics", async () => {
    const data = makeHealthyStatusResponse();
    const model = buildReliabilityWorkspaceModel({
      data,
      healthData: makeHealthyHealthResponse(),
      healthLoading: false,
      probes: [
        {
          path: "/api/status?token=secret",
          status: 503,
          latencyMs: 500,
          semanticStatus: "stale",
          error: "Bearer secret",
        },
        { path: "/api/health", status: 200, latencyMs: 20, semanticStatus: "healthy" },
      ],
      probesLoading: false,
      browserProbeSummary: {
        sampleCount: 2,
        passCount: 1,
        failCount: 1,
        degradedCount: 0,
        staleCount: 1,
        p95LatencyMs: 500,
        status: "stale",
        updatedAt: data.timestamp,
      },
      requestSourceStats: null,
      requestSourceLoading: true,
    });

    render(<ReliabilityEndpointsPanel model={model.endpoints} />);

    expect(screen.getByText("Worker-origin self-check")).toBeTruthy();
    expect(screen.getByText("Browser-origin endpoint probes")).toBeTruthy();
    expect(screen.getByText(/Runs inside the Worker/)).toBeTruthy();
    expect(screen.getByText(/does not identify endpoint rows/)).toBeTruthy();
    expect(screen.getByText(/authenticated operator session/)).toBeTruthy();

    const failures = screen.getByRole("table", { name: "Failed and degraded endpoint probes" });
    expect(within(failures).getByText("/api/status")).toBeTruthy();
    expect(screen.queryByText(/token=secret/)).toBeNull();
    const healthyDetails = screen.getByText("1 healthy endpoint").closest("details");
    expect(healthyDetails?.hasAttribute("open")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Copy secret-free reliability diagnostics" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = String(writeText.mock.calls[0]?.[0]);
    expect(copied).toContain('"path": "/api/status"');
    expect(copied).not.toContain("Bearer secret");
    expect(copied).not.toContain("token=secret");
  });
});

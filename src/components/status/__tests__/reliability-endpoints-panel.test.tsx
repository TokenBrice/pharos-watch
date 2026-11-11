// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EndpointProbeResult } from "@shared/types/status/public-health";
import { ReliabilityEndpointsPanel } from "../reliability-endpoints-panel";
import { ReliabilityCopyDiagnostics } from "../reliability-copy-diagnostics";
import { buildReliabilityWorkspaceModel } from "@/lib/reliability-workspace-issue-builder";
import { makeHealthyHealthResponse, makeHealthyStatusResponse } from "@/test-utils/status-fixtures";

const writeText = vi.fn();
const previousExecCommand = document.execCommand;

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  writeText.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(document, "execCommand", { configurable: true, value: previousExecCommand });
});

describe("ReliabilityEndpointsPanel", () => {
  it.each(["completed", "pending", "fallback", "failed", "return"])("keeps clipboard and refreshed copy feedback consistent: %s", async (mode) => {
    let clipboard = "";
    let finish = () => {};
    const pending = mode === "pending" || mode === "fallback";
    writeText.mockImplementation(async (value: string) => { clipboard = value; });
    const deferredCopy = (value: string) => new Promise<void>((resolve, reject) => {
      finish = () => {
        if (mode === "fallback" || mode === "failed") reject(new Error("Clipboard denied"));
        else { clipboard = value; resolve(); }
      };
    });
    if (mode !== "return") writeText.mockImplementationOnce(deferredCopy);
    const legacyCopy = vi.fn(() => {
      if (mode === "failed") return false;
      clipboard = (document.activeElement as HTMLTextAreaElement).value;
      return true;
    });
    Object.defineProperty(document, "execCommand", { configurable: true, value: legacyCopy });
    const { rerender } = render(<ReliabilityCopyDiagnostics text="previous diagnostics" />);
    const copy = screen.getByRole("button", { name: "Copy secret-free reliability diagnostics" });
    copy.focus();
    fireEvent.click(copy);
    expect(document.activeElement).toBe(copy);
    expect(copy.matches(":enabled")).toBe(true);
    if (!pending) {
      await act(async () => finish());
      if (mode === "failed") expect(screen.getByText("Copy failed").getAttribute("aria-live")).toBe("polite");
      else expect(copy.textContent).toBe("Copied");
    }
    rerender(<ReliabilityCopyDiagnostics text="refreshed diagnostics" />);
    expect(copy.textContent).toBe("Copy diagnostics");
    if (mode === "return") writeText.mockImplementationOnce(deferredCopy);
    fireEvent.click(copy);
    if (mode === "return") {
      rerender(<ReliabilityCopyDiagnostics text="previous diagnostics" />);
      await act(async () => finish());
      expect({ clipboard, feedback: copy.textContent }).toEqual({ clipboard: "refreshed diagnostics", feedback: "Copy diagnostics" });
      return;
    }
    if (pending) {
      await act(async () => finish());
      expect({ clipboard, feedback: copy.textContent }).toEqual({ clipboard: "previous diagnostics", feedback: "Copy diagnostics" });
      if (mode === "fallback") expect(legacyCopy).toHaveBeenCalledWith("copy");
      fireEvent.click(copy);
    }
    await waitFor(() => expect(copy.textContent).toBe("Copied"));
    expect(copy.textContent).toBe("Copied");
    expect(clipboard).toBe("refreshed diagnostics");
    expect(writeText).toHaveBeenLastCalledWith("refreshed diagnostics");
  });

  it("explains both probe planes, prioritizes failures, collapses healthy rows, and copies safe diagnostics", async () => {
    const data = makeHealthyStatusResponse();
    data.probe = { ...data.probe, sampleCount: 17, passCount: 14, failCount: 0, status: "degraded" };
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
    expect(screen.getByText("14 transport passes · 0 transport failures · 17 total samples · degraded")).toBeTruthy();
    expect(screen.getByText("Browser-origin endpoint probes")).toBeTruthy();
    expect(screen.getByText(/Runs inside the Worker/)).toBeTruthy();
    expect(screen.getByText(/does not identify endpoint rows/)).toBeTruthy();
    expect(screen.getByText(/authenticated operator session/)).toBeTruthy();

    const failures = screen.getByRole("table", { name: "Failed and degraded endpoint probes" });
    expect(within(failures).getByText("/api/status")).toBeTruthy();
    expect(screen.queryByText(/token=secret/)).toBeNull();
    const healthyDetails = screen.getByText("1 healthy endpoint").closest("details");
    expect(healthyDetails?.hasAttribute("open")).toBe(false);
    expect(screen.getByText("1 healthy endpoint").className).toContain("min-h-11");
    // Closed healthy detail keeps its table subtree unmounted until opened.
    expect(screen.queryByRole("table", { name: "Healthy endpoint probes" })).toBeNull();
    fireEvent.click(screen.getByText("1 healthy endpoint"));
    expect(await screen.findByRole("table", { name: "Healthy endpoint probes" })).toBeTruthy();
    fireEvent.click(screen.getByText("1 healthy endpoint"));
    await waitFor(() => expect(screen.queryByRole("table", { name: "Healthy endpoint probes" })).toBeNull());

    const copy = screen.getByRole("button", { name: "Copy secret-free reliability diagnostics" });
    expect(copy.className).toContain("min-h-11");
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = String(writeText.mock.calls[0]?.[0]);
    expect(copied).toContain('"path": "/api/status"');
    expect(copied).not.toContain("Bearer secret");
    expect(copied).not.toContain("token=secret");
  });

  it("distinguishes absent browser-plane evidence from a successful all-clear probe", () => {
    const data = makeHealthyStatusResponse();
    const inputs = {
      data,
      healthData: makeHealthyHealthResponse(),
      healthLoading: false,
      probes: [] as EndpointProbeResult[],
      probesLoading: false,
      requestSourceStats: null,
      requestSourceLoading: false,
    };

    const absent = render(
      <ReliabilityEndpointsPanel
        model={buildReliabilityWorkspaceModel({ ...inputs, browserProbeSummary: null }).endpoints}
      />,
    );
    const browserCard = screen.getByRole("region", { name: "Browser-origin endpoint probes" });
    expect(within(browserCard).getByText("Result").nextElementSibling?.textContent).toBe("Unknown");
    expect(screen.getByText("Browser endpoint evidence is Unknown.")).toBeTruthy();
    absent.unmount();

    render(
      <ReliabilityEndpointsPanel
        model={
          buildReliabilityWorkspaceModel({
            ...inputs,
            browserProbeSummary: {
              sampleCount: 2,
              passCount: 2,
              failCount: 0,
              degradedCount: 0,
              staleCount: 0,
              p95LatencyMs: 20,
              status: "healthy",
              updatedAt: data.timestamp,
            },
          }).endpoints
        }
      />,
    );
    const browserPlane = screen.getByRole("region", { name: "Browser-origin endpoint probes" });
    expect(within(browserPlane).getByText("Result").nextElementSibling?.textContent).toContain("2/2 passing");
    expect(screen.getByText("No failed or degraded browser endpoints are active.")).toBeTruthy();
    expect(screen.queryByText("Browser endpoint evidence is Unknown.")).toBeNull();
  });
});

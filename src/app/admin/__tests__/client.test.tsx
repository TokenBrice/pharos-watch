// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHealthyHealthResponse, makeHealthyStatusResponse } from "@/test-utils/status-fixtures";
import { makeCriticalOpsResult } from "./admin-client.test-support";

const {
  useCriticalOpsModelMock,
  useCredentialLifecycleSummaryMock,
  useStatusMock,
  useRequestSourceStatsMock,
  useHealthMock,
  useEndpointProbesMock,
  reliabilitySectionPropsMock,
} = vi.hoisted(() => ({
  useCriticalOpsModelMock: vi.fn(),
  useCredentialLifecycleSummaryMock: vi.fn(),
  useStatusMock: vi.fn(),
  useRequestSourceStatsMock: vi.fn(),
  useHealthMock: vi.fn(),
  useEndpointProbesMock: vi.fn(),
  reliabilitySectionPropsMock: vi.fn(),
}));

vi.mock("@/hooks/use-critical-ops-model", () => ({
  useCriticalOpsModel: useCriticalOpsModelMock,
}));

vi.mock("@/hooks/admin-api-hooks", () => ({
  useCredentialLifecycleSummary: useCredentialLifecycleSummaryMock,
  useStatus: useStatusMock,
  useRequestSourceStats: useRequestSourceStatsMock,
}));
vi.mock("@/hooks/api-hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/api-hooks")>()),
  useHealth: useHealthMock,
}));
vi.mock("@/hooks/use-endpoint-probes", () => ({ useEndpointProbes: useEndpointProbesMock }));
vi.mock("../sections/reliability-section", () => ({
  ReliabilitySection: (props: unknown) => {
    reliabilitySectionPropsMock(props);
    return <div>Reliability section</div>;
  },
}));

vi.mock("../status-dashboard/triage-summary", () => ({
  TriageSummary: ({ probeCoverageLabel }: { probeCoverageLabel: string }) => (
    <div data-testid="triage-summary">{probeCoverageLabel}</div>
  ),
}));

import TriageClient from "../client";
import ReliabilityClient from "../reliability/client";

beforeEach(() => {
  useCriticalOpsModelMock.mockReturnValue(makeCriticalOpsResult());
  useCredentialLifecycleSummaryMock.mockReturnValue({
    data: { generatedAt: 1_700_000_000, totalKeys: 4, active: 4, expiringSoon: 0, expired: 0, nonExpiring: 0, auditAnomalies7d: 0 },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  useStatusMock.mockReturnValue({ data: makeHealthyStatusResponse(), error: null, isLoading: false, refetch: vi.fn() });
  useHealthMock.mockReturnValue({
    data: makeHealthyHealthResponse(),
    error: new Error("health refresh failed"),
    isLoading: false,
    refetch: vi.fn(),
  });
  useEndpointProbesMock.mockReturnValue({
    data: [{ path: "/api/health", status: 200, latencyMs: 20, semanticStatus: "healthy" }],
    dataUpdatedAt: 1_700_000_000_000,
    error: new Error("probe refresh failed"),
    isLoading: false,
    refetch: vi.fn(),
  });
  useRequestSourceStatsMock.mockReturnValue({
    data: null,
    error: new Error("demand failed"),
    isLoading: false,
    refetch: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("admin triage client", () => {

  it("shows an initial status failure instead of mounting triage", () => {
    useCriticalOpsModelMock.mockReturnValue(makeCriticalOpsResult({
      initialLoadError: new Error("status unavailable"),
    }));

    render(<TriageClient />);

    expect(screen.getByText("Status data failed to load")).toBeTruthy();
    expect(screen.getByText("status unavailable")).toBeTruthy();
    expect(screen.queryByTestId("triage-summary")).toBeNull();
  });
});

describe("ReliabilityClient", () => {
  it("owns full probes, health, and demand queries and passes their evidence state to the route section", () => {
    render(<ReliabilityClient />);

    expect(screen.getByText("Reliability section")).toBeTruthy();
    expect(useEndpointProbesMock).toHaveBeenCalledWith({ mode: "full" });
    expect(useHealthMock).toHaveBeenCalledTimes(1);
    expect(useRequestSourceStatsMock).toHaveBeenCalledTimes(1);
    expect(reliabilitySectionPropsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        healthError: "health refresh failed",
        probesError: "probe refresh failed",
        requestSourceError: "demand failed",
        healthLoading: false,
        probesLoading: false,
        requestSourceLoading: false,
      }),
    );
  });
});

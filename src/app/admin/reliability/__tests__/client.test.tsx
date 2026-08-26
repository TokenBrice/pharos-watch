// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHealthyHealthResponse, makeHealthyStatusResponse } from "@/test-utils/status-fixtures";

const { useStatusMock, useHealthMock, useEndpointProbesMock, useRequestSourceStatsMock, sectionProps } = vi.hoisted(
  () => ({
    useStatusMock: vi.fn(),
    useHealthMock: vi.fn(),
    useEndpointProbesMock: vi.fn(),
    useRequestSourceStatsMock: vi.fn(),
    sectionProps: vi.fn(),
  }),
);

vi.mock("@/hooks/admin-api-hooks", () => ({
  useStatus: useStatusMock,
  useRequestSourceStats: useRequestSourceStatsMock,
}));
vi.mock("@/hooks/api-hooks", () => ({ useHealth: useHealthMock }));
vi.mock("@/hooks/use-endpoint-probes", () => ({ useEndpointProbes: useEndpointProbesMock }));
vi.mock("../../sections/reliability-section", () => ({
  ReliabilitySection: (props: unknown) => {
    sectionProps(props);
    return <div>Reliability section</div>;
  },
}));

import ReliabilityClient from "../client";

beforeEach(() => {
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

describe("ReliabilityClient", () => {
  it("owns full probes, health, and demand queries and passes their evidence state to the route section", () => {
    render(<ReliabilityClient />);

    expect(screen.getByText("Reliability section")).toBeTruthy();
    expect(useEndpointProbesMock).toHaveBeenCalledWith({ mode: "full" });
    expect(useHealthMock).toHaveBeenCalledTimes(1);
    expect(useRequestSourceStatsMock).toHaveBeenCalledTimes(1);
    expect(sectionProps).toHaveBeenCalledWith(
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

// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHealthyHealthResponse, makeHealthyStatusResponse } from "@/test-utils/status-fixtures";

const { useStatusMock, useHealthMock, useEndpointProbesMock } = vi.hoisted(() => ({
  useStatusMock: vi.fn(),
  useHealthMock: vi.fn(),
  useEndpointProbesMock: vi.fn(),
}));

vi.mock("@/hooks/use-status", () => ({ useStatus: useStatusMock }));
vi.mock("@/hooks/api-hooks", () => ({ useHealth: useHealthMock }));
vi.mock("@/hooks/use-endpoint-probes", () => ({ useEndpointProbes: useEndpointProbesMock }));

import { useCriticalOpsModel } from "../use-critical-ops-model";

const NOW = 1_700_000_000_000;

function queryResult(data: unknown) {
  return {
    data,
    dataUpdatedAt: NOW,
    error: null,
    errorUpdatedAt: 0,
    isLoading: false,
    refetch: vi.fn(),
  };
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  useStatusMock.mockReturnValue(queryResult(makeHealthyStatusResponse()));
  useHealthMock.mockReturnValue(queryResult(makeHealthyHealthResponse()));
  useEndpointProbesMock.mockReturnValue(
    queryResult([
      { path: "/api/health", status: 200, latencyMs: 20, semanticStatus: "healthy" },
      { path: "/api/status", status: 200, latencyMs: 30, semanticStatus: "healthy" },
    ]),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("useCriticalOpsModel", () => {
  it("requests only critical browser probes and labels that evidence as reduced coverage", () => {
    const { result } = renderHook(() => useCriticalOpsModel());

    expect(useEndpointProbesMock).toHaveBeenCalledWith({ mode: "critical" });
    expect(result.current.model?.evidence).toMatchObject({
      state: "current",
      requiredQueryCount: 3,
    });
    expect(result.current.model?.querySyncs.find((sync) => sync.key === "probes")?.label).toBe(
      "Critical browser probes",
    );
  });
});

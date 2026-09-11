// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeCriticalOpsResult } from "./admin-client.test-support";

const {
  useCriticalOpsModelMock,
  useStatusHistoryMock,
  useRequestSourceStatsMock,
  useReleaseMetadataMock,
  useCredentialLifecycleSummaryMock,
} = vi.hoisted(() => ({
  useCriticalOpsModelMock: vi.fn(),
  useStatusHistoryMock: vi.fn(),
  useRequestSourceStatsMock: vi.fn(),
  useReleaseMetadataMock: vi.fn(),
  useCredentialLifecycleSummaryMock: vi.fn(),
}));

vi.mock("@/hooks/use-critical-ops-model", () => ({
  useCriticalOpsModel: useCriticalOpsModelMock,
}));

vi.mock("@/hooks/admin-api-hooks", () => ({
  useCredentialLifecycleSummary: useCredentialLifecycleSummaryMock,
  useStatusHistory: useStatusHistoryMock,
  useRequestSourceStats: useRequestSourceStatsMock,
}));

vi.mock("@/hooks/use-release-metadata", () => ({
  useReleaseMetadata: useReleaseMetadataMock,
}));

vi.mock("../status-dashboard/triage-summary", () => ({
  TriageSummary: ({ probeCoverageLabel }: { probeCoverageLabel: string }) => (
    <div data-testid="triage-summary">{probeCoverageLabel}</div>
  ),
}));

import TriageClient from "../client";


beforeEach(() => {
  useCriticalOpsModelMock.mockReturnValue(makeCriticalOpsResult());
  useCredentialLifecycleSummaryMock.mockReturnValue({
    data: { generatedAt: 1_700_000_000, totalKeys: 4, active: 4, expiringSoon: 0, expired: 0, nonExpiring: 0, auditAnomalies7d: 0 },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("admin triage client", () => {
  it("mounts only critical triage evidence and labels its reduced probe coverage", () => {
    render(<TriageClient />);

    expect(screen.getByTestId("triage-summary").textContent).toBe("Critical Browser Probes");
    expect(useCriticalOpsModelMock).toHaveBeenCalled();
    expect(useStatusHistoryMock).not.toHaveBeenCalled();
    expect(useRequestSourceStatsMock).not.toHaveBeenCalled();
    expect(useReleaseMetadataMock).not.toHaveBeenCalled();
  });

  it("summarizes credential lifecycle counts and routes lifecycle work to API Management", () => {
    render(<TriageClient />);

    expect(screen.getByRole("heading", { level: 2, name: "Credentials" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open API Management/ }).getAttribute("href")).toMatch(/^\/admin-api\/?$/);
    // Summary only: the credential inventory table stays on /admin-api/.
    expect(screen.queryByRole("table")).toBeNull();
  });

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

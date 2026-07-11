// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeLargeApiKeyInventory } from "@/test-utils/api-key-fixtures";
import { makeHealthyHealthResponse, makeHealthyStatusResponse } from "@/test-utils/status-fixtures";

const {
  useCriticalOpsModelMock,
  useStatusHistoryMock,
  useRequestSourceStatsMock,
  useReleaseMetadataMock,
  useApiKeysMock,
  useApiKeyAuditLogMock,
} = vi.hoisted(() => ({
  useCriticalOpsModelMock: vi.fn(),
  useStatusHistoryMock: vi.fn(),
  useRequestSourceStatsMock: vi.fn(),
  useReleaseMetadataMock: vi.fn(),
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

vi.mock("@/hooks/use-status-history", () => ({
  useStatusHistory: useStatusHistoryMock,
}));

vi.mock("@/hooks/use-request-source-stats", () => ({
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

const STATUS = makeHealthyStatusResponse();
const HEALTH = makeHealthyHealthResponse();

function makeCriticalModel() {
  return {
    attentionSections: [],
    browserProbeSummary: null,
    clientDataStale: false,
    freshnessFloorMs: 1_700_000_000_000,
    decision: {
      systemState: "healthy",
      systemLabel: "Healthy",
      publicState: "healthy",
      adminState: "healthy",
      evidenceState: "current",
      evidenceLabel: "Current and complete",
      nextStep: "no-action",
      nextStepLabel: "No action",
      summary: "Public service healthy. Evidence current. No immediate action.",
      hasPublicAdminDivergence: false,
    },
    evidence: {
      state: "current",
      label: "Current and complete",
      requiredQueryCount: 3,
      currentQueryCount: 3,
      missingLabels: [],
      staleLabels: [],
      refreshErrorLabels: [],
      oldestRequiredSuccessAtMs: 1_700_000_000_000,
      oldestRequiredAgeSec: 10,
    },
    healthDiffersFromStatus: false,
    issueGroups: { impacting: [], warnings: [], maintenance: [], watches: [] },
    latestTransition: null,
    notices: [],
    overallTone: {
      label: "Healthy",
      badgeClassName: "healthy",
      valueClassName: "healthy",
    },
    querySyncs: [],
    recommendedActions: [],
    statusHoldingAge: 60,
  };
}

beforeEach(() => {
  useCriticalOpsModelMock.mockReturnValue({
    data: STATUS,
    handleRefresh: vi.fn(),
    healthData: HEALTH,
    initialLoadError: null,
    isLoading: false,
    lastUpdated: 1_700_000_000_000,
    model: makeCriticalModel(),
  });
  useApiKeysMock.mockReturnValue({
    data: makeLargeApiKeyInventory(4),
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  useApiKeyAuditLogMock.mockReturnValue({ data: { entries: [] }, isLoading: false, isError: false });
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
    useCriticalOpsModelMock.mockReturnValue({
      data: undefined,
      handleRefresh: vi.fn(),
      healthData: undefined,
      initialLoadError: new Error("status unavailable"),
      isLoading: false,
      lastUpdated: 0,
      model: null,
    });

    render(<TriageClient />);

    expect(screen.getByText("Status data failed to load")).toBeTruthy();
    expect(screen.getByText("status unavailable")).toBeTruthy();
    expect(screen.queryByTestId("triage-summary")).toBeNull();
  });
});

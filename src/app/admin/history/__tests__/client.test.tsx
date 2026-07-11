// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHealthyStatusResponse } from "@/test-utils/status-fixtures";
import { getActiveAdminWorkspace, isAdminWorkspaceActive } from "@/lib/admin-workspaces";

const {
  useStatusMock,
  useStatusHistoryMock,
  useReleaseMetadataMock,
  useAdminActionLogMock,
  useApiKeyAuditLogMock,
  historySectionPropsMock,
} = vi.hoisted(() => ({
  useStatusMock: vi.fn(),
  useStatusHistoryMock: vi.fn(),
  useReleaseMetadataMock: vi.fn(),
  useAdminActionLogMock: vi.fn(),
  useApiKeyAuditLogMock: vi.fn(),
  historySectionPropsMock: vi.fn(),
}));

vi.mock("@/hooks/use-status", () => ({ useStatus: useStatusMock }));
vi.mock("@/hooks/use-status-history", () => ({ useStatusHistory: useStatusHistoryMock }));
vi.mock("@/hooks/use-release-metadata", () => ({ useReleaseMetadata: useReleaseMetadataMock }));
vi.mock("@/hooks/use-admin-action-log", () => ({ useAdminActionLog: useAdminActionLogMock }));
vi.mock("@/hooks/use-api-key-audit-log", () => ({ useApiKeyAuditLog: useApiKeyAuditLogMock }));
vi.mock("../../workspace-status-boundary", () => ({
  WorkspaceStatusBoundary: ({ data, children }: { data: unknown; children: (data: unknown) => ReactNode }) =>
    data ? children(data) : null,
}));
vi.mock("../../sections/history-section", () => ({
  HistorySection: (props: unknown) => {
    historySectionPropsMock(props);
    return <div data-testid="history-section">History section mounted</div>;
  },
}));

import HistoryClient from "../client";

const status = makeHealthyStatusResponse();

beforeEach(() => {
  window.history.replaceState(
    {},
    "",
    "/admin/history/?keep=1&window=7d&severity=critical&surface=system&cause=db_unhealthy&impact=impacting",
  );
  useStatusMock.mockReturnValue({
    data: status,
    error: null,
    isLoading: false,
    refetch: vi.fn().mockResolvedValue(undefined),
  });
  useStatusHistoryMock.mockReturnValue({
    data: { transitions: [], hasMore: false },
    isLoading: false,
    refetch: vi.fn().mockResolvedValue(undefined),
  });
  useReleaseMetadataMock.mockReturnValue({ status: "unavailable", metadata: null });
  useAdminActionLogMock.mockReturnValue({
    data: { entries: [] },
    error: null,
    isLoading: false,
    isFetching: false,
    refetch: vi.fn().mockResolvedValue(undefined),
  });
  useApiKeyAuditLogMock.mockReturnValue({
    data: { entries: [] },
    error: null,
    isLoading: false,
    isFetching: false,
    refetch: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HistoryClient", () => {
  it("hydrates window and filters from the URL and preserves unrelated query state", async () => {
    render(<HistoryClient />);

    await waitFor(() => expect(useStatusHistoryMock).toHaveBeenLastCalledWith("7d"));
    const props = historySectionPropsMock.mock.calls.at(-1)?.[0] as {
      historyWindow: string;
      historyFilters: Record<string, unknown>;
      setHistoryFilters: (patch: Record<string, unknown>) => void;
    };
    expect(props.historyWindow).toBe("7d");
    expect(props.historyFilters).toMatchObject({
      severity: "critical",
      surface: "system",
      causeCode: "db_unhealthy",
      publicImpact: "impacting",
    });

    act(() => props.setHistoryFilters({ severity: "warning" }));
    expect(window.location.search).toContain("keep=1");
    expect(window.location.search).toContain("severity=warning");
    expect(window.location.search).toContain("cause=db_unhealthy");
  });

  it("keeps the routed History workspace reachable and current at the end of the admin sequence", async () => {
    render(<HistoryClient />);
    await waitFor(() => expect(historySectionPropsMock).toHaveBeenCalled());

    expect(getActiveAdminWorkspace(window.location.pathname)?.id).toBe("history");
    expect(isAdminWorkspaceActive("/admin/history/", "history")).toBe(true);
    expect(isAdminWorkspaceActive("/admin/history/", "comms")).toBe(false);
  });

  it("passes unavailable Worker runtime evidence through without manufacturing deployment metadata", async () => {
    render(<HistoryClient />);
    await waitFor(() => expect(historySectionPropsMock).toHaveBeenCalled());

    const props = historySectionPropsMock.mock.calls.at(-1)?.[0] as {
      workerVersionEvidence: Record<string, unknown>;
      transitionsLast24h: number;
    };
    expect(props.workerVersionEvidence).toEqual({
      status: "unavailable",
      version: null,
      observedAt: null,
      sourceCount: 0,
      sources: [],
    });
    expect(props.transitionsLast24h).toBe(status.summary.transitionsLast24h);
  });

  it("owns both operational-history queries and passes source failures independently", async () => {
    useAdminActionLogMock.mockReturnValue({
      data: undefined,
      error: new Error("action log unavailable"),
      isLoading: false,
      isFetching: false,
      refetch: vi.fn().mockResolvedValue(undefined),
    });
    useApiKeyAuditLogMock.mockReturnValue({
      data: { entries: [] },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn().mockResolvedValue(undefined),
    });
    render(<HistoryClient />);
    await waitFor(() => expect(historySectionPropsMock).toHaveBeenCalled());

    expect(useAdminActionLogMock).toHaveBeenCalled();
    expect(useApiKeyAuditLogMock).toHaveBeenCalledWith("global");
    const props = historySectionPropsMock.mock.calls.at(-1)?.[0] as {
      adminActionLog: { error: Error | null };
      credentialAudit: { error: Error | null };
    };
    expect(props.adminActionLog.error?.message).toBe("action log unavailable");
    expect(props.credentialAudit.error).toBeNull();
  });

  it("reports a history query failure and labels status timeline data as fallback", async () => {
    useStatusHistoryMock.mockReturnValue({
      data: undefined,
      error: new Error("history unavailable"),
      isLoading: false,
      refetch: vi.fn().mockResolvedValue(undefined),
    });

    render(<HistoryClient />);
    await waitFor(() => expect(historySectionPropsMock).toHaveBeenCalled());

    const props = historySectionPropsMock.mock.calls.at(-1)?.[0] as {
      allTransitions: unknown[];
      historyEvidence: { source: string; state: string; message: string };
    };
    expect(props.allTransitions).toEqual(status.timeline);
    expect(props.historyEvidence).toMatchObject({ source: "status-fallback", state: "error" });
    expect(props.historyEvidence.message).toContain("history unavailable");
  });

  it("retains cached history while exposing a refresh failure", async () => {
    const retainedTransitions = [{ ...status.timeline[0], id: 999 }].filter(Boolean);
    useStatusHistoryMock.mockReturnValue({
      data: { transitions: retainedTransitions, hasMore: false },
      error: new Error("refresh failed"),
      isLoading: false,
      refetch: vi.fn().mockResolvedValue(undefined),
    });

    render(<HistoryClient />);
    await waitFor(() => expect(historySectionPropsMock).toHaveBeenCalled());

    const props = historySectionPropsMock.mock.calls.at(-1)?.[0] as {
      allTransitions: unknown[];
      historyEvidence: { source: string; state: string; message: string };
    };
    expect(props.allTransitions).toEqual(retainedTransitions);
    expect(props.historyEvidence).toMatchObject({ source: "history", state: "stale" });
    expect(props.historyEvidence.message).toContain("refresh failed");
  });

  it("propagates truncated and indeterminate history completeness truthfully", async () => {
    useStatusHistoryMock.mockReturnValue({
      data: { transitions: [], hasMore: true },
      error: null,
      isLoading: false,
      refetch: vi.fn().mockResolvedValue(undefined),
    });
    const view = render(<HistoryClient />);
    await waitFor(() => expect(historySectionPropsMock).toHaveBeenCalled());
    expect(
      (historySectionPropsMock.mock.calls.at(-1)?.[0] as { historyEvidence: { completeness: string } })
        .historyEvidence.completeness,
    ).toBe("truncated");

    useStatusHistoryMock.mockReturnValue({
      data: { transitions: [], hasMore: null },
      error: null,
      isLoading: false,
      refetch: vi.fn().mockResolvedValue(undefined),
    });
    view.rerender(<HistoryClient />);
    await waitFor(() =>
      expect(
        (historySectionPropsMock.mock.calls.at(-1)?.[0] as { historyEvidence: { completeness: string } })
          .historyEvidence.completeness,
      ).toBe("unknown"),
    );
  });
});

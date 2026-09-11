// @vitest-environment jsdom

import type { ComponentProps } from "react";
import type { HistorySection } from "../../sections/history-section";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHealthyStatusResponse } from "@/test-utils/status-fixtures";

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

vi.mock("@/hooks/admin-api-hooks", () => ({
  useStatus: useStatusMock,
  useStatusHistory: useStatusHistoryMock,
  useAdminActionLog: useAdminActionLogMock,
  useApiKeyAuditLog: useApiKeyAuditLogMock,
}));
vi.mock("@/hooks/use-release-metadata", () => ({ useReleaseMetadata: useReleaseMetadataMock }));
vi.mock("../../sections/history-section", () => ({
  HistorySection: (props: ComponentProps<typeof HistorySection>) => {
    historySectionPropsMock(props);
    return (
      <div data-testid="history-section">
        <button onClick={() => props.setHistoryWindow("30d")}>Last 30 days</button>
        <button onClick={props.adminActionLog.onRetry}>Retry actions</button>
        <button onClick={props.credentialAudit.onRetry}>Retry credentials</button>
      </div>
    );
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

  it("resynchronizes filters and the query window on browser history navigation", () => {
    render(<HistoryClient />);
    act(() => {
      window.history.replaceState({}, "", "/admin/history/?keep=2&window=30d&severity=warning");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(useStatusHistoryMock).toHaveBeenLastCalledWith("30d");
    expect(historySectionPropsMock.mock.calls.at(-1)?.[0]).toMatchObject({
      historyWindow: "30d",
      historyFilters: { severity: "warning", surface: "all", causeCode: null, publicImpact: "all" },
    });
  });

  it("changes the history window without losing filters or unrelated URL state", () => {
    render(<HistoryClient />);
    fireEvent.click(screen.getByRole("button", { name: "Last 30 days" }));
    expect(useStatusHistoryMock).toHaveBeenLastCalledWith("30d");
    const query = new URLSearchParams(window.location.search);
    expect(Object.fromEntries(query)).toMatchObject({
      keep: "1", window: "30d", severity: "critical", cause: "db_unhealthy",
    });
  });

  it("retries all four failed-workspace queries even when one refresh rejects", async () => {
    const refreshes = [useStatusMock, useStatusHistoryMock, useAdminActionLogMock, useApiKeyAuditLogMock]
      .map((query) => query.getMockImplementation()!().refetch);
    useStatusMock.mockReturnValue({
      data: undefined, error: new Error("status unavailable"), isLoading: false, refetch: refreshes[0],
    });
    refreshes[1].mockRejectedValueOnce(new Error("history still unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      render(<HistoryClient />);
      expect(screen.getByRole("alert").textContent).toContain("status unavailable");
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
      for (const refetch of refreshes) expect(refetch).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("retries each operational log independently", () => {
    const actionRefetch = useAdminActionLogMock.getMockImplementation()!().refetch;
    const credentialRefetch = useApiKeyAuditLogMock.getMockImplementation()!().refetch;
    const statusRefetch = useStatusMock.getMockImplementation()!().refetch;
    const historyRefetch = useStatusHistoryMock.getMockImplementation()!().refetch;
    render(<HistoryClient />);
    fireEvent.click(screen.getByRole("button", { name: "Retry actions" }));
    expect(actionRefetch).toHaveBeenCalledTimes(1);
    expect(credentialRefetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry credentials" }));
    expect(credentialRefetch).toHaveBeenCalledTimes(1);
    expect(actionRefetch).toHaveBeenCalledTimes(1);
    expect(statusRefetch).not.toHaveBeenCalled();
    expect(historyRefetch).not.toHaveBeenCalled();
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

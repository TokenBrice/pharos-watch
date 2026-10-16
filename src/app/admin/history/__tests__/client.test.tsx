// @vitest-environment jsdom

import type { ComponentProps } from "react";
import type { HistorySection } from "../../sections/history-section";
import { cleanup, render, waitFor } from "@testing-library/react";
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

  it("passes nullable role evidence without manufacturing deployment metadata", async () => {
    render(<HistoryClient />);
    await waitFor(() => expect(historySectionPropsMock).toHaveBeenCalled());
    const props = historySectionPropsMock.mock.calls.at(-1)?.[0] as ComponentProps<typeof HistorySection>;
    expect(props.workerVersions).toEqual({ public: null, heavy: null });
    expect(props.transitionsLast24h).toBe(status.summary.transitionsLast24h);
  });

  it("passes both verified markers even when producer history names a newer execution", () => {
    const workerVersions = {
      public: { scriptName: "stablecoin-api", workerVersion: "public-v1", activatedAt: 100 },
      heavy: { scriptName: "stablecoin-heavy", workerVersion: "heavy-v2", activatedAt: 200 },
    };
    useStatusMock.mockReturnValue({
      ...useStatusMock.getMockImplementation()!(),
      data: { ...status, workerVersions, producerHeads: [{ lastWorkerVersion: "unverified-newer", lastInvokedAt: 300 }] },
    });
    render(<HistoryClient />);
    expect(historySectionPropsMock.mock.calls.at(-1)?.[0].workerVersions).toBe(workerVersions);
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

  it("treats an empty transition list without a completeness marker as a failed read (B3)", async () => {
    const refetch = vi.fn().mockResolvedValue(undefined);
    useStatusHistoryMock.mockReturnValue({
      data: { transitions: [], hasMore: null },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch,
    });
    render(<HistoryClient />);
    await waitFor(() => expect(historySectionPropsMock).toHaveBeenCalled());
    const props = historySectionPropsMock.mock.calls.at(-1)?.[0] as ComponentProps<typeof HistorySection>;
    expect(props.historyEvidence).toMatchObject({ source: "history", state: "error", completeness: "unknown" });
    props.onRetryHistory?.();
    expect(refetch).toHaveBeenCalledOnce();
  });
});

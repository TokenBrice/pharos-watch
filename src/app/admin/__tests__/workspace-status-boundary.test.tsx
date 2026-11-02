// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceStatusBoundary } from "@/app/admin/workspace-status-boundary";
import { createStatusWorkspaceClient } from "@/app/admin/status-workspace-client";
import { makeHealthyStatusResponse } from "@/test-utils/status-fixtures";
import type { StatusResponse } from "@shared/types";

const { useStatusMock, sectionPropsMock } = vi.hoisted(() => ({
  useStatusMock: vi.fn(),
  sectionPropsMock: vi.fn(),
}));

vi.mock("@/hooks/admin-api-hooks", () => ({ useStatus: useStatusMock }));

const StatusSection = (props: { data: StatusResponse }) => {
  sectionPropsMock(props);
  return <div>status section</div>;
};
const StatusWorkspaceClient = createStatusWorkspaceClient(StatusSection);

describe("createStatusWorkspaceClient", () => {
  it("forwards status data, retry and only Error failures to the workspace boundary", () => {
    const status = makeHealthyStatusResponse();
    const refetch = vi.fn().mockResolvedValue(undefined);
    useStatusMock.mockReturnValue({ data: status, error: null, isLoading: false, refetch });
    const view = render(<StatusWorkspaceClient />);
    expect(sectionPropsMock).toHaveBeenLastCalledWith({ data: status });

    // A non-Error rejection is not error evidence: the boundary sees null, not a fabricated failure.
    useStatusMock.mockReturnValue({ data: undefined, error: "boom", isLoading: false, refetch });
    view.rerender(<StatusWorkspaceClient />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Status data is unavailable");

    // The boundary's retry command is the status query's refetch.
    useStatusMock.mockReturnValue({ data: undefined, error: new Error("status timeout"), isLoading: false, refetch });
    view.rerender(<StatusWorkspaceClient />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledOnce();
  });
});


describe("WorkspaceStatusBoundary announcements", () => {
  it("announces initial loading and unavailable states politely", () => {
    const view = render(
      <WorkspaceStatusBoundary data={undefined} error={null} isLoading onRetry={vi.fn()}>
        {() => <div>workspace</div>}
      </WorkspaceStatusBoundary>,
    );

    const loading = screen.getByRole("status", { name: "Loading workspace data" });
    expect(loading.textContent).toContain("Loading workspace data");
    expect(loading.getAttribute("aria-live")).toBe("polite");
    expect(loading.getAttribute("aria-atomic")).toBe("true");

    view.rerender(
      <WorkspaceStatusBoundary data={undefined} error={null} isLoading={false} onRetry={vi.fn()}>
        {() => <div>workspace</div>}
      </WorkspaceStatusBoundary>,
    );
    expect(screen.getByRole("status").textContent).toContain("Status data is unavailable");
  });

  it("announces initial failures assertively and preserves the retry command", () => {
    const retry = vi.fn();
    render(
      <WorkspaceStatusBoundary data={undefined} error={new Error("status timeout")} isLoading={false} onRetry={retry}>
        {() => <div>workspace</div>}
      </WorkspaceStatusBoundary>,
    );

    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(alert.textContent).toContain("status timeout");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "Reauthenticate" }).getAttribute("href")).toBe(
      "/cdn-cgi/access/login",
    );
    expect(screen.getByRole("button", { name: "Retry" }).className).toContain("min-h-11");
  });

  it("announces a background refresh failure without replacing last-good content", () => {
    render(
      <WorkspaceStatusBoundary
        data={makeHealthyStatusResponse()}
        error={new Error("refresh timeout")}
        isLoading={false}
        onRetry={vi.fn()}
      >
        {() => <div>last-good workspace</div>}
      </WorkspaceStatusBoundary>,
    );

    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toContain("Status refresh failed");
    expect(screen.getByText("last-good workspace")).toBeTruthy();
  });
});

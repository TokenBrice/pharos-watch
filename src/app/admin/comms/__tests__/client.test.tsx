// @vitest-environment jsdom

import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveAdminWorkspace, isAdminWorkspaceActive } from "@/lib/admin-workspaces";
import { makeHealthyStatusResponse } from "@/test-utils/status-fixtures";

const { useStatusMock, commsSectionPropsMock } = vi.hoisted(() => ({
  useStatusMock: vi.fn(),
  commsSectionPropsMock: vi.fn(),
}));

vi.mock("@/hooks/admin-api-hooks", () => ({ useStatus: useStatusMock }));
vi.mock("../../workspace-status-boundary", () => ({
  WorkspaceStatusBoundary: ({
    data,
    onRetry,
    children,
  }: {
    data: unknown;
    onRetry: () => void;
    children: (data: unknown) => ReactNode;
  }) => (
    <div>
      <button type="button" onClick={onRetry}>
        Retry status
      </button>
      {data ? children(data) : null}
    </div>
  ),
}));
vi.mock("../../sections/comms-section", () => ({
  CommsSection: (props: unknown) => {
    commsSectionPropsMock(props);
    return <div>Comms section mounted</div>;
  },
}));

import CommsClient from "../client";

const status = makeHealthyStatusResponse();
const refetch = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  window.history.replaceState({}, "", "/admin/comms/");
  useStatusMock.mockReturnValue({ data: status, error: null, isLoading: false, refetch });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CommsClient", () => {
  it("owns the status query and passes its payload to the routed Comms workspace", () => {
    render(<CommsClient />);

    expect(screen.getByText("Comms section mounted")).toBeTruthy();
    expect(commsSectionPropsMock).toHaveBeenCalledWith({ data: status });
    expect(getActiveAdminWorkspace(window.location.pathname)?.id).toBe("comms");
    expect(isAdminWorkspaceActive(window.location.pathname, "comms")).toBe(true);
    expect(isAdminWorkspaceActive(window.location.pathname, "actions")).toBe(false);
  });

  it("retains an explicit status refresh path", () => {
    render(<CommsClient />);
    fireEvent.click(screen.getByRole("button", { name: "Retry status" }));

    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

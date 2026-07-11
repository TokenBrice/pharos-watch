// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceStatusBoundary } from "@/app/admin/workspace-status-boundary";
import { makeHealthyStatusResponse } from "@/test-utils/status-fixtures";

afterEach(cleanup);

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

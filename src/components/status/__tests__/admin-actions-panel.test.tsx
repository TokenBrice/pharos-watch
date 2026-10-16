// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStatusPageActions } from "@shared/lib/api-endpoints";
import { AdminActionExecutionProvider } from "@/components/status/admin-action-execution-provider";
import type { ActionReadinessCheck } from "@/lib/status/admin-ops-insights";
import type { StatusActionRecommendation } from "@/lib/status/action-recommendations";
import { makeHealthyStatusResponse } from "@/test-utils/status-fixtures";

const { useAdminActionLogMock } = vi.hoisted(() => ({
  useAdminActionLogMock: vi.fn(),
}));

vi.mock("@/hooks/admin-api-hooks", () => ({
  useAdminActionLog: useAdminActionLogMock,
}));

const { AdminActionsPanel } = await import("../admin-actions-panel");
const ACTIONS = getStatusPageActions();

function renderPanel({
  systemHealthy = true,
  recommendations = [],
  readinessChecks = [],
}: {
  systemHealthy?: boolean;
  recommendations?: StatusActionRecommendation[];
  readinessChecks?: ActionReadinessCheck[];
} = {}) {
  const status = makeHealthyStatusResponse();
  return render(
    <AdminActionExecutionProvider createIdempotencyKey={() => "actions-panel-intent"}>
      <AdminActionsPanel
        status={{ causes: status.causes, crons: status.crons }}
        nowSeconds={status.timestamp}
        readinessChecks={readinessChecks}
        systemHealthy={systemHealthy}
        recommendations={recommendations}
      />
    </AdminActionExecutionProvider>,
  );
}

function recommendation(path: string): StatusActionRecommendation {
  const action = ACTIONS.find((candidate) => candidate.path === path);
  if (!action) throw new Error(`Missing test action ${path}`);
  return {
    action,
    reason: "The matching lane is unhealthy.",
    severity: "warning",
    source: "cron",
    sourceKey: "test-lane",
  };
}

beforeEach(() => {
  useAdminActionLogMock.mockReturnValue({
    data: { entries: [] },
    error: null,
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AdminActionsPanel", () => {
  it("offers retry when persisted history fails", () => {
    const refetch = vi.fn().mockResolvedValue(undefined);
    useAdminActionLogMock.mockReturnValue({
      data: undefined,
      error: new Error("audit unavailable"),
      isLoading: false,
      isFetching: false,
      isError: true,
      refetch,
    });
    renderPanel();

    expect(screen.getByRole("alert").textContent).toContain("audit unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry history" }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("opens a direct dry run and enforces live readiness without an override", () => {
    const path = "/api/remediate-blacklist-amount-gaps";
    const readinessChecks: ActionReadinessCheck[] = [
      { id: "fresh-status-view", label: "Dashboard data", state: "ready", detail: "Fresh." },
      { id: "public-health", label: "Public health", state: "ready", detail: "Healthy." },
      { id: "d1-writes", label: "D1 write path", state: "blocked", detail: "D1 is unhealthy." },
    ];
    renderPanel({ recommendations: [recommendation(path)], readinessChecks });

    fireEvent.click(screen.getAllByRole("button", { name: "Dry run" })[0]);
    const dialog = screen.getByRole("dialog");
    const dryRun = within(dialog).getByLabelText(/^Dry run/) as HTMLInputElement;
    expect(dryRun.checked).toBe(true);
    expect(screen.queryByText("Live execution blocked")).toBeNull();

    fireEvent.click(dryRun);
    expect(screen.getByText("Live execution blocked")).toBeTruthy();
    expect(screen.getByText("No audited override is available for this action.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

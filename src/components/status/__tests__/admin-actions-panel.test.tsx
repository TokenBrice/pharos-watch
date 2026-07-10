// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStatusPageActions } from "@shared/lib/api-endpoints";
import { AdminActionExecutionProvider } from "@/components/status/admin-action-execution-provider";
import type { ActionReadinessCheck } from "@/lib/status/admin-ops-insights";
import type { StatusActionRecommendation } from "@/lib/status/action-recommendations";
import { makeHealthyStatusResponse } from "@/test-utils/status-fixtures";

const { useAdminActionLogMock } = vi.hoisted(() => ({
  useAdminActionLogMock: vi.fn(),
}));

vi.mock("@/hooks/use-admin-action-log", () => ({
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
  cleanup();
  vi.restoreAllMocks();
});

describe("AdminActionsPanel", () => {
  it("collapses the complete catalog when healthy and opens it for search", async () => {
    renderPanel();

    const details = screen.getByText("Complete action catalog").closest("details");
    expect(details?.hasAttribute("open")).toBe(false);
    expect(screen.queryByLabelText("Search action catalog")).toBeNull();

    fireEvent.click(screen.getByText("Complete action catalog"));
    const search = await screen.findByLabelText("Search action catalog");
    fireEvent.change(search, { target: { value: "DEWS historical" } });
    expect(details?.hasAttribute("open")).toBe(true);
    expect(screen.getByText("Validate DEWS History")).toBeTruthy();
    expect(screen.getByText(/2\/\d+ actions/)).toBeTruthy();
  });

  it("opens the complete catalog when the system is not healthy and composes intent and risk filters", () => {
    renderPanel({ systemHealthy: false });

    const details = screen.getByText("Complete action catalog").closest("details");
    expect(details?.hasAttribute("open")).toBe(true);
    fireEvent.change(screen.getByLabelText("Filter by intent"), { target: { value: "inspect" } });
    fireEvent.change(screen.getByLabelText("Filter by risk"), { target: { value: "read-only" } });

    const inspectGroup = screen.getByRole("heading", { name: "Inspect" }).closest("section");
    expect(inspectGroup).toBeTruthy();
    expect(within(inspectGroup!).getByText("Validate DEWS History")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Recovery" })).toBeNull();
  });

  it("shows recommended actions and reconciled persisted history by default", () => {
    useAdminActionLogMock.mockReturnValue({
      data: {
        entries: [
          {
            id: 9,
            at: 1_699_999_940,
            actor: "operator@example.com",
            action: "backfill-supply-history",
            target: "usdc-circle",
            result: "ok",
            httpStatus: 200,
            details: { status: "succeeded" },
          },
        ],
      },
      error: null,
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn().mockResolvedValue(undefined),
    });
    renderPanel({ recommendations: [recommendation("/api/backfill-supply-history")] });

    expect(screen.getByText("The matching lane is unhealthy.")).toBeTruthy();
    expect(screen.getByText("1 audited records loaded")).toBeTruthy();
    expect(screen.getByText("operator@example.com", { exact: false })).toBeTruthy();
    expect(screen.getByText(/Every catalog action that reaches the API is audited server-side/)).toBeTruthy();
    expect(screen.getByText("1m ago")).toBeTruthy();
    expect(screen.getByText("succeeded")).toBeTruthy();
  });

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

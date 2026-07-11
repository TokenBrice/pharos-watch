// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StatusTransition } from "@shared/types";
import { DEFAULT_INCIDENT_HISTORY_QUERY } from "@/lib/incident-history-view-model";
import { TransitionTimeline } from "../transition-timeline";

afterEach(cleanup);

function makeTransitions(): StatusTransition[] {
  return [
    {
      id: 17,
      scope: "global",
      from: "healthy",
      to: "degraded",
      rawStatus: "degraded",
      transitionType: "degrade",
      reason: "Cache age breached warning threshold",
      confidence: 0.82,
      at: 1_700_000_000,
      causes: [
        {
          code: "cache_ratio_degraded",
          layer: "availability",
          severity: "warning",
          message: "Cache freshness exceeded the target window.",
          metric: "age",
          value: 12,
          threshold: 8,
        },
      ],
    },
    {
      id: 18,
      scope: "global",
      from: "degraded",
      to: "healthy",
      rawStatus: "healthy",
      transitionType: "recover",
      reason: "Cache age recovered",
      confidence: 0.99,
      at: 1_700_000_600,
      causes: [
        {
          code: "cache_recovered",
          layer: "system",
          severity: "info",
          message: "Cache freshness returned within budget.",
        },
      ],
    },
  ];
}

describe("TransitionTimeline", () => {
  it("renders timing, flapping, pressed windows, local scrolling, and accessible cause disclosure", () => {
    const onWindowChange = vi.fn();
    const onFiltersChange = vi.fn();
    render(
      <TransitionTimeline
        transitions={makeTransitions()}
        nowSeconds={1_700_001_000}
        transitionsLast24h={4}
        window="24h"
        filters={DEFAULT_INCIDENT_HISTORY_QUERY}
        onWindowChange={onWindowChange}
        onFiltersChange={onFiltersChange}
        isLoading={false}
      />,
    );

    const tableShell = screen.getByTestId("status-transition-timeline-table");
    expect(tableShell.getAttribute("data-table-id")).toBe("status-transition-timeline");
    expect(tableShell.className).toContain("table-header-sticky");
    const viewport = tableShell.querySelector('[data-slot="table-viewport"]');
    expect(viewport?.className).toContain("overflow-x-auto");
    expect(viewport?.className).toContain("overflow-y-auto");
    expect(screen.getByRole("table", { name: /status transition history/i })).toBeTruthy();
    expect(screen.getByText("healthy -> degraded")).toBeTruthy();
    expect(screen.getByText(/State duration: 10m/i)).toBeTruthy();
    expect(screen.getAllByText(/Resolved at/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Flapping detected/i)).toBeTruthy();

    const selectedWindow = screen.getByRole("button", { name: "24h" });
    const otherWindow = screen.getByRole("button", { name: "30d" });
    expect(selectedWindow.getAttribute("aria-pressed")).toBe("true");
    expect(selectedWindow.className).toContain("min-h-11");
    expect(otherWindow.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(otherWindow);
    expect(onWindowChange).toHaveBeenCalledWith("30d");

    const disclosure = screen.getByRole("button", { name: "Show 1 causes for transition 17" });
    expect(disclosure.className).toContain("min-h-11");
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(disclosure.hasAttribute("aria-controls")).toBe(false);
    fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(disclosure.getAttribute("aria-controls")).toBe("transition-causes-17");
    expect(screen.getByText("Cache freshness exceeded the target window.")).toBeTruthy();
    expect(screen.getByText("Raw cause data")).toBeTruthy();
    expect(screen.getByText(/"cache_ratio_degraded"/i)).toBeTruthy();
  });

  it("exposes all filter controls and keeps cause-less evidence Unknown", () => {
    const onFiltersChange = vi.fn();
    const transition: StatusTransition = {
      id: 19,
      scope: "global",
      from: "healthy",
      to: "degraded",
      rawStatus: "degraded",
      transitionType: "degrade",
      reason: "Cause payload unavailable",
      confidence: 0.4,
      at: 1_700_000_000,
      causes: [],
    };
    render(
      <TransitionTimeline
        transitions={[transition]}
        nowSeconds={1_700_000_100}
        transitionsLast24h={1}
        window="24h"
        filters={DEFAULT_INCIDENT_HISTORY_QUERY}
        onWindowChange={vi.fn()}
        onFiltersChange={onFiltersChange}
        isLoading={false}
      />,
    );

    expect(screen.getAllByText("Unknown").length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText(/Flapping detected/i)).toBeNull();
    fireEvent.change(screen.getByLabelText("Severity"), { target: { value: "unknown" } });
    fireEvent.change(screen.getByLabelText("Surface"), { target: { value: "unknown" } });
    fireEvent.change(screen.getByLabelText("Cause code"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Public impact"), { target: { value: "unknown" } });
    expect(onFiltersChange).toHaveBeenCalledWith({ severity: "unknown" });
    expect(onFiltersChange).toHaveBeenCalledWith({ surface: "unknown" });
    expect(onFiltersChange).toHaveBeenCalledWith({ causeCode: null });
    expect(onFiltersChange).toHaveBeenCalledWith({ publicImpact: "unknown" });

    fireEvent.click(screen.getByRole("button", { name: "Show 0 causes for transition 19" }));
    expect(screen.getByText(/No persisted causes are available/i)).toBeTruthy();
  });

  it("renders a resettable no-match state", () => {
    const onFiltersChange = vi.fn();
    render(
      <TransitionTimeline
        transitions={makeTransitions()}
        nowSeconds={1_700_001_000}
        transitionsLast24h={2}
        window="24h"
        filters={{ ...DEFAULT_INCIDENT_HISTORY_QUERY, severity: "critical" }}
        onWindowChange={vi.fn()}
        onFiltersChange={onFiltersChange}
        isLoading={false}
      />,
    );

    expect(screen.getByText("No transitions match the current filters.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(onFiltersChange).toHaveBeenCalledWith({
      severity: "all",
      surface: "all",
      causeCode: null,
      publicImpact: "all",
    });
  });
});

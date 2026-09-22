// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PublicStatusTransition } from "@shared/types";
import { PublicTransitionTimeline } from "../public-transition-timeline";


describe("PublicTransitionTimeline", () => {
  it("renders the public transition log as a shared table and keeps window controls", () => {
    const onWindowChange = vi.fn();
    const transitions: PublicStatusTransition[] = [
      {
        id: 3,
        from: "healthy",
        to: "degraded",
        transitionType: "degrade",
        reason: "Public status degraded after repeated stale probes.",
        at: 1_700_000_000,
      },
    ];

    render(
      <PublicTransitionTimeline
        transitions={transitions}
        window="7d"
        onWindowChange={onWindowChange}
        isLoading={false}
      />,
    );

    const tableShell = screen.getByTestId("public-status-transition-timeline-table");
    expect(tableShell.getAttribute("data-table-id")).toBe("public-status-transition-timeline");
    expect(screen.getByRole("table", { name: /public status transition history/i })).toBeTruthy();
    expect(screen.getByText("healthy → degraded")).toBeTruthy();
    expect(screen.getByText("Degradation")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "30d" }));

    expect(onWindowChange).toHaveBeenCalledWith("30d");
  });

  it("reports a failed history read instead of an empty incident log", () => {
    render(
      <PublicTransitionTimeline
        transitions={[]}
        window="7d"
        onWindowChange={vi.fn()}
        isLoading={false}
        error={new Error("history query rejected")}
      />,
    );

    expect(screen.getByText("Status history is unavailable: history query rejected")).toBeTruthy();
    expect(screen.queryByText("No status changes recorded in this window.")).toBeNull();
  });
});

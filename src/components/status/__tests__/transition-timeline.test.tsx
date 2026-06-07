// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StatusTransition } from "@shared/types";
import { TransitionTimeline } from "../transition-timeline";

afterEach(() => {
  cleanup();
});

describe("TransitionTimeline", () => {
  it("renders the admin incident timeline as a shared table and preserves cause expansion", () => {
    const transitions: StatusTransition[] = [
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
            code: "cache_stale",
            layer: "availability",
            severity: "warning",
            message: "Cache freshness exceeded the target window.",
            metric: "age",
            value: 12,
            threshold: 8,
          },
        ],
      },
    ];

    render(<TransitionTimeline transitions={transitions} window="24h" onWindowChange={vi.fn()} isLoading={false} />);

    const tableShell = screen.getByTestId("status-transition-timeline-table");
    expect(tableShell.getAttribute("data-table-id")).toBe("status-transition-timeline");
    expect(screen.getByRole("table", { name: /status transition history/i })).toBeTruthy();
    expect(screen.getByText("healthy → degraded")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /show 1/i }));

    expect(screen.getByText(/cache_stale · age=12/i)).toBeTruthy();
    expect(screen.getByText("Cache freshness exceeded the target window.")).toBeTruthy();
  });
});

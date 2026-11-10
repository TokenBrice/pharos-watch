// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StatusTransition } from "@shared/types";
import { DEFAULT_INCIDENT_HISTORY_QUERY } from "@/lib/incident-history-view-model";
import { TransitionTimeline } from "../transition-timeline";


describe("TransitionTimeline", () => {
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

  it("keeps a window-start recovery's causes unknown instead of printing recovery-time codes", () => {
    const recovery: StatusTransition = {
      id: 20,
      scope: "global",
      from: "stale",
      to: "healthy",
      rawStatus: "healthy",
      transitionType: "recover",
      reason: "Checks recovered",
      confidence: 1,
      causes: [{
        code: "reserve_sync_history_write_gap",
        layer: "data-quality",
        severity: "info",
        message: "Recovery-time observation.",
      }],
      at: 1_700_000_000,
    };
    render(
      <TransitionTimeline
        transitions={[recovery]}
        nowSeconds={1_700_000_100}
        transitionsLast24h={1}
        window="24h"
        filters={DEFAULT_INCIDENT_HISTORY_QUERY}
        onWindowChange={vi.fn()}
        onFiltersChange={vi.fn()}
        isLoading={false}
      />,
    );

    const episode = screen.getByTitle("Worst admin state: stale").closest("li")!;
    expect(episode.textContent).toContain("—");
    expect(episode.textContent).not.toContain("No persisted causes");
    expect(episode.textContent).not.toContain("reserve_sync_history_write_gap");
  });

  it("marks the newest row last known when the clock comes from a retained read", () => {
    const transition: StatusTransition = {
      id: 21,
      scope: "global",
      from: "healthy",
      to: "degraded",
      rawStatus: "degraded",
      transitionType: "degrade",
      reason: "Retained degradation",
      confidence: 1,
      causes: [],
      at: 1_700_000_000,
    };
    render(
      <TransitionTimeline
        transitions={[transition]}
        nowSeconds={1_700_003_600}
        transitionsLast24h={1}
        window="24h"
        filters={DEFAULT_INCIDENT_HISTORY_QUERY}
        onWindowChange={vi.fn()}
        onFiltersChange={vi.fn()}
        isLoading={false}
        retainedClock
      />,
    );

    expect(screen.getByText(/Last known state: 1h/)).toBeTruthy();
    expect(screen.queryByText(/Current state/)).toBeNull();
  });

  it("renders a failed read as an error with retry, never as an empty history", () => {
    const onRetry = vi.fn();
    render(
      <TransitionTimeline
        transitions={[]}
        nowSeconds={1_700_001_000}
        transitionsLast24h={null}
        window="24h"
        filters={DEFAULT_INCIDENT_HISTORY_QUERY}
        onWindowChange={vi.fn()}
        onFiltersChange={vi.fn()}
        isLoading={false}
        readFailed
        onRetry={onRetry}
      />,
    );

    expect(screen.queryByText(/No status transitions recorded/i)).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("could not be loaded");
    fireEvent.click(screen.getByRole("button", { name: "Retry history" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("only claims an empty window after a successful read", () => {
    render(
      <TransitionTimeline
        transitions={[]}
        nowSeconds={1_700_001_000}
        transitionsLast24h={0}
        window="24h"
        filters={DEFAULT_INCIDENT_HISTORY_QUERY}
        onWindowChange={vi.fn()}
        onFiltersChange={vi.fn()}
        isLoading={false}
      />,
    );
    expect(screen.getByText("No status transitions recorded in this window.")).toBeTruthy();
  });

});

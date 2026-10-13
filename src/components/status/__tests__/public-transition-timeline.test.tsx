// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PublicStatusTransition } from "@shared/types";
import { PublicIncidentList } from "../public-transition-timeline";

const NOW = 1_790_000_000;

describe("PublicIncidentList", () => {
  it("shows folded incidents with component labels and hides machine reasons behind a disclosure", () => {
    const transitions: PublicStatusTransition[] = [
      { id: 2, at: NOW - 600, source: "public", from: "degraded", to: "healthy", transitionType: "recover",
        reason: "public-projection-changed", components: [] },
      { id: 1, at: NOW - 3600, source: "public", from: "healthy", to: "degraded", transitionType: "degrade",
        reason: "public-projection-changed",
        components: [{ id: "mint-burn", state: "degraded", reasons: ["mint-burn-sync-age:degraded"] }] },
    ];
    render(<PublicIncidentList transitions={transitions} nowSec={NOW} historyDays={30} hasMore={false} />);

    expect(screen.getByText("Mint and burn flows")).toBeTruthy();
    expect(screen.getByText("Degraded")).toBeTruthy();
    expect(screen.getByText("50m")).toBeTruthy();
    const detail = screen.getByText("mint-burn-sync-age:degraded").closest("details");
    expect(detail?.open).toBe(false);
    expect(screen.queryByText(/older changes in this window were not loaded/)).toBeNull();
  });

  it("labels legacy operator rows honestly and states the load bound (R7)", () => {
    const transitions: PublicStatusTransition[] = [
      { id: 1, at: NOW - 7200, source: "legacy", from: "healthy", to: "degraded", transitionType: "degrade",
        reason: "raw-degraded-consecutive-threshold" },
    ];
    render(<PublicIncidentList transitions={transitions} nowSec={NOW} historyDays={30} hasMore />);

    expect(screen.getByText("Earlier incidents")).toBeTruthy();
    expect(screen.getByText("Earlier incident (overall state only)")).toBeTruthy();
    // Legacy degraded maps onto the component vocabulary, never a raw "Stale".
    expect(screen.getByText("Degraded")).toBeTruthy();
    expect(screen.getByText("Ongoing")).toBeTruthy();
    expect(screen.getByText("No incidents recorded in the last 30 days.")).toBeTruthy();
    expect(screen.getByText("Showing the latest 1 status changes; older changes in this window were not loaded.")).toBeTruthy();
  });

  it("bounds a long incident list and expands on request", () => {
    const transitions: PublicStatusTransition[] = Array.from({ length: 24 }, (_, index) => ({
      id: index + 1,
      at: NOW - 100_000 + index * 1000,
      source: "public" as const,
      from: index % 2 === 0 ? "healthy" as const : "degraded" as const,
      to: index % 2 === 0 ? "degraded" as const : "healthy" as const,
      transitionType: index % 2 === 0 ? "degrade" as const : "recover" as const,
      reason: "public-projection-changed",
      components: index % 2 === 0 ? [{ id: "yield" as const, state: "delayed" as const, reasons: [] }] : [],
    }));
    render(<PublicIncidentList transitions={transitions} nowSec={NOW} historyDays={30} hasMore={false} />);

    expect(screen.getAllByText("Yield")).toHaveLength(10);
    fireEvent.click(screen.getByRole("button", { name: "Show all 12 incidents" }));
    expect(screen.getAllByText("Yield")).toHaveLength(12);
  });
});

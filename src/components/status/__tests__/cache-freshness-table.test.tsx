// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CacheFreshnessTable } from "../cache-freshness-table";
import type { CacheStatus } from "@shared/types";


describe("CacheFreshnessTable", () => {
  it("distinguishes producer cadence, endpoint target, and availability budget", async () => {
    const dexCache: CacheStatus = {
      ageSeconds: 7_200,
      maxAge: 43_200,
      healthy: true,
      producerJob: "sync-dex-liquidity",
      producerIntervalSec: 1_800,
      endpointMaxAge: 3_600,
      availabilityMaxAge: 43_200,
      endpointBudgetReason: "Endpoint warning target.",
      availabilityBudgetReason: "Availability budget.",
      upstreamProvider: "DefiLlama",
    };

    render(<CacheFreshnessTable caches={{ "dex-liquidity": dexCache }} />);

    expect(screen.getByText(/By default, each lane is Delayed past/i)).toBeTruthy();
    expect(screen.getByText(/that lane's Delayed multiple of that basis/i)).toBeTruthy();
    expect(screen.getByText("1 healthy cache").className).toContain("min-h-11");
    // Collapsed healthy detail is not mounted until the operator opens it.
    expect(screen.queryByTestId("cache-freshness-healthy-table")).toBeNull();
    fireEvent.click(screen.getByText("1 healthy cache"));
    const tableShell = await screen.findByTestId("cache-freshness-healthy-table");
    expect(tableShell.getAttribute("data-table-id")).toBe("cache-freshness-healthy");
    expect(within(tableShell).getByRole("table", { name: /healthy cache freshness/i })).toBeTruthy();
    expect(within(tableShell).getByRole("columnheader", { name: "Lane" })).toBeTruthy();
    const row = screen.getByText("dex-liquidity").closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLTableRowElement).getByText(/availability budget 12h/i)).toBeTruthy();
    expect(within(row as HTMLTableRowElement).getByText(/sync-dex-liquidity · every 30m/i)).toBeTruthy();
    expect(within(row as HTMLTableRowElement).getByText(/basis 1h/i)).toBeTruthy();
    expect(within(row as HTMLTableRowElement).getByText(/warning after 8h/i)).toBeTruthy();
    expect(within(row as HTMLTableRowElement).getByText(/endpoint basis differs/i)).toBeTruthy();
    expect(
      within(row as HTMLTableRowElement).getByText("Endpoint warning target. · Availability budget."),
    ).toBeTruthy();
  });

  it("lists a fresh cached-fallback lane as degraded, not as a healthy cache", () => {
    const fxCache: CacheStatus = {
      ageSeconds: 60,
      maxAge: 1_800,
      healthy: true,
      mode: "cached-fallback",
      consecutiveFallbackRuns: 3,
    };

    render(<CacheFreshnessTable caches={{ "fx-rates": fxCache }} />);

    expect(screen.queryByText(/healthy cache/)).toBeNull();
    const table = screen.getByTestId("cache-freshness-unhealthy-table");
    const row = within(table).getByText("fx-rates").closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLTableRowElement).getByText("Degraded")).toBeTruthy();
    expect(within(row as HTMLTableRowElement).getByText("3 fallback run(s)")).toBeTruthy();
  });

  it("lists a fresh quality-degraded lane as degraded and names the reason in the note", () => {
    const yieldCache: CacheStatus = {
      ageSeconds: 60,
      maxAge: 7_200,
      healthy: true,
      degraded: true,
      degradedReason: "safety-snapshot-coverage",
    };

    render(<CacheFreshnessTable caches={{ "yield-data": yieldCache }} />);

    expect(screen.queryByText(/healthy cache/)).toBeNull();
    const table = screen.getByTestId("cache-freshness-unhealthy-table");
    const row = within(table).getByText("yield-data").closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLTableRowElement).getByText("Degraded")).toBeTruthy();
    expect(within(row as HTMLTableRowElement).getByText("safety-snapshot-coverage")).toBeTruthy();
  });

  it("uses the yield-data override for its band and threshold labels", () => {
    const yieldCache: CacheStatus = {
      ageSeconds: 14_400,
      maxAge: 3_600,
      healthy: false,
      producerJob: "sync-yield-data",
      endpointMaxAge: 3_600,
      availabilityMaxAge: 3_600,
    };

    render(<CacheFreshnessTable caches={{ "yield-data": yieldCache }} />);

    expect(screen.getByTestId("cache-freshness-unhealthy-table")).toBeTruthy();
    const row = screen.getByText("yield-data").closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLTableRowElement).getByText("Delayed")).toBeTruthy();
    expect(within(row as HTMLTableRowElement).getByText("warning after 3h")).toBeTruthy();
    expect(within(row as HTMLTableRowElement).queryByText("warning after 8h")).toBeNull();
    expect(
      within(row as HTMLTableRowElement).getByText("Delayed >3.00x · degraded >6.00x · outage >12.00x"),
    ).toBeTruthy();
  });

});

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CacheFreshnessTable } from "../cache-freshness-table";
import type { CacheStatus } from "@shared/types";

afterEach(() => {
  cleanup();
});

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

    expect(screen.getByText(/Availability uses ratio thresholds/i)).toBeTruthy();
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

  it("keeps headers on the collapsed healthy table when unhealthy rows are visible", async () => {
    const degradedCache: CacheStatus = {
      ageSeconds: 9_000,
      maxAge: 1_000,
      healthy: false,
      producerJob: "sync-degraded",
    };
    const healthyCache: CacheStatus = {
      ageSeconds: 60,
      maxAge: 3_600,
      healthy: true,
      producerJob: "sync-healthy",
    };

    render(<CacheFreshnessTable caches={{ degraded: degradedCache, healthy: healthyCache }} />);

    expect(screen.getByTestId("cache-freshness-unhealthy-table")).toBeTruthy();
    fireEvent.click(screen.getByText("1 healthy cache"));
    const healthyTable = await screen.findByTestId("cache-freshness-healthy-table");
    expect(within(healthyTable).getByRole("columnheader", { name: "Lane" })).toBeTruthy();
    expect(within(healthyTable).getByText("healthy")).toBeTruthy();
  });
});

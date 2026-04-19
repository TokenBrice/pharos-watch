// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CacheFreshnessTable } from "../cache-freshness-table";
import type { CacheStatus } from "@shared/types";

afterEach(() => {
  cleanup();
});

describe("CacheFreshnessTable", () => {
  it("distinguishes producer cadence, endpoint target, and availability budget", () => {
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
    const row = screen.getByText("dex-liquidity").closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLTableRowElement).getByText(/availability budget 12h/i)).toBeTruthy();
    expect(within(row as HTMLTableRowElement).getByText(/sync-dex-liquidity · every 30m/i)).toBeTruthy();
    expect(within(row as HTMLTableRowElement).getByText(/basis 1h/i)).toBeTruthy();
    expect(within(row as HTMLTableRowElement).getByText(/warning after 8h/i)).toBeTruthy();
    expect(within(row as HTMLTableRowElement).getByText(/endpoint basis differs/i)).toBeTruthy();
    expect(within(row as HTMLTableRowElement).getByText("Endpoint warning target. · Availability budget.")).toBeTruthy();
  });
});

// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { D1UsageSummary } from "@shared/types";
import { D1UsageCard } from "../d1-usage-card";

function makeSummary(overrides: Partial<D1UsageSummary> = {}): D1UsageSummary {
  return {
    checkedAt: 1_712_600_000,
    windowStart: 1_712_513_600,
    windowEnd: 1_712_600_000,
    databaseId: "8f3f54ca-e035-4cdf-9ec5-a4fbde48b27a",
    databaseName: "stablecoin-db",
    databaseSizeBytes: 1_601_986_150,
    numTables: 63,
    region: "WEUR",
    readReplicationMode: "disabled",
    readQueries24h: 170_069,
    writeQueries24h: 543_307,
    rowsRead24h: 3_639_492,
    rowsWritten24h: 98_367_892,
    ...overrides,
  };
}

describe("D1UsageCard", () => {
  it("stacks the D1 metrics in a single column for readability", () => {
    const { container } = render(<D1UsageCard summary={makeSummary()} nowSeconds={1_712_600_120} />);

    expect(screen.getByText("Database Size")).toBeTruthy();
    expect(screen.getByText("Rows Read (24h)")).toBeTruthy();
    expect(screen.getByText("Rows Written (24h)")).toBeTruthy();
    expect(screen.getByText("Replication")).toBeTruthy();

    const metricsGrid = container.querySelector(".grid.grid-cols-1");
    expect(metricsGrid).toBeTruthy();
    expect(metricsGrid?.className).not.toContain("xl:grid-cols-4");
  });
});

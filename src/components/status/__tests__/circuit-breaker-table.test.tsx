// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CircuitRecord } from "@shared/types";
import { CircuitBreakerTable } from "../circuit-breaker-table";


describe("CircuitBreakerTable", () => {
  it("keeps tripped breakers visible and nests healthy breakers in a shared table", async () => {
    const circuits: Record<string, CircuitRecord> = {
      "dex-liquidity": {
        state: "open",
        consecutiveFailures: 4,
        lastFailureAt: 1_700_000_000,
        lastSuccessAt: null,
        openedAt: 1_700_000_000,
      },
      "price-consensus": {
        state: "closed",
        consecutiveFailures: 0,
        lastFailureAt: null,
        lastSuccessAt: 1_700_000_010,
        openedAt: null,
      },
    };

    render(<CircuitBreakerTable circuits={circuits} />);

    const trippedTable = screen.getByTestId("circuit-breakers-tripped-table");
    expect(trippedTable.getAttribute("data-table-id")).toBe("circuit-breakers-tripped");
    expect(within(trippedTable).getByRole("table", { name: /tripped circuit breakers/i })).toBeTruthy();
    expect(within(trippedTable).getByText("dex-liquidity")).toBeTruthy();
    expect(screen.getByText("1 healthy breaker")).toBeTruthy();

    // Collapsed healthy detail is not mounted until the operator opens it.
    expect(screen.queryByTestId("circuit-breakers-healthy-table")).toBeNull();
    fireEvent.click(screen.getByText("1 healthy breaker"));
    const healthyTable = await screen.findByTestId("circuit-breakers-healthy-table");
    expect(healthyTable.getAttribute("data-table-id")).toBe("circuit-breakers-healthy");
    expect(within(healthyTable).getByRole("table", { name: /healthy circuit breakers/i })).toBeTruthy();
    expect(within(healthyTable).getByRole("columnheader", { name: "Name" })).toBeTruthy();
    expect(within(healthyTable).getByText("price-consensus")).toBeTruthy();
  });
});

// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CircuitBreakerTable } from "../circuit-breaker-table";


describe("CircuitBreakerTable", () => {
  it("does not treat a failed circuit read as an empty registered set", () => {
    render(<CircuitBreakerTable circuits={null} unavailableReason="circuits-read-failed" />);
    expect(screen.getByText("Circuit breaker evidence unavailable (circuits-read-failed).")).toBeTruthy();
    expect(screen.queryByText("No circuit breakers registered")).toBeNull();
  });
});

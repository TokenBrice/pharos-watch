// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SovereigntyLattice } from "@/components/freezewatch/sovereignty-lattice";
import { installMatchMediaMock } from "@/test-utils/frontend";
import type { BlacklistSummaryResponse } from "@shared/types";

const emptyCoverage: NonNullable<BlacklistSummaryResponse["coverage"]> = {
  supported: [], unsupportedDeferred: [],
  counts: { supportedConfigs: 0, unsupportedDeferredConfigs: 0, bySymbol: {}, byChain: {}, byProviderSource: {} },
};
const stats = { perCoinTotalEvents: {}, perCoinFrozenTotal: {} } as BlacklistSummaryResponse["stats"];

beforeEach(() => installMatchMediaMock());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SovereigntyLattice", () => {
  it.each([undefined, new Error("summary unavailable")])("does not claim no coverage from absent summary data (%s)", (error) => {
    const onRetry = vi.fn();
    render(<SovereigntyLattice coverage={undefined} stats={undefined} chains={[]} isLoading={false}
      error={error} onRetry={onRetry} onCellSelect={vi.fn()} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByText(/No live coverage configurations/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry watched contract coverage" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("keeps a pending summary out of both unavailable and empty-success states", () => {
    render(<SovereigntyLattice coverage={undefined} stats={undefined} chains={[]} isLoading
      onCellSelect={vi.fn()} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/No live coverage configurations/)).toBeNull();
  });

  it("shows the no-coverage statement for an observed successful empty configuration set", () => {
    render(<SovereigntyLattice coverage={emptyCoverage} stats={stats} chains={[]} isLoading={false}
      onCellSelect={vi.fn()} />);
    expect(screen.getByText(/No live coverage configurations/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps a saved empty configuration set distinct from cold failure", () => {
    render(<SovereigntyLattice coverage={emptyCoverage} stats={stats} chains={[]} isLoading={false}
      error={new Error("refresh failed")} onCellSelect={vi.fn()} />);
    expect(screen.queryByText(/refresh failed/)).toBeNull();
    expect(screen.getByText(/No live coverage configurations/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

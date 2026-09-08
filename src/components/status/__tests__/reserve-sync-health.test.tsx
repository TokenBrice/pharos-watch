// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeReserveComposition } from "@shared/types/__tests__/status.test-support";
import type { StatusResponse } from "@shared/types/status";
import { ReserveSyncHealthCard } from "../reserve-sync-health";

function makeReserveHealth(
  overrides: Partial<StatusResponse["reserveComposition"]> = {},
): StatusResponse["reserveComposition"] {
  return makeReserveComposition({
    status: "healthy",
    configuredCoins: 100,
    freshCoins: 100,
    freshCoverageRatio: 1,
    authoritativeFreshCoverageRatio: 1,
    lastSuccessAt: 1_712_600_000,
    oldestFreshAgeSec: 600,
    independentFreshEligible: 90,
    staticValidatedFresh: 10,
    ...overrides,
  });
}

describe("ReserveSyncHealthCard", () => {

  it("explains conservative report-card inputs when reserve evidence is degraded", () => {
    render(
      <ReserveSyncHealthCard
        health={makeReserveHealth({
          status: "degraded",
          freshCoins: 74,
          degradedCoins: 71,
          deferredCoins: 48,
          freshCoverageRatio: 0.7365,
          authoritativeFreshCoverageRatio: 0.7329,
          nextCursorStablecoinId: "a7a5-old-vector",
          runBudgetTruncated: true,
          deferredAt: 1_712_600_000,
          persistentlyStaleIndependentCoins: [{ stablecoinId: "usdo-openeden", ageSec: 1_300_000 }],
        })}
        nowSeconds={1_712_600_120}
      />,
    );

    expect(screen.getByText("Report-card inputs are conservative")).toBeTruthy();
    expect(screen.getByText(/Safety scoring only trusts score-grade reserve evidence/)).toBeTruthy();
    expect(screen.getByText("73.7% fresh")).toBeTruthy();
    expect(screen.getByText("73.3% score-grade")).toBeTruthy();
    expect(screen.getByText("resume a7a5-old-vector")).toBeTruthy();
    expect(screen.getByText(/Queue pressure:/).textContent).toContain("run budget truncated");
  });

  it("does not show the conservative-input note when reserve evidence is healthy", () => {
    const { container } = render(<ReserveSyncHealthCard health={makeReserveHealth()} nowSeconds={1_712_600_120} />);

    expect(screen.queryByText("Report-card inputs are conservative")).toBeNull();
    expect(container.textContent).toContain("100.0% fresh, 100.0% score-grade");
  });
});

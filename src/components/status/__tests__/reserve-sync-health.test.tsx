// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { StatusResponse } from "@shared/types";
import { ReserveSyncHealthCard } from "../reserve-sync-health";

function makeReserveHealth(
  overrides: Partial<StatusResponse["reserveComposition"]> = {},
): StatusResponse["reserveComposition"] {
  return {
    status: "healthy",
    configuredCoins: 100,
    freshCoins: 100,
    errorCoins: 0,
    corruptCoins: 0,
    degradedCoins: 0,
    staleCoins: 0,
    missingCoins: 0,
    deferredCoins: 0,
    lastSuccessAt: 1_712_600_000,
    oldestFreshAgeSec: 600,
    freshCoverageRatio: 1,
    authoritativeFreshCoverageRatio: 1,
    nextCursorStablecoinId: null,
    runBudgetTruncated: false,
    deferredAt: null,
    cursorTailState: null,
    cursorTailError: null,
    cursorRecordedAt: null,
    cursorTailCompletedAt: null,
    cursorTailFailedAt: null,
    runBudgetTruncationCount: 0,
    historyWriteGaps: [],
    independentFreshEligible: 90,
    independentFreshUnverified: 0,
    staticValidatedFresh: 10,
    weakProbeFresh: 0,
    writeTimeoutUncertain: 0,
    persistentlyStaleIndependentCoins: [],
    ...overrides,
  } as StatusResponse["reserveComposition"];
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

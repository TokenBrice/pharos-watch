// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { StressTestPanel } from "@/components/stress-test-panel";
import type { StressTestState } from "@/hooks/use-stress-test";
import type { ReportCardGrade } from "@shared/types";

vi.mock("@/lib/analytics", () => ({
  trackEvent: vi.fn(),
}));

afterEach(() => {
  cleanup();
});

function Harness({
  onSetTarget,
  onSetGrade,
}: {
  onSetTarget: (coinId: string | null) => void;
  onSetGrade: (grade: ReportCardGrade | null) => void;
}) {
  const [targetCoinId, setTargetCoinId] = useState<string | null>(null);
  const [targetGrade, setTargetGrade] = useState<ReportCardGrade | null>(null);

  const stressTest: StressTestState = {
    targetCoinId,
    targetGrade,
    stressedCards: null,
    impacts: [],
    allAffectedIds: new Set(),
    headline: null,
    systemicRisks: [
      {
        coinId: "usdc-circle",
        name: "USD Coin",
        symbol: "USDC",
        affectedCount: 2,
        supplyAtRisk: 1000,
        dependentSupplyAtRisk: 900,
      },
    ],
    targetableCoins: [
      { id: "usdc-circle", name: "USD Coin", symbol: "USDC", dependentCount: 2 },
      { id: "usdt-tether", name: "Tether", symbol: "USDT", dependentCount: 1 },
    ],
    gradeOptions: targetCoinId ? ["D", "F"] : [],
    setTarget: (coinId) => {
      onSetTarget(coinId);
      setTargetCoinId(coinId);
      setTargetGrade(null);
    },
    setGrade: (grade) => {
      onSetGrade(grade);
      setTargetGrade(grade);
    },
    clear: () => {
      setTargetCoinId(null);
      setTargetGrade(null);
    },
  };

  return <StressTestPanel stressTest={stressTest} mcapMap={new Map()} />;
}

function makeStressTestState(overrides: Partial<StressTestState> = {}): StressTestState {
  return {
    targetCoinId: "usdc-circle",
    targetGrade: "D",
    stressedCards: null,
    impacts: [],
    allAffectedIds: new Set(),
    headline: null,
    systemicRisks: [],
    targetableCoins: [],
    gradeOptions: [],
    setTarget: vi.fn(),
    setGrade: vi.fn(),
    clear: vi.fn(),
    ...overrides,
  };
}

describe("StressTestPanel", () => {
  it("expands and wires custom and systemic simulation controls", () => {
    const onSetTarget = vi.fn();
    const onSetGrade = vi.fn();
    render(<Harness onSetTarget={onSetTarget} onSetGrade={onSetGrade} />);

    fireEvent.click(screen.getByRole("button", { name: /contagion map/i }));

    fireEvent.change(screen.getByLabelText("Target Coin"), {
      target: { value: "usdt-tether" },
    });
    expect(onSetTarget).toHaveBeenLastCalledWith("usdt-tether");

    fireEvent.change(screen.getByLabelText("Downgrade To"), {
      target: { value: "D" },
    });
    expect(onSetGrade).toHaveBeenLastCalledWith("D");

    fireEvent.click(screen.getByRole("button", { name: "Simulate USDC downgrade" }));
    expect(onSetTarget).toHaveBeenLastCalledWith("usdc-circle");
    expect(onSetGrade).toHaveBeenLastCalledWith("D");
  });

  it("renders stress impacts through the shared compact table frame", () => {
    render(
      <StressTestPanel
        isOpen
        stressTest={makeStressTestState({
          headline: {
            affectedCount: 1,
            totalAtRisk: 1_500_000,
            totalSupply: 2_000_000,
          },
          impacts: [
            {
              coinId: "usdt-tether",
              name: "Tether",
              symbol: "USDT",
              gradeBefore: "B+",
              scoreBefore: 78,
              gradeAfter: "C",
              scoreAfter: 62,
              delta: -16,
            },
          ],
        })}
        mcapMap={new Map([["usdt-tether", 100_000_000]])}
      />,
    );

    const shell = screen.getByTestId("stress-test-results-table");
    const table = screen.getByRole("table", { name: "Stress test results" });

    expect(shell.getAttribute("data-table-id")).toBe("stress-test-results");
    expect(shell.className).toContain("pharos-density-compact");
    expect(table.parentElement?.getAttribute("data-slot")).toBe("table-viewport");
    expect(screen.getByText("Tether")).toBeTruthy();
  });
});

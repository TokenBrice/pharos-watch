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
});

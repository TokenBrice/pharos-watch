// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReserveDriftEntry } from "@shared/types/status/yield-liquidity";
import { makeReserveComposition } from "@shared/types/__tests__/status.test-support";
import { makeHealthyStatusResponse } from "@/test-utils/status-fixtures";
import { CircuitBreakerTable } from "../circuit-breaker-table";
import { MetadataIntegrityCard } from "../metadata-integrity-card";
import { ScoreImpactPanel } from "../score-impact-panel";
import { SystemDiagnostics } from "../system-diagnostics";

describe("CircuitBreakerTable", () => {
  it("does not treat a failed circuit read as an empty registered set", () => {
    render(<CircuitBreakerTable circuits={null} unavailableReason="circuits-read-failed" />);
    expect(screen.getByText("Circuit breaker evidence unavailable (circuits-read-failed).")).toBeTruthy();
    expect(screen.queryByText("No circuit breakers registered")).toBeNull();
  });
});

describe("ScoreImpactPanel", () => {
  it("keeps missing reserve evidence unknown rather than clean or zero", () => {
    const { container } = render(
      <ScoreImpactPanel
        reserveComposition={makeReserveComposition({ status: "unavailable" })}
      />,
    );
    expect(screen.getByText("unavailable")).toBeTruthy();
    expect(screen.queryByText("clean")).toBeNull();
    expect(container.textContent).not.toContain("0.0%");
    expect(screen.getAllByText("Unknown")).toHaveLength(4);
  });
});

describe("MetadataIntegrityCard", () => {
  function makeWarning(index: number): ReserveDriftEntry {
    return {
      coinId: `warning-${index}`,
      liveCollateralScore: 50,
      curatedCollateralScore: 75,
      delta: 25,
    };
  }

  it("discloses the full warning count while initially showing six rows", async () => {
    const warnings = Array.from({ length: 8 }, (_, index) => makeWarning(index + 1));

    render(<MetadataIntegrityCard reserveDrift={warnings} />);

    expect(screen.getByText("8 warnings (6 shown)")).toBeTruthy();
    expect(screen.getByText("warning-6")).toBeTruthy();
    expect(screen.queryByText("warning-7")).toBeNull();

    fireEvent.click(screen.getByText("Show remaining 2 warnings"));

    expect(await screen.findByText("warning-7")).toBeTruthy();
    expect(screen.getByText("warning-8")).toBeTruthy();
  });

  it("distinguishes a clean empty watchlist from an unavailable or failed read", () => {
    const { rerender } = render(<MetadataIntegrityCard reserveDrift={[]} />);
    expect(screen.getByText(/No reserve-score drift above/)).toBeTruthy();
    rerender(<MetadataIntegrityCard reserveDrift={undefined} />);
    expect(screen.getByText(/no zero count is inferred/)).toBeTruthy();
    rerender(<MetadataIntegrityCard reserveDrift={undefined} reserveDriftError={{ code: "reserve_drift_computation_failed", message: "Unavailable" }} />);
    expect(screen.getByText(/Reserve drift loader failed/)).toBeTruthy();
  });
});

describe("SystemDiagnostics discrepancy evidence", () => {
  it("renders unreadable status authority as an unavailable comparison", () => {
    const status = makeHealthyStatusResponse();
    render(<SystemDiagnostics state={status.state} staleness={status.staleness} probe={status.probe}
      discrepancy={{ ...status.discrepancy, statusSeverity: null, severityDelta: null, discrepancyReason: "status-unreadable" }}
      nowSeconds={status.timestamp} />);
    expect(screen.getByText("reason: status authority unreadable")).toBeTruthy();
    expect(screen.getByText(/delta unavailable/)).toBeTruthy();
    expect(screen.queryByText("none")).toBeNull();
  });
  it.each([null, 0, 3])("renders the actual nullable streak (%s)", (streak) => {
    const status = makeHealthyStatusResponse();
    render(<SystemDiagnostics
      state={status.state}
      staleness={status.staleness}
      probe={status.probe}
      discrepancy={{ ...status.discrepancy, consecutiveDivergent: streak }}
      nowSeconds={status.timestamp}
    />);
    expect(screen.getByText(`streak: ${streak ?? "unavailable"}`)).toBeTruthy();
    if (streak == null) expect(screen.queryByText("streak: 0")).toBeNull();
  });
});

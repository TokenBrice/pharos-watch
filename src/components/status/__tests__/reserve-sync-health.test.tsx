// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeReserveComposition } from "@shared/types/__tests__/status.test-support";
import type { StatusResponse } from "@shared/types/status";
import { ReserveSyncHealthCard } from "../reserve-sync-health";

function makeReserveHealth(
  overrides: Partial<Exclude<StatusResponse["reserveComposition"], { status: "unavailable" }>> = {},
): Exclude<StatusResponse["reserveComposition"], { status: "unavailable" }> {
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
  it("does not turn a failed read into zero coverage or healthy sync", () => {
    const { container } = render(
      <ReserveSyncHealthCard health={makeReserveComposition({ status: "unavailable" })} nowSeconds={1_712_600_120} />,
    );
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(container.textContent).not.toContain("0.0%");
    expect(screen.queryByText("healthy")).toBeNull();
    expect(screen.queryByText("Configured")).toBeNull();
  });

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

  it("does not flag conservative inputs for a healthy lane at live 73.7% score-grade coverage", () => {
    // Live 2026-09-22 payload: reserveComposition.status healthy,
    // authoritativeFreshCoverageRatio 0.7374 (>= 0.5 documented floor),
    // no deferred tail, no truncation, no uncertain writes. The banner must
    // match the triage notice and Score impact monitor: no hold.
    const { container } = render(
      <ReserveSyncHealthCard
        health={makeReserveHealth({
          freshCoins: 74,
          degradedCoins: 39,
          errorCoins: 7,
          freshCoverageRatio: 0.7374,
          authoritativeFreshCoverageRatio: 0.7374,
        })}
        nowSeconds={1_712_600_120}
      />,
    );

    expect(screen.queryByText("Report-card inputs are conservative")).toBeNull();
    expect(container.textContent).toContain("73.7% fresh, 73.7% authoritative");
  });

  it("does not label all-cohort counters as part of a fresh-evidence partition", () => {
    render(
      <ReserveSyncHealthCard
        health={makeReserveHealth({
          freshCoins: 250,
          independentFreshUnverified: 8,
          staticValidatedFresh: 60,
          weakProbeFresh: 42,
          independentFreshEligible: 140,
          writeTimeoutUncertain: 1,
        })}
        nowSeconds={1_712_600_120}
      />,
    );

    expect(screen.getByText("Snapshot evidence mix")).toBeTruthy();
    expect(screen.queryByText("Fresh Evidence Mix")).toBeNull();
    expect(screen.getByText("Write-timeout uncertain")).toBeTruthy();
  });

  it("shows the by-design degraded count and keeps pre-split rows unavailable", () => {
    const { container } = render(
      <ReserveSyncHealthCard
        health={makeReserveHealth({
          adapterReliability: [
            { adapterKey: "chainlink-nav", attempts: 10, ok: 4, degraded: 6, degradedByDesign: 5, error: 0, skipped: 0, successRate: 0.9 },
            { adapterKey: "legacy-row", attempts: 2, ok: 2, degraded: 0, error: 0, skipped: 0, successRate: 1 },
          ],
        })}
        nowSeconds={1_712_600_120}
      />,
    );
    const rows = Array.from(container.querySelectorAll("table[aria-label='30-day adapter reliability'] tbody tr"));
    expect(screen.getByText("By design")).toBeTruthy();
    expect(rows[0]?.textContent).toContain("90.0%");
    expect(Array.from(rows[0]!.querySelectorAll("td")).map((cell) => cell.textContent)[4]).toBe("5");
    expect(Array.from(rows[1]!.querySelectorAll("td")).map((cell) => cell.textContent)[4]).toBe("—");
  });
  it.each([
    [{ adapterReliabilityAvailability: { status: "unavailable", reason: "reserve_adapter_reliability_query_failed" } }, "reserve_adapter_reliability_query_failed"],
    [{ adapterReliabilityAvailability: { status: "available" } }, "No attempts in 30 days"],
    [{ configuredCoins: 0, freshCoins: 0, adapterReliabilityAvailability: { status: "available" } }, "No configured adapters"],
    [{}, "History unknown (legacy payload)"],
  ] as const)("names the adapter reliability state before reading empty rows (%#)", (overrides, expected) => {
    const { container } = render(
      <ReserveSyncHealthCard health={makeReserveHealth({ adapterReliability: [], ...overrides })} nowSeconds={1_712_600_120} />,
    );
    expect(screen.getByText("30-day Adapter Reliability")).toBeTruthy();
    expect(screen.getByText(expected)).toBeTruthy();
    expect(container.querySelector("table[aria-label='30-day adapter reliability']")).toBeNull();
  });

  it("keeps failed reliability reads unknown even with retained rows or no configured adapters", () => {
    const { container } = render(
      <ReserveSyncHealthCard
        health={makeReserveHealth({
          configuredCoins: 0,
          freshCoins: 0,
          adapterReliabilityAvailability: { status: "unavailable", reason: "reserve_adapter_reliability_query_failed" },
          adapterReliability: [{ adapterKey: "retained", attempts: 12, ok: 12, degraded: 0, error: 0, skipped: 0, successRate: 1 }],
        })}
        nowSeconds={1_712_600_120}
      />,
    );
    const reliability = screen.getByText("30-day Adapter Reliability").parentElement!;
    expect(screen.getByText("Unavailable · counts unknown")).toBeTruthy();
    expect(screen.getByText("reserve_adapter_reliability_query_failed")).toBeTruthy();
    expect(reliability.querySelector("p")).toBeNull();
    expect(screen.queryByText("No configured adapters")).toBeNull();
    expect(container.querySelector("table[aria-label='30-day adapter reliability']")).toBeNull();
  });
});

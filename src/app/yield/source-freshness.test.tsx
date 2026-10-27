// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { YieldSourceSheet } from "@/components/yield-source-sheet";
import { YieldSourceBoard } from "@/components/yield/yield-source-board";
import { useYieldSourceClock } from "@/hooks/use-yield-source-clock";
import { buildYieldSourceBoardModel } from "@/lib/yield-source-board-model";
import { getYieldRankingSourceClockInputs } from "@/lib/yield-source-explorer-model";
import { deriveYieldRowPresentation } from "@/lib/yield-workbench-row";
import { makeAltYieldSource, makeYieldProvenance, makeYieldRanking } from "@shared/test-utils/yield-ranking-fixtures";
import type { YieldRanking } from "@shared/types";

vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  SheetContent: ({ children }: { children: React.ReactNode }) => <div data-testid="sheet">{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  SheetFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/yield-history-chart", () => ({ YieldHistoryChart: () => <div /> }));
vi.mock("@/components/stablecoin-logo", () => ({ StablecoinLogo: () => <div /> }));
vi.mock("@/components/yield-source-risk-bar", () => ({ YieldSourceRiskBar: () => <div /> }));

const HOUR = 3600;
const ASSESSED_AT = 1_793_000_000;

// Selected: supplemental protocol-api (4h cadence, public gate 48h), 47h old,
// already stale for scoring. Alternate: core defillama-auto (2h cadence, gate
// 24h), 23.5h old. Each crosses at its own instant, apart from the rankings clock.
function makeRanking(): YieldRanking {
  return makeYieldRanking({
    dataSource: "protocol-api",
    yieldSource: "Selected vault",
    provenance: makeYieldProvenance({
      sourceKey: "protocol-api:fixture",
      sourceObservedAt: ASSESSED_AT - 47 * HOUR,
      sourceAgeSeconds: 47 * HOUR,
      sourceFreshness: "stale",
      sourceSwitch: false,
    }),
    sourceRisk: { sourceDepthRatio: 0.02, venueRiskTier: "low", sourceRiskPenalty: 1, sourceAgeSeconds: 47 * HOUR },
    sourceTvlUsd: 50_000_000,
    warningSignals: ["data-stale"],
    altSources: [makeAltYieldSource({
      sourceKey: "defillama-auto:alt",
      yieldSource: "Alternate pool",
      dataSource: "defillama-auto",
      sourceRisk: { sourceDepthRatio: 0.02, venueRiskTier: "low", sourceAgeSeconds: 23.5 * HOUR },
    })],
  });
}

function Harness({ ranking }: { ranking: YieldRanking }) {
  const sources = useMemo(() => getYieldRankingSourceClockInputs(ranking), [ranking]);
  const clock = useYieldSourceClock(sources, ASSESSED_AT);
  const model = useMemo(() => buildYieldSourceBoardModel([ranking], clock), [clock, ranking]);
  const row = deriveYieldRowPresentation(ranking, clock);
  return (
    <TooltipProvider>
      <span data-testid="row-freshness">{row.freshness?.displayText}</span>
      <YieldSourceBoard model={model} />
      <YieldSourceSheet ranking={ranking} logo={undefined} riskFreeRate={0.02} medianApy={0.03} sourceClock={clock} open onOpenChange={vi.fn()} />
    </TooltipProvider>
  );
}

describe("yield source-age freshness boundaries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(ASSESSED_AT * 1000);
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("crosses each source's public gate on its own clock without a refetch or manual rerender", () => {
    const ranking = makeRanking();
    render(<Harness ranking={ranking} />);
    const advanceTo = (ms: number) => act(() => { vi.advanceTimersByTime(ms - Date.now()); });
    // Hydration (two animation frames) plus the boundary hook's post-commit re-anchor.
    advanceTo(ASSESSED_AT * 1000 + 100);
    const sheet = within(screen.getByTestId("sheet"));
    const board = within(screen.getByRole("region", { name: /Source mix/ }));
    const posture = () => board.getByLabelText(/^Speculative: 1\./);

    // Below the public gate: neutral age, qualified posture, no stale driver.
    expect(screen.getByTestId("row-freshness").textContent).toBe("Observed 1d ago");
    expect(sheet.getByText("Speculative (scoring window)")).toBeTruthy();
    expect(sheet.queryByText("stale source")).toBeNull();
    expect(sheet.getByText("No source-risk drivers shown.")).toBeTruthy();
    expect(board.getByText("No source-risk drivers shown.")).toBeTruthy();
    expect(posture().getAttribute("aria-label")).toContain("Speculative: 1 source, 1 due only to the scoring window.");

    // The alternate crosses first (24h gate, 30 minutes away).
    fireEvent.click(sheet.getByRole("button", { name: /Alternate pool/ }));
    expect(sheet.getAllByText("Observed 23h ago").length).toBeGreaterThan(0);
    advanceTo((ASSESSED_AT + 0.5 * HOUR) * 1000 + 1);
    expect(sheet.getAllByText("Stale · 1d ago").length).toBeGreaterThan(0);
    expect(sheet.getByText("stale source")).toBeTruthy();
    // The selected source has not crossed yet.
    expect(screen.getByTestId("row-freshness").textContent).toBe("Observed 1d ago");
    expect(board.getByText("No source-risk drivers shown.")).toBeTruthy();

    // Exactly at the selected gate (48h) stays neutral; +1ms warns everywhere.
    advanceTo((ASSESSED_AT + HOUR) * 1000);
    expect(screen.getByTestId("row-freshness").textContent).toMatch(/^Observed /);
    advanceTo((ASSESSED_AT + HOUR) * 1000 + 1);
    expect(screen.getByTestId("row-freshness").textContent).toBe("Stale · 2d ago");
    expect(board.getByText("stale source")).toBeTruthy();
    // Posture membership and counts are unchanged; only the qualification drops.
    expect(posture().getAttribute("aria-label")).not.toContain("scoring window");
    // The sheet header follows the selected source's own crossing.
    expect(sheet.getAllByText("Stale · 2d ago").length).toBeGreaterThan(0);
  });
});

// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlowSummaryCard } from "@/components/mint-burn/flow-summary-card";
import { makeInactiveMintBurnFlowCoin, makeMintBurnCoinValuation, makeMintBurnFlowCoin } from "@/test-utils/mint-burn-fixtures";
import type { ApiMeta } from "@/lib/api";

afterEach(() => vi.useRealTimers());
vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => true }));

const useMintBurnFlowsMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-mint-burn-flows", () => ({
  useMintBurnFlows: useMintBurnFlowsMock,
}));

const missing = { complete: false, unavailableReason: "scan-coverage-incomplete" } as const;

const mockFlows = (data: unknown) =>
  useMintBurnFlowsMock.mockReturnValue({ data, dataUpdatedAt: 1_700_000_000_000, error: null, isLoading: false, refetch: vi.fn() });

describe("FlowSummaryCard", () => {
  it.each([false, true])("qualifies incomplete windows as partial (established leg=%s)", (established) => {
    mockFlows({
      coins: [
        makeMintBurnFlowCoin({
          coverage: {
            startBlock: 1, lastSyncedBlock: 2, lagBlocks: 0, historyStartAt: 1_700_000_000,
            has24hWindow: !established, has7dWindow: !established, has30dWindow: false, has90dWindow: !established,
            ...(established ? { windows: { window24h: missing, window7d: missing, window30d: missing, window90d: missing } } : {}),
            isPartial: true,
            status: "partial-history",
          },
        }),
      ],
    });

    render(<FlowSummaryCard stablecoinId="usdc-circle" />);

    if (established) {
      expect(screen.getAllByText("partial")).toHaveLength(4);
      expect(screen.getByText("−$3.00M")).toBeTruthy();
    } else expect(screen.getByText("partial")).toBeTruthy();
    expect(
      screen.getByTitle("30-day window is incomplete; value reflects the covered portion only."),
    ).toBeTruthy();
    if (!established) expect(screen.queryByTitle(/90-day window is incomplete/)).toBeNull();
  });

  it.each(["partial", "unknown"] as const)("withholds the dial and exact baseline for %s classification", (completeness) => {
    const classification = { completeness, mintCompleteness: "complete" as const, burnCompleteness: completeness,
      unresolvedMintEventCount: 0, unresolvedBurnEventCount: completeness === "partial" ? 1 : 0,
      unavailableReason: completeness === "partial" ? "classification-unresolved" as const : "classification-unknown" as const };
    mockFlows({ coins: [makeMintBurnFlowCoin({ classification: {
      window24h: classification, baseline: classification, netFlow7d: classification,
      netFlow30d: classification, netFlow90d: classification,
    } })] });
    const { container } = render(<FlowSummaryCard stablecoinId="usdc-circle" />);
    expect(screen.getByText("Direction unavailable")).toBeTruthy();
    expect(container.querySelector(`[data-reason-codes="${classification.unavailableReason}"]`)).toBeTruthy();
    expect(screen.queryByRole("img", { name: /mint and burn balance/ })).toBeNull();
    expect(container.textContent).not.toContain("+$1.00M");
    expect(container.textContent).not.toContain("−$3.00M");
    expect(container.textContent).toMatch(/classification/i);
    // Withheld nets get no tile and no placeholder; one quiet line names them.
    expect(screen.queryByRole("list", { name: /Net mint minus burn/ })).toBeNull();
    expect(container.querySelector('[aria-label="Net mint minus burn by window"]')).toBeNull();
    expect(container.textContent).not.toContain("—");
    expect(container.querySelector("[data-flow-gap-note]")?.textContent).toMatch(/24h, 7d, 30d, and 90d nets withheld: /);
  });

  it("renders a partial 24h window as unavailable instead of a burning net and pressure reading", () => {
    mockFlows({
      coins: [
        makeMintBurnFlowCoin({
          valuation: makeMintBurnCoinValuation(
            { completeness: "partial", mintCompleteness: "partial", unpricedMintEventCount: 4 },
            { baseline: "partial" },
          ),
        }),
      ],
    });

    const { container } = render(<FlowSummaryCard stablecoinId="usdc-circle" />);

    expect(container.textContent).toContain("≥ −$3.00M");
    expect(container.textContent?.replaceAll("≥ −$3.00M", "")).not.toContain("−$3.00M");
    expect(screen.queryByText("Burning")).toBeNull();
    expect(screen.queryByText("Flat")).toBeNull();
    expect(screen.getByText("Direction unavailable")).toBeTruthy();
    expect(screen.getAllByText(/Lower bound: 4 mint \/ 0 burn events unpriced; unpriced mints can only raise the net/).length)
      .toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/[-−]42/);
    expect(screen.getByText(/pressure shift unavailable/i)).toBeTruthy();
    expect(container.textContent).not.toContain("+$1.00M");
    expect(screen.getByText(/Balance not shown\. 4 mint \/ 0 burn events unpriced in the last 24h, so the volumes are lower bounds/i)).toBeTruthy();
    expect(container.querySelector('[data-reason-codes="valuation-partial"]')).toBeTruthy();
    expect(screen.queryByRole("img", { name: /mint and burn balance/ })).toBeNull();
    expect(container.textContent).toContain("−$5.00M");
  });

  it.each([null, true])("withholds a literal dial for an unavailable scan window (activity=%s)", (has24hActivity) => {
    mockFlows({
      coins: [makeMintBurnFlowCoin({
        has24hActivity,
        netFlowDirection24h: null,
        pressureShiftScore: null,
        pressureShiftState: "nr",
        netFlow24hUsd: null,
        netFlow7dUsd: null,
        netFlow30dUsd: null,
        netFlow90dUsd: null,
        mintVolume24hUsd: 100,
        burnVolume24hUsd: 50,
        mintCount24h: 0,
        burnCount24h: 0,
        valuation: makeMintBurnCoinValuation({ completeness: "partial", mintCompleteness: "partial", unpricedMintEventCount: 1 }),
        coverage: { startBlock: 1, lastSyncedBlock: 2, lagBlocks: 0, historyStartAt: null,
          has24hWindow: false, has30dWindow: false, has90dWindow: false, isPartial: true, status: "unknown",
          windows: {
            window24h: missing,
            window7d: missing,
            window30d: missing,
            window90d: missing,
          } },
      })],
    });
    const { container } = render(<FlowSummaryCard stablecoinId="usdc-circle" />);
    expect(screen.getByText("Direction unavailable")).toBeTruthy();
    expect(container.querySelector('[data-reason-codes="window-unavailable"]')).toBeTruthy();
    expect(screen.queryByRole("img", { name: /mint and burn balance/ })).toBeNull();
    expect(container.textContent).not.toMatch(/No priced mint or burn volume/);
    expect(container.textContent).not.toContain("−$3.00M");
    expect(container.textContent).not.toContain("−$5.00M");
  });

  it.each([
    { score: -42, state: "worsening" as const, clause: "more burning than its 30\u2011day baseline", amber: true },
    { score: 4, state: "stable" as const, clause: "close to its 30\u2011day baseline", amber: false },
  ])("draws a neutral signed balance bar and a plain verdict ($state)", ({ score, state, clause, amber }) => {
    mockFlows({ coins: [makeMintBurnFlowCoin({
      pressureShiftScore: score,
      pressureShiftState: state,
      gaugeWeightUsd: 100_000_000,
      windowStartSupplyUsd: {
        window24h: 100_000_000,
        window7d: 105_000_000,
        window30d: 108_000_000,
        window90d: null,
      },
      valuation: makeMintBurnCoinValuation({}, { netFlow90d: "unknown" }),
    })] });
    const { container } = render(<FlowSummaryCard stablecoinId="usdc-circle" />);
    const bar = screen.getByRole("img", { name: "24h mint and burn balance: 80% of volume burned, 20% minted" });
    expect(bar.querySelector(".bg-state-warn-solid") != null).toBe(amber);
    // The sentence names the direction; the 24h figure lives once, in its tile.
    expect(container.textContent).toContain(`Net burning over 24h, ${clause}.`);
    expect(container.textContent?.split("−$3.00M")).toHaveLength(2);
    // "30-day" never breaks at its hyphen.
    expect(container.textContent).not.toContain("30-day baseline");
    // The pressure figure carries its meaning and scale in words.
    expect(container.textContent).toContain(`${amber ? "More outflow than usual" : "Within its usual range"} · ±100 scale`);
    expect(container.textContent).toContain("Burned $4.00M");
    expect(container.textContent).toContain("Minted $1.00M");
    // Direction tones the chip and the signed nets; the 90d asterisk is spelled out.
    expect(screen.getByText("Burning").closest("span")?.className).toContain("text-red-700");
    expect(screen.getAllByText("−$3.00M")[0]!.className).toContain("text-red-700");
    expect(screen.getByText("−3.00% of supply")).toBeTruthy();
    expect(screen.getByTitle(/90-day tracked-chain start supply is unavailable/)).toBeTruthy();
    expect(container.textContent).toContain("Supply shares use tracked-chain supply at each window's start");
    expect(container.textContent).toMatch(/\* Includes hours recorded before pricing checks began/);
    expect(container.textContent).not.toMatch(/\bNR\b/);
  });

  it("uses window-start tracked-chain supply for large contractions (USDS-like) and withholds 90d*", () => {
    mockFlows({ coins: [makeMintBurnFlowCoin({
      stablecoinId: "usds-sky",
      symbol: "USDS",
      pressureShiftScore: 26,
      pressureShiftState: "improving",
      netFlowDirection24h: "minting",
      gaugeWeightUsd: 3_217_038_523,
      windowStartSupplyUsd: {
        window24h: 3_098_830_292,
        window7d: 5_347_528_879,
        window30d: 6_729_591_624,
        window90d: null,
      },
      netFlow24hUsd: 9_014_020,
      mintVolume24hUsd: 198_610_820,
      burnVolume24hUsd: 189_596_800,
      netFlow7dUsd: -2_005_233_746,
      netFlow30dUsd: -3_610_299_466,
      netFlow90dUsd: -3_424_521_682,
      valuation: makeMintBurnCoinValuation({}, { netFlow90d: "unknown" }),
    })] });
    const { container } = render(<FlowSummaryCard stablecoinId="usds-sky" />);
    expect(screen.getByText("+0.29% of supply")).toBeTruthy();
    expect(screen.getByText("−37.50% of supply")).toBeTruthy();
    expect(screen.getByText("−53.65% of supply")).toBeTruthy();
    // Never divides by current tracked-chain supply ($3.22B → −112.22% / −106.45%).
    expect(container.textContent).not.toContain("112.22%");
    expect(container.textContent).not.toContain("106.45%");
    expect(screen.getByTitle("90-day tracked-chain start supply is unavailable and this window includes hours before pricing checks began.")).toBeTruthy();
    expect(container.textContent).toContain("Supply shares use tracked-chain supply at each window's start; — marks windows without complete valuation or start-supply history.");
  });

  it("uses window-start tracked-chain supply for growing coins (higher % than current-supply basis)", () => {
    mockFlows({ coins: [makeMintBurnFlowCoin({
      stablecoinId: "u-united-stables",
      symbol: "U",
      pressureShiftScore: 18,
      pressureShiftState: "improving",
      netFlowDirection24h: "minting",
      gaugeWeightUsd: 511_621_104,
      windowStartSupplyUsd: {
        window24h: 506_621_398,
        window7d: 498_121_897,
        window30d: 447_624_768,
        window90d: null,
      },
      netFlow24hUsd: 5_000_038,
      mintVolume24hUsd: 5_000_038,
      burnVolume24hUsd: 0,
      netFlow7dUsd: 10_497_614,
      netFlow30dUsd: 62_956_448,
      netFlow90dUsd: 287_063_569,
      valuation: makeMintBurnCoinValuation({}, { netFlow90d: "unknown" }),
    })] });
    render(<FlowSummaryCard stablecoinId="u-united-stables" />);
    expect(screen.getByText("+0.99% of supply")).toBeTruthy();
    expect(screen.getByText("+2.11% of supply")).toBeTruthy();
    expect(screen.getByText("+14.06% of supply")).toBeTruthy();
    expect(screen.getByTitle(/90-day tracked-chain start supply is unavailable/)).toBeTruthy();
  });

  it("renders unavailable shares (—) for missing history, zero start supply, and unknown valuation without falling back to current supply", () => {
    mockFlows({ coins: [makeMintBurnFlowCoin({
      gaugeWeightUsd: 100_000_000,
      windowStartSupplyUsd: {
        window24h: 0,
        window7d: null,
        window30d: 80_000_000,
        window90d: null,
      },
      valuation: makeMintBurnCoinValuation({}, { netFlow30d: "unknown", netFlow90d: "complete" }),
    })] });
    const { container } = render(<FlowSummaryCard stablecoinId="usdc-circle" />);
    expect(screen.getByTitle("Tracked-chain supply at the start of the 24-hour window was zero, so share is undefined.")).toBeTruthy();
    expect(screen.getByTitle("7-day window-start tracked-chain supply is unavailable.")).toBeTruthy();
    expect(screen.getByTitle("Includes hours recorded before pricing checks began; share of window-start supply is unavailable.")).toBeTruthy();
    expect(screen.getByTitle("90-day window-start tracked-chain supply is unavailable.")).toBeTruthy();
    expect(container.textContent).not.toContain("% of supply");
    expect(container.textContent).toContain("Supply shares (—) require complete valuation and tracked-chain supply at each window's start.");
  });

  it("collapses a quiet coin to plain lines without zeros, NR or an illustration", () => {
    mockFlows({ coins: [makeInactiveMintBurnFlowCoin({
      baselineDailyNetUsd: 0,
      baselineDataDays: 30,
      netFlow30dUsd: 0,
      netFlow90dUsd: 495_710_000,
      gaugeWeightUsd: 3_111_000_000,
      windowStartSupplyUsd: {
        window24h: 3_111_000_000,
        window7d: 3_111_000_000,
        window30d: 3_111_000_000,
        window90d: null,
      },
      valuation: makeMintBurnCoinValuation(),
    })] });
    const { container } = render(<FlowSummaryCard stablecoinId="usdc-circle" />);
    expect(container.textContent).toContain("No mints or burns in the last 24 hours, and no net supply change over 30 days.");
    expect(container.textContent).toContain("90-day net: +$495.71M");
    expect(container.textContent).not.toContain("15.93%");
    // One sentence needs no status chip or leaderboard link beside it.
    expect(screen.queryByText("No activity")).toBeNull();
    expect(screen.queryByRole("link", { name: /View all flows/ })).toBeNull();
    expect(container.textContent).not.toContain("$0.00");
    expect(container.textContent).not.toMatch(/\bNR\b/);
    expect(container.textContent).not.toMatch(/usual|baseline/);
    expect(screen.queryByText("24h net")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });
});

it.each([
  { meta: { updatedAt: Math.floor(Date.now() / 1000) - 86_400, status: "fresh" }, state: "stale" },
  { meta: { updatedAt: null, status: "unknown", ageSeconds: null }, state: "unavailable" },
  { meta: { updatedAt: Math.floor(Date.now() / 1000), status: "fresh", warning: "Flow source incomplete" }, state: null },
] as { meta: ApiMeta; state: string | null }[])("retains the admitted flow generation across receipts and errors ($state)", ({ meta, state }) => {
  const receipt = Date.now();
  const query = {
    data: { coins: [makeMintBurnFlowCoin()] },
    meta, dataUpdatedAt: receipt, error: null, isLoading: false, refetch: vi.fn(),
  };
  useMintBurnFlowsMock.mockReturnValue(query);
  const { container, rerender } = render(<FlowSummaryCard stablecoinId="usdc-circle" />);
  const producerTime = meta.updatedAt != null ? new Date(meta.updatedAt * 1000).toISOString() : null;
  expect(container.querySelector("time")?.getAttribute("datetime")).toBe(producerTime);
  if (state) expect(container.querySelector(`[data-health-state="${state}"]`)).toBeTruthy();
  else expect(container.querySelector("[data-health-state]")).toBeNull();
  useMintBurnFlowsMock.mockReturnValue({ ...query, dataUpdatedAt: receipt + 30_000 });
  rerender(<FlowSummaryCard stablecoinId="usdc-circle" />);
  expect(container.querySelector("time")?.getAttribute("datetime")).toBe(producerTime);
  useMintBurnFlowsMock.mockReturnValue({ ...query, error: new Error("refresh failed") });
  rerender(<FlowSummaryCard stablecoinId="usdc-circle" />);
  expect(container.querySelector("time")?.getAttribute("datetime")).toBe(producerTime);
  expect(screen.queryByText(/refresh failed/i)).toBeNull();
});

it("does not attribute the aggregate FTQ dependency to coin flow totals", () => {
  const receipt = Date.now();
  useMintBurnFlowsMock.mockReturnValue({
    data: { coins: [makeMintBurnFlowCoin()], sync: { classificationWarning: "FTQ classification unavailable" } },
    meta: {
      updatedAt: Math.floor(receipt / 1000), status: "fresh",
      warning: '199 - "FTQ classification unavailable"',
      dependencies: { flightToQuality: { status: "unavailable", reason: "ratings-old" } },
    },
    dataUpdatedAt: receipt, error: null, isLoading: false, refetch: vi.fn(),
  });
  const { container } = render(<FlowSummaryCard stablecoinId="usdc-circle" />);
  expect(container.querySelector("[data-health-state]")).toBeNull();
  expect(container.querySelector("time")?.getAttribute("datetime"))
    .toBe(new Date(Math.floor(receipt / 1000) * 1000).toISOString());
});

it("ages saved flow metadata to stale without refetching, skipping the delayed band", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
  const receipt = Date.now();
  useMintBurnFlowsMock.mockReturnValue({
    data: { coins: [makeMintBurnFlowCoin()] }, dataUpdatedAt: receipt, error: null, isLoading: false,
    meta: { updatedAt: receipt / 1000, status: "fresh", freshBudgetSec: 60, degradedBudgetSec: 120 },
    refetch: vi.fn(),
  });
  const { container } = render(<FlowSummaryCard stablecoinId="usdc-circle" />);
  expect(container.querySelector("[data-health-state]")).toBeNull();
  act(() => vi.advanceTimersByTime(50));
  act(() => vi.advanceTimersByTime(60_001));
  expect(container.querySelector("[data-health-state]")).toBeNull();
  act(() => vi.advanceTimersByTime(60_000));
  expect(container.querySelector('[data-health-state="stale"]')).toBeTruthy();
  expect(container.querySelector("time")?.getAttribute("datetime")).toBe(new Date(receipt).toISOString());
});

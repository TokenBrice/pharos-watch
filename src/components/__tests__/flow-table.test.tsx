import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FlowTable } from "@/components/flow-table";
import { makeMintBurnCoinValuation } from "@/test-utils/mint-burn-fixtures";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/lib/logos", () => ({
  logosById: {},
}));

vi.mock("@/hooks/use-prefetch-stablecoin", () => ({
  usePrefetchStablecoin: () => vi.fn(),
}));

const coin = {
  stablecoinId: "usdt-tether",
  symbol: "USDT",
  pressureShiftScore: -18,
  pressureShiftState: "worsening" as const,
  netFlowDirection24h: "burning" as const,
  has24hActivity: true,
  baselineDailyNetUsd: 0,
  baselineDailyAbsUsd: 10_000_000,
  baselineDataDays: 14,
  netFlow24hUsd: -12_000_000,
  mintVolume24hUsd: 8_000_000,
  burnVolume24hUsd: 20_000_000,
  mintCount24h: 4,
  burnCount24h: 6,
  netFlow7dUsd: -15_000_000,
  netFlow30dUsd: -30_000_000,
  netFlow90dUsd: -45_000_000,
  largestEvent24h: null,
  coverage: {
    startBlock: 21_900_000,
    lastSyncedBlock: 22_000_000,
    lagBlocks: 0,
    historyStartAt: 1_700_000_000,
    has24hWindow: true,
    has30dWindow: false,
    has90dWindow: false,
    isPartial: true,
    status: "partial-history" as const,
  },
};

describe("FlowTable", () => {
  it("labels colliding tickers by registry identity even when only one collision member is shown", () => {
    const html = renderToStaticMarkup(<FlowTable coins={[{ ...coin, stablecoinId: "ousd-open-standard", symbol: "OUSD" }]} isLoading={false} />);
    expect(html).toContain("OUSD (Open USD)");
    expect(html).toContain('aria-label="Open OUSD (Open USD) flow detail"');
  });

  it("renders coverage badge and partial long-window indicators", () => {
    const html = renderToStaticMarkup(<FlowTable coins={[coin]} isLoading={false} />);

    expect(html).toContain("Partial history");
    expect((html.match(/partial/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("renders a burn-side partial 24h net as an upper bound and its incomplete volume as a lower bound", () => {
    const partialCoin = {
      ...coin,
      valuation: {
        window24h: {
          completeness: "partial" as const,
          mintCompleteness: "complete" as const,
          burnCompleteness: "partial" as const,
          unpricedMintEventCount: 0,
          unpricedBurnEventCount: 3,
        },
        baseline: "complete" as const,
        netFlow7d: "partial" as const,
        netFlow30d: "complete" as const,
        netFlow90d: "complete" as const,
      },
    };
    const html = renderToStaticMarkup(<FlowTable coins={[partialCoin]} isLoading={false} />);

    // Only burns are unpriced, so the known net is a ceiling: shown as "≤", never as the net itself.
    expect(html).toContain("≤ -$12.00M");
    expect(html.replaceAll("≤ -$12.00M", "")).not.toContain("-$12.00M");
    expect(html).not.toContain("-$15.00M");
    expect(html).toContain("Upper bound: 0 mint / 3 burn events unpriced; unpriced burns can only lower the net");
    expect(html).toContain("≥ $20.00M");
    expect(html).not.toContain("≥ $8.00M");
    expect(html).toContain("-$30.00M");
  });

  it("renders a null net as unavailable instead of $0", () => {
    const html = renderToStaticMarkup(
      <FlowTable coins={[{ ...coin, netFlow24hUsd: null, netFlowDirection24h: null }]} isLoading={false} />,
    );

    expect(html).not.toContain("$0.00");
    expect(html).toContain("Signed net unavailable");
  });

  it("retains unknown scan activity in the default table instead of hiding it as idle", () => {
    const unknown = {
      ...coin,
      has24hActivity: null,
      netFlowDirection24h: null,
      pressureShiftScore: null,
      pressureShiftState: "nr" as const,
      mintVolume24hUsd: 0,
      burnVolume24hUsd: 0,
      mintCount24h: 0,
      burnCount24h: 0,
      netFlow24hUsd: null,
      netFlow7dUsd: null,
      netFlow30dUsd: null,
      netFlow90dUsd: null,
      valuation: makeMintBurnCoinValuation(),
    };
    const html = renderToStaticMarkup(
      <FlowTable coins={[unknown, { ...unknown, stablecoinId: "usdc-circle", symbol: "USDC", has24hActivity: false, netFlow24hUsd: 0 }]} isLoading={false} />,
    );
    expect(html).toContain('aria-label="Open USDT flow detail"');
    expect(html).not.toContain('aria-label="Open USDC flow detail"');
    expect(html).toContain('data-reason-codes="activity-unknown"');
    expect(html).toContain("signed net unavailable");
  });

  it("ranks worst pressure against the 30-day norm first, with NR last", () => {
    const html = renderToStaticMarkup(
      <FlowTable
        coins={[
          { ...coin, stablecoinId: "usdc-circle", symbol: "USDC", pressureShiftScore: 12, pressureShiftState: "improving" },
          { ...coin, stablecoinId: "dai-makerdao", symbol: "DAI", pressureShiftScore: null, pressureShiftState: "nr" },
          { ...coin, stablecoinId: "usdt-tether", symbol: "USDT", pressureShiftScore: -60, pressureShiftState: "worsening" },
        ]}
        isLoading={false}
      />,
    );

    const order = ["USDT", "USDC", "DAI"].map((symbol) => html.indexOf(`Open ${symbol} flow detail`));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("names coverage-unknown nets once per column instead of a * on each cell", () => {
    // A payload without `valuation` is coverage-unknown on every window.
    const html = renderToStaticMarkup(<FlowTable coins={[coin]} isLoading={false} />);

    expect((html.match(/data-reason-codes="valuation-unknown"/g) ?? []).length).toBe(4);
    expect(html).toContain("Unverified");
    expect(html).not.toMatch(/align-super[^>]*>\*</);
    // The per-cell reason stays available to assistive tech.
    expect(html).toContain("(coverage unknown)");
  });
});

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FlowTable } from "@/components/flow-table";

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

  it("renders a partial 24h net as unavailable and its incomplete volume as a lower bound", () => {
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

    expect(html).not.toContain("-$12.00M");
    expect(html).not.toContain("-$15.00M");
    expect(html).toContain("0 mint / 3 burn events unpriced; signed net unavailable");
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
});

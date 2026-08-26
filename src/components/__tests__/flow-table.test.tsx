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
  flowIntensity: -18,
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
  it("renders coverage badge and partial long-window indicators", () => {
    const html = renderToStaticMarkup(<FlowTable coins={[coin]} isLoading={false} />);

    expect(html).toContain("Partial history");
    expect((html.match(/partial/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

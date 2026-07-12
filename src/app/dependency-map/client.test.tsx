// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportCard } from "@shared/types";
import { useReportCards } from "@/hooks/api-hooks";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import { logosById } from "@/lib/logos";

vi.mock("@/hooks/api-hooks", () => ({
  useReportCards: vi.fn(),
}));

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: vi.fn(),
}));

vi.mock("@/hooks/use-logos", () => ({
  useLogos: vi.fn(),
}));

vi.mock("@/components/contagion-graph", () => ({
  ContagionGraph: () => <div data-testid="dependency-graph">graph</div>,
}));

vi.mock("@/components/dependency-map-mobile-summary", () => ({
  DependencyMapMobileSummary: ({ model }: { model: { hubs: readonly unknown[] } }) => (
    <div data-testid="mobile-summary">summary:{model.hubs.length}</div>
  ),
}));

vi.mock("./dependency-hubs-board", () => ({
  DependencyHubsBoard: ({ model }: { model: { hubs: readonly unknown[] } }) => (
    <div data-testid="dependency-hubs-board">board:{model.hubs.length}</div>
  ),
}));

const { DependencyMapClient } = await import("@/app/dependency-map/client");

const mockUseReportCards = vi.mocked(useReportCards);
const mockUseStablecoins = vi.mocked(useStablecoins);
const mockUseLogos = vi.mocked(useLogos);

function makeQueryResult(data: unknown) {
  return {
    data,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  };
}

const REPORT_CARDS = [
  { id: "usdc-circle", symbol: "USDC", isDefunct: false },
  { id: "usdt-tether", symbol: "USDT", isDefunct: false },
  { id: "dai-maker", symbol: "DAI", isDefunct: false },
] as unknown as ReportCard[];

describe("DependencyMapClient", () => {
  beforeEach(() => {
    mockUseReportCards.mockReset();
    mockUseStablecoins.mockReset();
    mockUseLogos.mockReset();

    mockUseReportCards.mockReturnValue(
      makeQueryResult({ cards: REPORT_CARDS }) as unknown as ReturnType<typeof useReportCards>,
    );
    mockUseStablecoins.mockReturnValue(
      makeQueryResult({
        peggedAssets: [
          { id: "usdc-circle", circulating: { usd: 77_700_000_000 } },
          { id: "usdt-tether", circulating: { usd: 143_000_000_000 } },
          { id: "dai-maker", circulating: { usd: 5_300_000_000 } },
        ],
      }) as unknown as ReturnType<typeof useStablecoins>,
    );
    mockUseLogos.mockReturnValue({ data: logosById });
  });

  it("does not wrap the graph in a mobile-hidden container", () => {
    const { container } = render(<DependencyMapClient />);

    expect(screen.getByTestId("dependency-graph")).toBeTruthy();
    expect(screen.getByTestId("dependency-hubs-board")).toBeTruthy();
    expect(screen.getByTestId("mobile-summary")).toBeTruthy();
    expect(container.querySelector(".hidden.md\\:block")).toBeNull();
  });
});

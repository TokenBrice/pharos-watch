// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";
import { useReportCardsV9 } from "@/hooks/api-hooks";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import { logosById } from "@/lib/logos";

vi.mock("@/hooks/api-hooks", () => ({
  useReportCardsV9: vi.fn(),
}));

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: vi.fn(),
}));

vi.mock("@/hooks/use-logos", () => ({
  useLogos: vi.fn(),
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

const mockUseReportCardsV9 = vi.mocked(useReportCardsV9);
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

describe("DependencyMapClient", () => {
  beforeEach(() => {
    mockUseReportCardsV9.mockReset();
    mockUseStablecoins.mockReset();
    mockUseLogos.mockReset();

    mockUseReportCardsV9.mockReturnValue(
      makeQueryResult(makeReportCardsV9Response({
        cards: [
          makeV9Card({ id: "usdc-circle" }),
          makeV9Card({ id: "usdt-tether" }),
          makeV9Card({ id: "dai-makerdao" }),
        ],
      })) as unknown as ReturnType<typeof useReportCardsV9>,
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

  it("renders the V9 dependency summaries without the legacy V8 graph", () => {
    const { container } = render(<DependencyMapClient />);

    expect(screen.queryByTestId("dependency-graph")).toBeNull();
    expect(screen.getByTestId("dependency-hubs-board")).toBeTruthy();
    expect(screen.getByTestId("mobile-summary")).toBeTruthy();
    expect(container.querySelector(".hidden.md\\:block")).toBeNull();
  });
});

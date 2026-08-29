// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import YieldAnalysisClient from "@/components/stablecoin-detail/yield-analysis-client";
import { makeYieldDetailRanking, makeYieldDetailResponse } from "@/components/__tests__/yield-detail.test-support";
import type { StablecoinStaticMeta } from "@/lib/stablecoin-static-meta";
import type { YieldRanking, YieldRankingsResponse } from "@shared/types";

const { useYieldRankingsMock, useYieldHistoryMock, replaceParamsMock } = vi.hoisted(() => ({
  useYieldRankingsMock: vi.fn(),
  useYieldHistoryMock: vi.fn(),
  replaceParamsMock: vi.fn(),
}));

let sourcesParam = "";

vi.mock("next/dynamic", () => {
  let callIndex = 0;
  return {
    default: () => {
      const testId = callIndex++ === 0 ? "yield-history-chart" : "yield-change-attribution";
      return function DynamicYieldSection(props: {
        availableSources?: Array<{ sourceKey: string }>;
        externalSourceKeys?: string[];
        benchmarkRate?: number;
        medianApy?: number;
      }) {
        return (
          <div
            data-testid={testId}
            data-available-sources={(props.availableSources ?? []).map((source) => source.sourceKey).join(",")}
            data-external-source-keys={(props.externalSourceKeys ?? []).join(",")}
            data-benchmark-rate={props.benchmarkRate}
            data-median-apy={props.medianApy}
          />
        );
      };
    },
  };
});

vi.mock("@/hooks/api-hooks", () => ({
  useYieldRankings: useYieldRankingsMock,
  useYieldHistory: useYieldHistoryMock,
}));

vi.mock("@/hooks/use-url-filters", () => ({
  useUrlFilters: () => ({
    getParam: (key: string) => (key === "sources" ? sourcesParam : ""),
    replaceParams: replaceParamsMock,
  }),
}));

vi.mock("@/components/pys-breakdown", () => ({
  PysBreakdown: ({ scalingFactor }: { scalingFactor: number }) => (
    <div data-testid="pys-breakdown" data-scaling-factor={scalingFactor} />
  ),
}));

vi.mock("@/components/yield-source-risk-card", () => ({
  YieldSourceRiskCard: () => <div data-testid="yield-source-risk-card" />,
}));

function makeRanking(overrides: Partial<YieldRanking> = {}): YieldRanking {
  return makeYieldDetailRanking({
    id: "usdn-smardex",
    symbol: "USDN",
    name: "SMARDEX USDN",
    benchmarkLabel: "SOFR",
    benchmarkRate: undefined,
    benchmarkSelectionMode: "fallback-usd",
    benchmarkIsFallback: true,
    ...overrides,
  });
}

function makeResponse(rankings: YieldRanking[] = []): YieldRankingsResponse {
  return makeYieldDetailResponse(rankings);
}

function staticCoin(
  id: string,
  name: string,
  symbol: string,
  yieldBearing: boolean,
): StablecoinStaticMeta {
  return {
    id,
    name,
    symbol,
    flags: {
      backing: "crypto-backed",
      pegCurrency: "USD",
      governance: "centralized",
      yieldBearing,
      rwa: false,
      navToken: false,
    },
    hasCollateralUsage: false,
  };
}

function setRankingsQuery(overrides: Record<string, unknown> = {}) {
  useYieldRankingsMock.mockReturnValue({
    data: makeResponse([]),
    meta: null,
    error: null,
    isLoading: false,
    ...overrides,
  });
}

describe("YieldAnalysisClient", () => {
  beforeEach(() => {
    sourcesParam = "";
    replaceParamsMock.mockReset();
    useYieldRankingsMock.mockReset();
    useYieldHistoryMock.mockReset();
    useYieldHistoryMock.mockReturnValue({
      data: { current: null, history: [], methodology: { version: "v8.14" } },
      error: null,
      isLoading: false,
    });
  });

  it("renders the ready workbench from the shared model and filters URL sources", () => {
    sourcesParam = " stale-source , alt-source ";
    setRankingsQuery({ data: makeResponse([makeRanking()]) });

    render(
      <YieldAnalysisClient
        id="usdn-smardex"
        staticCoin={staticCoin("usdn-smardex", "SMARDEX USDN", "USDN", true)}
      />,
    );

    expect(screen.getByRole("link", { name: "Back to USDN detail" })).toBeTruthy();
    expect(screen.getByTestId("pys-breakdown").getAttribute("data-scaling-factor")).toBe("8");
    expect(screen.getByTestId("yield-source-risk-card")).toBeTruthy();
    const chart = screen.getByTestId("yield-history-chart");
    expect(chart.getAttribute("data-available-sources")).toBe("primary-source,alt-source");
    expect(chart.getAttribute("data-external-source-keys")).toBe("alt-source");
    expect(chart.getAttribute("data-benchmark-rate")).toBe("0.031");
    expect(chart.getAttribute("data-median-apy")).toBe("0.04");
    expect(screen.getByRole("button", { name: "Reset to all sources" })).toBeTruthy();
  });

  it.each([
    {
      id: "usdn-smardex",
      coin: staticCoin("usdn-smardex", "SMARDEX USDN", "USDN", true),
      expected: "Yield tracking is expected for this stablecoin, but the latest ranking snapshot is not available yet.",
    },
    {
      id: "bd-basedollar",
      coin: staticCoin("bd-basedollar", "Base Dollar", "BD", false),
      expected:
        "This stablecoin doesn't currently have yield data tracked. The protocol may not expose a yield-bearing pool, or the source is not on the curated allowlist.",
    },
    {
      id: "buck-buck-assets",
      coin: staticCoin("buck-buck-assets", "Buck", "BUCK", true),
      expected: "This stablecoin is frozen — historical yield data is no longer being refreshed.",
    },
    {
      id: "brd-volpon",
      coin: staticCoin("brd-volpon", "BRD Stablecoin", "BRD", true),
      expected: "BRD Stablecoin is in pre-launch tracking. Yield history will appear here once the stablecoin is live and the cron has observed source data.",
    },
    {
      id: "benji-franklin-templeton",
      coin: staticCoin("benji-franklin-templeton", "Franklin OnChain U.S. Government Money Fund", "BENJI", true),
      expected:
        "Temporarily withheld because permitted runtime sources do not provide a positive circulating supply or market cap.",
    },
  ])("renders the $id lifecycle body inside the shared frame", ({ id, coin, expected }) => {
    setRankingsQuery();

    render(<YieldAnalysisClient id={id} staticCoin={coin} />);

    expect(screen.getByRole("link", { name: `Back to ${coin.symbol} detail` })).toBeTruthy();
    expect(screen.getByText(expected)).toBeTruthy();
  });

  it("renders the query error in the shared frame", () => {
    setRankingsQuery({ data: undefined, error: new Error("yield rankings failed") });

    render(
      <YieldAnalysisClient
        id="usdn-smardex"
        staticCoin={staticCoin("usdn-smardex", "SMARDEX USDN", "USDN", true)}
      />,
    );

    expect(screen.getByRole("link", { name: "Back to USDN detail" })).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("yield rankings failed")).toBeTruthy();
  });
});

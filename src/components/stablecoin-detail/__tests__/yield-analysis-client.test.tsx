// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import YieldAnalysisClient from "@/components/stablecoin-detail/yield-analysis-client";
import { makeYieldDetailRanking, makeYieldDetailResponse } from "@/components/__tests__/yield-detail.test-support";
import type { StablecoinStaticMeta } from "@/lib/stablecoin-static-meta";
import type { YieldHistoryPoint, YieldRanking, YieldRankingsResponse } from "@shared/types";

const { useYieldRankingsMock, useYieldHistoryMock, replaceParamsMock, loadClientStablecoinDetailMock } = vi.hoisted(() => ({
  useYieldRankingsMock: vi.fn(),
  useYieldHistoryMock: vi.fn(),
  replaceParamsMock: vi.fn(),
  loadClientStablecoinDetailMock: vi.fn(),
}));

let sourcesParam = "";

vi.mock("next/dynamic", () => ({
  // Doubles are told apart by their own props, not by declaration order.
  default: () =>
    function DynamicYieldSection(props: {
      attribution?: unknown;
      availableSources?: Array<{ sourceKey: string }>;
      externalSourceKeys?: string[];
      benchmarkRate?: number;
      medianApy?: number;
    }) {
      if (props.attribution !== undefined) {
        return <div data-testid="yield-change-attribution" />;
      }
      return (
        <div
          data-testid="yield-history-chart"
          data-available-sources={(props.availableSources ?? []).map((source) => source.sourceKey).join(",")}
          data-external-source-keys={(props.externalSourceKeys ?? []).join(",")}
          data-benchmark-rate={props.benchmarkRate}
          data-median-apy={props.medianApy}
        />
      );
    },
}));

vi.mock("@/hooks/api-hooks", () => ({
  useYieldRankings: useYieldRankingsMock,
  useYieldHistory: useYieldHistoryMock,
}));

vi.mock("@shared/lib/stablecoins/client-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shared/lib/stablecoins/client-registry")>()),
  loadClientStablecoinDetail: loadClientStablecoinDetailMock,
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

function makeHistoryPoint(
  overrides: Partial<YieldHistoryPoint> & Pick<YieldHistoryPoint, "date" | "apy">,
): YieldHistoryPoint {
  return {
    apyBase: null,
    apyReward: null,
    exchangeRate: null,
    sourceTvlUsd: null,
    warningSignals: [],
    ...overrides,
  };
}

function setHistoryQuery(history: YieldHistoryPoint[] = []) {
  useYieldHistoryMock.mockReturnValue({
    data: { current: null, history, methodology: { version: "v8.14" } },
    error: null,
    isLoading: false,
  });
}

describe("YieldAnalysisClient", () => {
  beforeEach(() => {
    sourcesParam = "";
    replaceParamsMock.mockReset();
    useYieldRankingsMock.mockReset();
    useYieldHistoryMock.mockReset();
    loadClientStablecoinDetailMock.mockReset();
    loadClientStablecoinDetailMock.mockImplementation(async (id: string) =>
      id === "benji-franklin-templeton"
        ? {
            id,
            listingStatusReview: {
              reason: "Temporarily withheld because permitted runtime sources do not provide a positive circulating supply or market cap.",
            },
          }
        : null,
    );
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
  ])("renders the $id lifecycle body inside the shared frame", async ({ id, coin, expected }) => {
    setRankingsQuery();

    render(<YieldAnalysisClient id={id} staticCoin={coin} />);

    expect(screen.getByRole("link", { name: `Back to ${coin.symbol} detail` })).toBeTruthy();
    await waitFor(() => expect(screen.getByText(expected)).toBeTruthy());
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

  it("reset deletes only the sources param, then rerenders the all-sources view", () => {
    sourcesParam = "alt-source";
    setRankingsQuery({ data: makeResponse([makeRanking()]) });

    const view = render(
      <YieldAnalysisClient
        id="usdn-smardex"
        staticCoin={staticCoin("usdn-smardex", "SMARDEX USDN", "USDN", true)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset to all sources" }));

    expect(replaceParamsMock).toHaveBeenCalledTimes(1);
    // The updater must surgically drop `sources` and keep unrelated filters.
    const params = new URLSearchParams("sources=alt-source&utm_campaign=launch");
    replaceParamsMock.mock.calls[0]![0]!(params);
    expect(params.get("sources")).toBeNull();
    expect(params.get("utm_campaign")).toBe("launch");

    sourcesParam = "";
    view.rerender(
      <YieldAnalysisClient
        id="usdn-smardex"
        staticCoin={staticCoin("usdn-smardex", "SMARDEX USDN", "USDN", true)}
      />,
    );
    expect(screen.queryByRole("button", { name: "Reset to all sources" })).toBeNull();
    expect(screen.getByTestId("yield-history-chart").getAttribute("data-external-source-keys")).toBe(
      "primary-source,alt-source",
    );
  });

  it("shows the all-source view without a reset control when every requested key is invalid", () => {
    sourcesParam = "stale-source,bogus-key";
    setRankingsQuery({ data: makeResponse([makeRanking()]) });

    render(
      <YieldAnalysisClient
        id="usdn-smardex"
        staticCoin={staticCoin("usdn-smardex", "SMARDEX USDN", "USDN", true)}
      />,
    );

    expect(screen.getByTestId("yield-history-chart").getAttribute("data-external-source-keys")).toBe(
      "primary-source,alt-source",
    );
    expect(screen.queryByRole("button", { name: "Reset to all sources" })).toBeNull();
  });

  it("groups same signal-source pairs inside the 24h bucket, counts repeats, and orders groups newest first", () => {
    setRankingsQuery({ data: makeResponse([makeRanking()]) });
    setHistoryQuery([
      makeHistoryPoint({ date: "2026-08-01T10:00:00Z", apy: 0.05, yieldSource: "Primary Source", warningSignals: ["yield-spike"] }),
      makeHistoryPoint({ date: "2026-08-02T10:00:00Z", apy: 0.05, yieldSource: "Primary Source", warningSignals: ["yield-spike"] }),
      // The APY change no longer splits the run: within one 24h bucket the
      // signal-source pair merges, and the row shows the newest occurrence's APY.
      makeHistoryPoint({ date: "2026-08-03T10:00:00Z", apy: 0.06, yieldSource: "Primary Source", warningSignals: ["yield-spike"] }),
      makeHistoryPoint({ date: "2026-08-04T10:00:00Z", apy: 0.06, yieldSource: "Alt Source", warningSignals: ["yield-divergence"] }),
    ]);

    render(
      <YieldAnalysisClient
        id="usdn-smardex"
        staticCoin={staticCoin("usdn-smardex", "SMARDEX USDN", "USDN", true)}
      />,
    );

    const rows = Array.from(document.getElementById("warning-signals")!.querySelectorAll("li"));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Yield divergence");
    expect(rows[0]!.textContent).toContain("Alt Source at 0.06%");
    expect(rows[1]!.textContent).toContain("Yield spike");
    expect(rows[1]!.textContent).toContain("×3");
    expect(rows[1]!.textContent).toContain("Primary Source at 0.06%");
    expect(rows[1]!.textContent).toContain("–");
  });

  it("renders the source transition once and omits a switch stamped with an invalid date", () => {
    setRankingsQuery({ data: makeResponse([makeRanking()]) });
    setHistoryQuery([
      makeHistoryPoint({ date: "2026-08-01T10:00:00Z", apy: 0.05, yieldSource: "Primary Source" }),
      makeHistoryPoint({
        date: "2026-08-02T10:00:00Z",
        apy: 0.06,
        yieldSource: "Alt Source",
        sourceKey: "alt-source",
        sourceSwitch: true,
      }),
      makeHistoryPoint({
        date: "not-a-date",
        apy: 0.07,
        yieldSource: "Alt Source",
        sourceKey: "alt-source",
        sourceSwitch: true,
      }),
    ]);

    render(
      <YieldAnalysisClient
        id="usdn-smardex"
        staticCoin={staticCoin("usdn-smardex", "SMARDEX USDN", "USDN", true)}
      />,
    );

    const rows = Array.from(document.getElementById("source-switches")!.querySelectorAll("li"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Primary Source → Alt Source");
    expect(rows[0]!.textContent).toContain("APY at switch: 0.06%");
  });

  it("keeps the ready workbench mounted when a refetch errors over cached rankings", () => {
    setRankingsQuery({ data: makeResponse([makeRanking()]), error: new Error("refetch failed") });

    render(
      <YieldAnalysisClient
        id="usdn-smardex"
        staticCoin={staticCoin("usdn-smardex", "SMARDEX USDN", "USDN", true)}
      />,
    );

    expect(screen.getByTestId("pys-breakdown")).toBeTruthy();
    expect(screen.getByTestId("yield-history-chart")).toBeTruthy();
    // Cached data suppresses the error surface entirely.
    expect(screen.queryByRole("status")).toBeNull();
  });
});

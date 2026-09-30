// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import Link from "next/link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";

const useReportCardsV9Mock = vi.hoisted(() => vi.fn());
const useStablecoinsMock = vi.hoisted(() => vi.fn());
const useNearViewportMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-near-viewport", () => ({ useNearViewport: useNearViewportMock }));

vi.mock("@/hooks/api-hooks", () => ({
  useReportCardsV9: useReportCardsV9Mock,
}));

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: useStablecoinsMock,
}));

vi.mock("@/lib/logos", () => ({
  logosById: {},
}));

// The focused map is exercised in src/components/__tests__/contagion-graph.test.tsx;
// here we only assert that the snapshot hands it the right focus and edge set.
vi.mock("next/dynamic", () => ({
  default: () =>
    function ContagionGraphStub({
      focusCoinId,
      dependencyEdges,
    }: {
      focusCoinId?: string;
      dependencyEdges?: readonly { from: string; to: string }[];
    }) {
      return (
        <div
          data-testid="contagion-graph"
          data-focus={focusCoinId}
          data-edges={(dependencyEdges ?? []).map((edge) => `${edge.from}>${edge.to}`).join(",")}
        />
      );
    },
}));


import { ContagionSnapshot } from "../contagion-snapshot";

function basketOn(upstreamAssetId: string) {
  return {
    serial: [],
    basket: [{ upstreamAssetId, weight: 0.8, score: 84, boundedUnknown: false }],
    cycleBlocked: false,
    reasonCodes: [],
  };
}

function makeDependencyResponse() {
  return makeReportCardsV9Response({
    cards: [
      makeV9Card({ id: "usdc-circle" }),
      makeV9Card({ id: "usde-ethena", dependencies: basketOn("usdc-circle") }),
    ],
  });
}

const SUPPLY_DATA = {
  peggedAssets: [
    { id: "usdc-circle", circulating: { peggedUSD: 60_000_000_000 } },
    { id: "usde-ethena", circulating: { peggedUSD: 5_000_000_000 } },
  ],
};

const STALE_UPDATED_AT = Date.parse("2026-07-10T00:00:00Z");

describe("ContagionSnapshot", () => {
  beforeEach(() => {
    useNearViewportMock.mockReturnValue({ ref: vi.fn(), near: true });
    useReportCardsV9Mock.mockReset();
    useReportCardsV9Mock.mockReturnValue({
      data: makeDependencyResponse(),
      error: null,
      dataUpdatedAt: 1,
      refetch: vi.fn(),
    });
    useStablecoinsMock.mockReset();
    useStablecoinsMock.mockReturnValue({
      data: SUPPLY_DATA,
      error: null,
      dataUpdatedAt: 1,
      refetch: vi.fn(),
    });
  });

  it("defers only the offscreen graph while keeping context and links available", () => {
    const ref = vi.fn();
    useNearViewportMock.mockReturnValue({ ref, near: false });
    const content = () => (
      <ContagionSnapshot
        stablecoinId="usdc-circle"
        variantRelationshipCard={<Link href="/stablecoin/usde-ethena/">Related asset</Link>}
      />
    );
    const { rerender } = render(content());
    expect(screen.queryByTestId("contagion-graph")).toBeNull();
    expect(screen.getByText("Loading dependency graph...")).toBeTruthy();
    expect(screen.getByText("Dependency Context")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Related asset" }).getAttribute("href")).toBe("/stablecoin/usde-ethena");
    expect(screen.getByRole("heading", { name: "Used by 1" })).toBeTruthy();

    useNearViewportMock.mockReturnValue({ ref, near: true });
    rerender(content());
    expect(screen.getByTestId("contagion-graph").getAttribute("data-focus")).toBe("usdc-circle");
    expect(screen.queryByText("Loading dependency graph...")).toBeNull();
    expect(screen.getByRole("link", { name: "Related asset" })).toBeTruthy();
  });

  it("renders the focused dependency map for the current asset", () => {
    render(
      <ContagionSnapshot
        stablecoinId="usde-ethena"
        variantRelationshipCard={<div data-testid="variant-card">VARIANT</div>}
      />,
    );

    expect(screen.getByText("Dependency Context")).toBeTruthy();
    const graph = screen.getByTestId("contagion-graph");
    expect(graph.getAttribute("data-focus")).toBe("usde-ethena");
    expect(graph.getAttribute("data-edges")).toBe("usdc-circle>usde-ethena");
    expect(screen.getByTestId("variant-card").textContent).toBe("VARIANT");
  });

  it("renders the published dependent beside the dependency map with a focused deep link", () => {
    render(<ContagionSnapshot stablecoinId="usdc-circle" />);
    expect(screen.getByRole("heading", { name: "Used by 1" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /USDe Collateral 80%/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open in Dependency Map" }).getAttribute("href"))
      .toBe("/dependency-map?focus=usdc-circle");
  });

  it("distinguishes Spark's serial mechanism claim from its native wrapper parent", () => {
    const data = makeReportCardsV9Response({
      cards: [
        makeV9Card({ id: "usds-sky" }),
        makeV9Card({ id: "usdc-circle" }),
        makeV9Card({ id: "susdc-spark", dependencies: {
          serial: [
            { upstreamAssetId: "usds-sky", score: 84, blocked: false, dependencyType: "mechanism", wrapperForm: null },
            { upstreamAssetId: "usdc-circle", score: 84, blocked: false, dependencyType: "wrapper", wrapperForm: "pure" },
          ],
          basket: [], cycleBlocked: false, reasonCodes: [],
        } }),
      ],
    });
    useReportCardsV9Mock.mockReturnValue({ data, error: null, dataUpdatedAt: 1, refetch: vi.fn() });
    const { rerender } = render(<ContagionSnapshot stablecoinId="usds-sky" />);
    expect(screen.getByRole("link", { name: "spUSDC Mechanism" })).toBeTruthy();
    expect(screen.queryByText("100%")).toBeNull();
    rerender(<ContagionSnapshot stablecoinId="usdc-circle" />);
    expect(screen.getByRole("link", { name: "spUSDC Wrapper" })).toBeTruthy();
  });

  it("uses the published relationship type for plain wrappers even with no wrapper form or variantOf", () => {
    const data = makeReportCardsV9Response({
      cards: [
        makeV9Card({ id: "usdc-circle" }),
        makeV9Card({ id: "pusd-polymarket", dependencies: {
          serial: [{ upstreamAssetId: "usdc-circle", score: 84, blocked: false, dependencyType: "wrapper", wrapperForm: null }],
          basket: [], cycleBlocked: false, reasonCodes: [],
        } }),
      ],
    });
    useReportCardsV9Mock.mockReturnValue({ data, error: null, dataUpdatedAt: 1, refetch: vi.fn() });
    render(<ContagionSnapshot stablecoinId="usdc-circle" />);
    expect(screen.getByRole("link", { name: "PUSD Wrapper" })).toBeTruthy();
  });

  it.each([
    { dependent: "susdc-spark", symbol: "spUSDC", wrapperForm: undefined, label: "Wrapper" },
    { dependent: "pusd-polymarket", symbol: "PUSD", wrapperForm: undefined, label: "Serial claim" },
    { dependent: "pusd-polymarket", symbol: "PUSD", wrapperForm: null, label: "Serial claim" },
  ] as const)("uses $label for legacy $dependent without a published relationship type", ({ dependent, symbol, wrapperForm, label }) => {
    const data = makeReportCardsV9Response({
      cards: [
        makeV9Card({ id: "usdc-circle" }),
        makeV9Card({ id: dependent, dependencies: {
          serial: [{ upstreamAssetId: "usdc-circle", score: 84, blocked: false, ...(wrapperForm === undefined ? {} : { wrapperForm }) }],
          basket: [], cycleBlocked: false, reasonCodes: [],
        } }),
      ],
    });
    useReportCardsV9Mock.mockReturnValue({ data, error: null, dataUpdatedAt: 1, refetch: vi.fn() });
    render(<ContagionSnapshot stablecoinId="usdc-circle" />);
    expect(screen.getByRole("link", { name: `${symbol} ${label}` })).toBeTruthy();
  });

  it.each([
    { upstream: "usyc-hashnote", dependent: "usd0-usual", symbol: "USD0", weight: 0.235 },
    { upstream: "susde-ethena", dependent: "dola-inverse-finance", symbol: "DOLA", weight: 0.521 },
  ])("uses the published basket share for $upstream rather than authored reserves", ({ upstream, dependent, symbol, weight }) => {
    const data = makeReportCardsV9Response({
      cards: [
        makeV9Card({ id: upstream }),
        makeV9Card({ id: dependent, dependencies: {
          ...basketOn(upstream),
          basket: [{ upstreamAssetId: upstream, weight, score: 84, boundedUnknown: false }],
        } }),
      ],
    });
    // An endpoint without a published card must not appear in either surface.
    data.dependencyGraph.edges.push({
      ...data.dependencyGraph.edges[0],
      from: upstream,
      to: "ebusd-ebisu",
    });
    useReportCardsV9Mock.mockReturnValue({ data, error: null, dataUpdatedAt: 1, refetch: vi.fn() });
    render(<ContagionSnapshot stablecoinId={upstream} />);
    expect(screen.getByRole("link", { name: (name) => name.includes(`${symbol} Collateral ${weight * 100}%`) })).toBeTruthy();
    expect(screen.queryByText("100%")).toBeNull();
    expect(screen.queryByText("ebUSD")).toBeNull();
    expect(screen.getByRole("heading", { name: "Used by 1" })).toBeTruthy();
    expect(screen.getByTestId("contagion-graph").getAttribute("data-edges")).toBe(`${upstream}>${dependent}`);
  });
  it("ignores edges whose counterparty is not a published V9 card", () => {
    useReportCardsV9Mock.mockReturnValue({
      data: makeReportCardsV9Response({
        cards: [
          makeV9Card({
            id: "usde-ethena",
            dependencies: {
              serial: [],
              basket: [
                {
                  upstreamAssetId: "untracked-coin",
                  weight: 0.8,
                  score: 84,
                  boundedUnknown: false,
                },
              ],
              cycleBlocked: false,
              reasonCodes: [],
            },
          }),
        ],
      }),
      error: null,
      dataUpdatedAt: 1,
      refetch: vi.fn(),
    });

    const { container } = render(<ContagionSnapshot stablecoinId="usde-ethena" />);
    expect(container.firstChild).toBeNull();
  });

  it("returns null without dependencies, supplemental context, or an error", () => {
    useReportCardsV9Mock.mockReturnValue({
      data: makeReportCardsV9Response({ cards: [makeV9Card({ id: "usde-ethena" })] }),
      error: null,
      dataUpdatedAt: 1,
      refetch: vi.fn(),
    });

    const { container } = render(<ContagionSnapshot stablecoinId="usde-ethena" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders an unavailable notice instead of falling back to V8", () => {
    useReportCardsV9Mock.mockReturnValue({
      data: undefined,
      error: new Error("V9 unavailable"),
      dataUpdatedAt: 0,
      refetch: vi.fn(),
    });

    render(<ContagionSnapshot stablecoinId="usde-ethena" />);

    expect(screen.getByRole("alert").textContent).toContain(
      "Dependency graph data is temporarily unavailable",
    );
  });

  it("retains right-column context when V9 data is missing", () => {
    useReportCardsV9Mock.mockReturnValue({
      data: undefined,
      error: null,
      dataUpdatedAt: 0,
      refetch: vi.fn(),
    });

    render(
      <ContagionSnapshot
        stablecoinId="usde-ethena"
        variantRelationshipCard={<div data-testid="variant-card">VARIANT</div>}
      />,
    );

    expect(screen.getByText("Dependency Context")).toBeTruthy();
    expect(screen.getByTestId("variant-card").textContent).toBe("VARIANT");
  });

  it("hands the graph only the focus coin's own incoming and outgoing edges", () => {
    useReportCardsV9Mock.mockReturnValue({
      data: makeReportCardsV9Response({
        cards: [
          makeV9Card({ id: "usdc-circle" }),
          makeV9Card({ id: "usds-sky" }),
          makeV9Card({ id: "usde-ethena", dependencies: basketOn("usdc-circle") }),
          makeV9Card({ id: "susde-ethena", dependencies: basketOn("usde-ethena") }),
          makeV9Card({ id: "dai-makerdao", dependencies: basketOn("usds-sky") }),
        ],
      }),
      error: null,
      dataUpdatedAt: 1,
      refetch: vi.fn(),
    });

    render(<ContagionSnapshot stablecoinId="usde-ethena" />);

    expect(screen.getByTestId("contagion-graph").getAttribute("data-edges")).toBe(
      "usdc-circle>usde-ethena,usde-ethena>susde-ethena",
    );
  });

  it.each([
    [
      "report cards",
      () =>
        useReportCardsV9Mock.mockReturnValue({
          data: makeDependencyResponse(),
          error: new Error("refresh failed"),
          dataUpdatedAt: STALE_UPDATED_AT,
          refetch: vi.fn(),
        }),
    ],
    [
      "stablecoin supply",
      () =>
        useStablecoinsMock.mockReturnValue({
          data: SUPPLY_DATA,
          error: new Error("refresh failed"),
          dataUpdatedAt: STALE_UPDATED_AT,
          refetch: vi.fn(),
        }),
    ],
  ])("keeps the cached graph and warns when the %s refresh fails", (_name, degrade) => {
    degrade();

    render(<ContagionSnapshot stablecoinId="usde-ethena" />);

    expect(screen.getByRole("status").textContent).toContain(
      "refresh failed; showing the last available data",
    );
    expect(screen.getByTestId("contagion-graph").getAttribute("data-edges")).toBe("usdc-circle>usde-ethena");
  });

  it("still draws the dependency map when supply data is missing entirely", () => {
    useStablecoinsMock.mockReturnValue({
      data: undefined,
      error: null,
      dataUpdatedAt: 0,
      refetch: vi.fn(),
    });

    render(<ContagionSnapshot stablecoinId="usde-ethena" />);

    expect(screen.getByTestId("contagion-graph").getAttribute("data-edges")).toBe("usdc-circle>usde-ethena");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("restarts both sources on retry and drops the notice once they recover", () => {
    const refetchCards = vi.fn();
    const refetchSupply = vi.fn();
    const healthyCards = {
      data: makeDependencyResponse(),
      error: null,
      dataUpdatedAt: 1,
      refetch: refetchCards,
    };
    useReportCardsV9Mock.mockReturnValue({ ...healthyCards, data: undefined, error: new Error("V9 unavailable"), dataUpdatedAt: 0 });
    useStablecoinsMock.mockReturnValue({
      data: undefined,
      error: null,
      dataUpdatedAt: 0,
      refetch: refetchSupply,
    });

    const { rerender } = render(<ContagionSnapshot stablecoinId="usde-ethena" />);

    fireEvent.click(screen.getByRole("button", { name: "Retry dependency graph data" }));
    expect(refetchCards).toHaveBeenCalledTimes(1);
    expect(refetchSupply).toHaveBeenCalledTimes(1);

    useReportCardsV9Mock.mockReturnValue(healthyCards);
    useStablecoinsMock.mockReturnValue({
      data: { peggedAssets: [{ id: "usde-ethena", circulating: { peggedUSD: 5_000_000_000 } }] },
      error: null,
      dataUpdatedAt: 2,
      refetch: refetchSupply,
    });
    rerender(<ContagionSnapshot stablecoinId="usde-ethena" />);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("contagion-graph").getAttribute("data-edges")).toBe("usdc-circle>usde-ethena");
  });
});

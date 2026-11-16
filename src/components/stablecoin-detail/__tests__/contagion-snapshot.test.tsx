// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";
import { projectV9Detail } from "@shared/lib/report-cards-v9-projections";

const useReportCardsV9Mock = vi.hoisted(() => vi.fn());
const useStablecoinsMock = vi.hoisted(() => vi.fn());
const useNearViewportMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-near-viewport", () => ({ useNearViewport: useNearViewportMock }));

vi.mock("@/hooks/api-hooks", () => ({
  useReportCardsV9Detail: () => {
    const query = useReportCardsV9Mock();
    return { ...query, data: query.data ? { ...query.data, neighborhood: query.data.neighborhood ?? query.data.cards } : undefined };
  },
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
      cards,
    }: {
      focusCoinId?: string;
      dependencyEdges?: readonly { from: string; to: string }[];
      cards?: readonly { id: string; grade: string | null; partialEvidence?: unknown }[];
    }) {
      return (
        <div
          data-testid="contagion-graph"
          data-focus={focusCoinId}
          data-edges={(dependencyEdges ?? []).map((edge) => `${edge.from}>${edge.to}`).join(",")}
          data-cards={JSON.stringify(cards)}
        />
      );
    },
}));


import { ContagionSnapshot } from "../contagion-snapshot";
import { ParentVariantsCard } from "../parent-variants-card";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";

/** The graph mounts only once its fold first opens. */
function openGraph() {
  const details = screen.getByText("Dependency graph").closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  return screen.getByTestId("contagion-graph");
}

function basketOn(upstreamAssetId: string) {
  return {
    serial: [],
    basket: [{ upstreamAssetId, weight: 0.8, score: 84, boundedUnknown: false,
      ratingStatus: "rated" as const, partialEvidence: null, causeGapRefs: [], limitedEvidenceCauses: [] }],
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

  it("renders phase-1 neighborhoods without optional rating status or pillars", () => {
    const detail = projectV9Detail(makeDependencyResponse(), "usdc-circle");
    detail.neighborhood = detail.neighborhood.map(({ id, grade, partialEvidence, sharedBookId }) => ({
      id, grade, partialEvidence, sharedBookId,
    }));
    useReportCardsV9Mock.mockReturnValue({ data: detail, error: null, dataUpdatedAt: 1, refetch: vi.fn() });
    render(<ContagionSnapshot stablecoinId="usdc-circle" />);
    const graph = openGraph();
    expect(graph.getAttribute("data-edges")).toBe("usdc-circle>usde-ethena");
    const cards = JSON.parse(graph.getAttribute("data-cards")!) as Array<Record<string, unknown>>;
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card).not.toHaveProperty("ratingStatus");
      expect(card).not.toHaveProperty("pillars");
    }
  });

  it.each(["B", null] as const)("preserves %s partial evidence in the detail graph projection", (grade) => {
    const data = makeDependencyResponse();
    const partialEvidence: NonNullable<(typeof data.cards)[number]["partialEvidence"]> = {
      reasonCode: "partial-evidence-pipeline-gap", causes: ["A"], excludedPillars: ["exit"],
      excludedComponentKeys: ["dex-liquidity"], causeGapRefs: [0],
    };
    data.cards[0] = { ...data.cards[0], grade, partialEvidence };
    useReportCardsV9Mock.mockReturnValue({ data, error: null, dataUpdatedAt: 1, refetch: vi.fn() });
    render(<ContagionSnapshot stablecoinId="usdc-circle" />);
    const cards = JSON.parse(openGraph().getAttribute("data-cards") ?? "[]");
    expect(cards.find((card: { id: string }) => card.id === "usdc-circle")).toMatchObject({
      grade, partialEvidence,
    });
  });

  it("leads with the ranked dependent list and keeps the graph folded until asked", () => {
    render(<ContagionSnapshot stablecoinId="usdc-circle" />);
    expect(screen.getByRole("heading", { name: "Used by 1" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /^USDe, Collateral, 80% of backing, \$4\.00B known exposure/ })).toBeTruthy();
    // Deferred mount, and never inline on phones where pan/zoom fights scroll.
    expect(screen.queryByTestId("contagion-graph")).toBeNull();
    const fold = screen.getByText("Dependency graph").closest("details")!;
    expect(fold.parentElement?.className.split(" ")).toEqual(expect.arrayContaining(["hidden", "sm:block"]));
    expect(openGraph()).toBeTruthy();
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
            { upstreamAssetId: "usds-sky", score: 84, ratingStatus: 84 === null ? "not-rated" as const : "rated" as const, partialEvidence: null, causeGapRefs: [], limitedEvidenceCauses: 84 === null ? ["U" as const] : [], blocked: false, dependencyType: "mechanism", wrapperForm: null },
            { upstreamAssetId: "usdc-circle", score: 84, ratingStatus: 84 === null ? "not-rated" as const : "rated" as const, partialEvidence: null, causeGapRefs: [], limitedEvidenceCauses: 84 === null ? ["U" as const] : [], blocked: false, dependencyType: "wrapper", wrapperForm: "pure" },
          ],
          basket: [], cycleBlocked: false, reasonCodes: [],
        } }),
      ],
    });
    useReportCardsV9Mock.mockReturnValue({ data, error: null, dataUpdatedAt: 1, refetch: vi.fn() });
    const { rerender } = render(<ContagionSnapshot stablecoinId="usds-sky" />);
    expect(screen.getByRole("link", { name: /^spUSDC, Mechanism,/ })).toBeTruthy();
    expect(screen.queryByText("100%")).toBeNull();
    rerender(<ContagionSnapshot stablecoinId="usdc-circle" />);
    expect(screen.getByRole("link", { name: /^spUSDC, Wrapper,/ })).toBeTruthy();
  });

  it("lists each token once: a variant ranked in Used by leaves the variants card", () => {
    const data = makeReportCardsV9Response({
      cards: [
        makeV9Card({ id: "usdc-circle" }),
        makeV9Card({ id: "susdc-spark", dependencies: {
          serial: [{ upstreamAssetId: "usdc-circle", score: 84, ratingStatus: "rated" as const, partialEvidence: null, causeGapRefs: [], limitedEvidenceCauses: [], blocked: false, dependencyType: "wrapper", wrapperForm: "pure" }],
          basket: [], cycleBlocked: false, reasonCodes: [],
        } }),
      ],
    });
    useReportCardsV9Mock.mockReturnValue({ data, error: null, dataUpdatedAt: 1, refetch: vi.fn() });
    const spark = CLIENT_TRACKED_META_BY_ID.get("susdc-spark")!;
    const keyrock = CLIENT_TRACKED_META_BY_ID.get("krusdc-keyrock")!;
    const { rerender } = render(
      <ContagionSnapshot stablecoinId="usdc-circle" variantRelationshipCard={<ParentVariantsCard variants={[spark, keyrock]} />} />,
    );
    // The ranked row carries the variant kind the variants card would have shown.
    expect(screen.getByRole("link", { name: /^spUSDC, Wrapper, Savings,/ })).toBeTruthy();
    expect(screen.getAllByText("spUSDC")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Other variants 1" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /^Keyrock Prime USDC \(krUSDC\)/ })).toBeTruthy();

    rerender(<ContagionSnapshot stablecoinId="usdc-circle" variantRelationshipCard={<ParentVariantsCard variants={[spark]} />} />);
    expect(screen.queryByRole("heading", { name: /variants/i })).toBeNull();
    // The emptied side column collapses, so Used by takes the whole row.
    const usedBy = screen.getByRole("heading", { name: "Used by 1" }).closest("section")!;
    expect(usedBy.parentElement!.nextElementSibling?.className).toContain("empty:hidden");
    expect(usedBy.parentElement!.nextElementSibling?.childElementCount).toBe(0);
  });

  it("uses the published relationship type for plain wrappers even with no wrapper form or variantOf", () => {
    const data = makeReportCardsV9Response({
      cards: [
        makeV9Card({ id: "usdc-circle" }),
        makeV9Card({ id: "pusd-polymarket", dependencies: {
          serial: [{ upstreamAssetId: "usdc-circle", score: 84, ratingStatus: 84 === null ? "not-rated" as const : "rated" as const, partialEvidence: null, causeGapRefs: [], limitedEvidenceCauses: 84 === null ? ["U" as const] : [], blocked: false, dependencyType: "wrapper", wrapperForm: null }],
          basket: [], cycleBlocked: false, reasonCodes: [],
        } }),
      ],
    });
    useReportCardsV9Mock.mockReturnValue({ data, error: null, dataUpdatedAt: 1, refetch: vi.fn() });
    render(<ContagionSnapshot stablecoinId="usdc-circle" />);
    expect(screen.getByRole("link", { name: /^PUSD, Wrapper,/ })).toBeTruthy();
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
          serial: [{ upstreamAssetId: "usdc-circle", score: 84, ratingStatus: 84 === null ? "not-rated" as const : "rated" as const, partialEvidence: null, causeGapRefs: [], limitedEvidenceCauses: 84 === null ? ["U" as const] : [], blocked: false, ...(wrapperForm === undefined ? {} : { wrapperForm }) }],
          basket: [], cycleBlocked: false, reasonCodes: [],
        } }),
      ],
    });
    useReportCardsV9Mock.mockReturnValue({ data, error: null, dataUpdatedAt: 1, refetch: vi.fn() });
    render(<ContagionSnapshot stablecoinId="usdc-circle" />);
    expect(screen.getByRole("link", { name: (name) => name.startsWith(`${symbol}, ${label},`) })).toBeTruthy();
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
          basket: [{ upstreamAssetId: upstream, weight, score: 84, boundedUnknown: false,
            ratingStatus: "rated", partialEvidence: null, causeGapRefs: [], limitedEvidenceCauses: [] }],
        } }),
      ],
    });
    // An endpoint without a published card must not enter usage or exposure totals.
    data.dependencyGraph.edges.push({
      ...data.dependencyGraph.edges[0],
      from: upstream,
      to: "ebusd-ebisu",
    });
    useReportCardsV9Mock.mockReturnValue({ data, error: null, dataUpdatedAt: 1, refetch: vi.fn() });
    render(<ContagionSnapshot stablecoinId={upstream} />);
    expect(screen.getByRole("link", { name: (name) => name.startsWith(`${symbol}, Collateral, ${weight * 100}% of backing`) })).toBeTruthy();
    expect(screen.queryByText("100%")).toBeNull();
    expect(screen.queryByText("ebUSD")).toBeNull();
    expect(screen.getByRole("heading", { name: "Used by 1" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Dependency summary" }).textContent).toContain("1 as collateral");
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
                { upstreamAssetId: "untracked-coin", weight: 0.8, score: 84, ratingStatus: 84 === null ? "not-rated" as const : "rated" as const, partialEvidence: null, causeGapRefs: [], limitedEvidenceCauses: 84 === null ? ["U" as const] : [], boundedUnknown: false, },
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

    render(<ContagionSnapshot stablecoinId="usde-ethena" />);
    expect(screen.queryByTestId("contagion-graph")).toBeNull();
    expect(screen.queryByRole("link", { name: "untracked-coin" })).toBeNull();
  });

  it("shows a coverage-only context without a drawn neighborhood", () => {
    useReportCardsV9Mock.mockReturnValue({
      data: makeReportCardsV9Response({ cards: [makeV9Card({ id: "usde-ethena", dependencyCoverage: [
        { upstreamLabel: "USDC", upstreamAssetId: "usdc-circle", share: 0.12,
          reason: "stale-evidence", sourceAsOf: "2026-08-31", identityVerified: true },
      ] })] }),
      error: null,
      dataUpdatedAt: 1,
      refetch: vi.fn(),
    });

    render(<ContagionSnapshot stablecoinId="usde-ethena" />);
    expect(screen.queryByTestId("contagion-graph")).toBeNull();
    const coverage = screen.getByRole("region", { name: "Known but not scored" });
    expect(coverage.textContent).toContain("Evidence is out of date");
    expect(coverage.textContent).not.toContain("stale-evidence");
    expect(screen.queryByRole("region", { name: "USDe depends on" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Scored dependency roles" })).toBeNull();
    // Both empty directions collapse to one muted sentence, not display-size "None" cells.
    const summary = screen.getByRole("region", { name: "Dependency summary" });
    expect(summary.querySelector("dl")).toBeNull();
    expect(summary.textContent).toBe("No tracked stablecoin depends on USDe, and its backing has no scored links to other stablecoins.");
    expect(screen.queryByText("Dependency graph")).toBeNull();
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
  ])("keeps the cached graph without a reader notice when the %s refresh fails", (_name, degrade) => {
    degrade();

    render(<ContagionSnapshot stablecoinId="usde-ethena" />);

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(openGraph().getAttribute("data-edges")).toBe("usdc-circle>usde-ethena");
  });

  it("still draws the dependency map when supply data is missing entirely", () => {
    useStablecoinsMock.mockReturnValue({
      data: undefined,
      error: null,
      dataUpdatedAt: 0,
      refetch: vi.fn(),
    });

    render(<ContagionSnapshot stablecoinId="usde-ethena" />);

    expect(openGraph().getAttribute("data-edges")).toBe("usdc-circle>usde-ethena");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps the drawn graph when only the supply read fails", () => {
    useStablecoinsMock.mockReturnValue({
      data: undefined,
      error: new Error("503"),
      dataUpdatedAt: 0,
      refetch: vi.fn(),
    });

    render(<ContagionSnapshot stablecoinId="usde-ethena" />);

    expect(openGraph().getAttribute("data-edges")).toBe("usdc-circle>usde-ethena");
    expect(screen.queryByRole("alert")).toBeNull();
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
    expect(openGraph().getAttribute("data-edges")).toBe("usdc-circle>usde-ethena");
  });
  it("counts a null-supply dependent but excludes it from direct USD exposure", () => {
    const data = makeReportCardsV9Response({
      cards: [
        makeV9Card({ id: "usdc-circle" }),
        makeV9Card({ id: "usde-ethena", dependencies: basketOn("usdc-circle") }),
        makeV9Card({ id: "susde-ethena", dependencies: basketOn("usdc-circle") }),
      ],
    });
    useReportCardsV9Mock.mockReturnValue({ data, error: null, dataUpdatedAt: 1, refetch: vi.fn() });
    useStablecoinsMock.mockReturnValue({
      data: { peggedAssets: [...SUPPLY_DATA.peggedAssets, { id: "susde-ethena", circulating: null }] },
      meta: { updatedAt: 1_752_534_000 }, error: null, dataUpdatedAt: 1, refetch: vi.fn(),
    });
    render(<ContagionSnapshot stablecoinId="usdc-circle" />);
    const summary = screen.getByRole("region", { name: "Dependency summary" });
    expect(summary.textContent).toContain("2 as collateral");
    expect(summary.textContent).toContain("Known direct exposure$4.00B");
    expect(summary.textContent).toContain("1 dependent without a market cap is left out of the exposure total.");
    expect(screen.getByRole("heading", { name: "Used by 2" })).toBeTruthy();
    // The unknown-supply dependent ranks last with an unavailable figure, never $0.
    const rows = screen.getAllByRole("link", { name: /Collateral, 80% of backing/ });
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "USDe, Collateral, 80% of backing, $4.00B known exposure, Safety grade A-",
      "sUSDe, Collateral, 80% of backing, exposure unavailable, Safety grade A-",
    ]);
  });

  it("does not report zero USD exposure when every dependent's supply is unavailable", () => {
    useStablecoinsMock.mockReturnValue({ data: undefined, error: null, dataUpdatedAt: 0, refetch: vi.fn() });
    render(<ContagionSnapshot stablecoinId="usdc-circle" />);
    const summary = screen.getByRole("region", { name: "Dependency summary" });
    expect(summary.textContent).toContain("1 as collateral");
    expect(summary.textContent).toContain("Direct USD exposure unavailable");
    expect(summary.textContent).not.toContain("$0");
  });

  it("keeps the drawn graph in a shrinkable grid slot so long inspection options cannot widen it", () => {
    render(<ContagionSnapshot stablecoinId="usdc-circle" />);
    expect(openGraph().parentElement?.className).toContain("min-w-0");
  });

});

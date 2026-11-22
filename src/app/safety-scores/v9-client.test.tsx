// @vitest-environment jsdom

import { act, fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupFrontendTest, createNextLinkMock, installMatchMediaMock } from "@/test-utils/frontend";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";
import { makeReportCardsV9PartialCard, makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import type { SafetyScoresPreview } from "@/lib/safety-grade-snapshot";

const mocks = vi.hoisted(() => ({
  useReportCardsV9: vi.fn(),
  useStablecoins: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({ useReportCardsV9Table: mocks.useReportCardsV9 }));
vi.mock("@/hooks/use-stablecoins", () => ({ useStablecoins: mocks.useStablecoins }));
vi.mock("next/link", async () => createNextLinkMock());
vi.mock("@/components/safety-scores/report-card-mini-v9", () => ({
  ReportCardMiniV9: ({ card }: { card: { id: string } }) => <div data-testid="v9-card">{card.id}</div>,
}));
vi.mock("@/components/query-freshness-notices", () => ({
  QueryFreshnessNotices: () => null,
}));

import { ReportCardsV9Client } from "./v9-client";
import { SafetyScoresLiveIsland as Island } from "./live-island";
import { SafetyScoresContentLoadingState as Loading } from "./loading-state";

function query(data: unknown) {
  return {
    data,
    isLoading: false,
    error: null,
    dataUpdatedAt: 1,
    meta: null,
    refetch: vi.fn(),
  };
}

const PREVIEW_PUBLISHED_AT_SEC = Date.parse("2026-10-27T08:00:00Z") / 1000;
const MAP_PRELOAD = '<link rel="preload" as="image" href="/safety-scores/map.webp" fetchPriority="high"';

function makePreview(overrides: Partial<SafetyScoresPreview> = {}): SafetyScoresPreview {
  const identity = overrides.identity ?? {
    model: "v9" as const,
    schemaVersion: 1 as const,
    methodologyVersion: "9.0",
    evaluationBuildDigest: "b".repeat(64),
    baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`,
    publicationGenerationId: "v9-publication-1",
    policyId: "safety-score-v9",
    policyDigest: "a".repeat(64),
  };
  return {
    kind: "safety-grade-preview",
    rows: [
      {
        id: "asset-a",
        name: "Asset A",
        symbol: "AAA",
        href: "/stablecoin/asset-a/",
        grade: "A",
        score: 90,
        provisional: false,
        gradeHoldRawGrade: null,
      },
      {
        id: "asset-b",
        name: "Asset B",
        symbol: "BBB",
        href: "/stablecoin/asset-b/",
        grade: "B",
        score: 75,
        provisional: true,
        gradeHoldRawGrade: null,
      },
    ],
    shownCount: 2,
    eligibleRatedCount: 2,
    publicationCompleteness: {
      expectedCount: 2,
      ratedCount: 2,
      notRatedCount: 0,
      pipelineGapCount: 0,
    },
    publicationHealth: {
      schemaVersion: 2,
      status: "current",
      acceptedPublicationGenerationId: "v9-publication-1",
      acceptedAtSec: PREVIEW_PUBLISHED_AT_SEC,
      attemptedAtSec: PREVIEW_PUBLISHED_AT_SEC,
      heldSinceSec: null,
      reasons: [],
    },
    identity,
    publishedAtSec: PREVIEW_PUBLISHED_AT_SEC,
    capturedAtSec: PREVIEW_PUBLISHED_AT_SEC + 300,
    snapshotDate: "2026-10-27",
    expiresAtSec: Date.parse("2026-10-30T00:00:00Z") / 1000,
    ...overrides,
  };
}

function renderSync(ui: Parameters<typeof rtlRender>[0]) {
  const queryClient = new QueryClient();
  return rtlRender(ui, {
    wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
}

async function render(ui: Parameters<typeof rtlRender>[0]) {
  let result!: ReturnType<typeof rtlRender>;
  await act(async () => {
    result = renderSync(ui);
    await import("@/components/safety-scores/report-card-mini-v9");
  });
  return result;
}

const renderPreview = () => render(<ReportCardsV9Client initialPreview={makePreview()} />);

/** The fixture expired on 2026-10-30: hold the viewer clock inside its lifetime, or the post-mount clock tick races the assertion. */
const holdPreviewClock = () => vi.useFakeTimers({ toFake: ["Date"], now: (PREVIEW_PUBLISHED_AT_SEC + 600) * 1000 });

function expectPreviewFacts() {
  expect(screen.getAllByText("Grades as of 2026-10-27")).toHaveLength(1);
  expect(screen.getByText("Top 2 of 2 rated active stablecoins by Safety Score")).toBeTruthy();
  expect(document.querySelector('a[href="/stablecoin/asset-a/"]')).not.toBeNull();
  expect(document.querySelector('a[href="/stablecoin/asset-b/"]')).not.toBeNull();
  expect(screen.getByText("90/100")).toBeTruthy();
}

function getMatrixRows() {
  const table = screen.getByTestId("safety-scores-matrix-table");
  return within(table).getAllByTestId("safety-matrix-row");
}

describe("ReportCardsV9Client", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/safety-scores/");
    mocks.useReportCardsV9.mockReturnValue(query(makeReportCardsV9Response({
      cards: [
        makeV9Card({ id: "asset-a", grade: "A", score: 90 }),
        makeV9Card({ id: "asset-b", grade: "B", score: 75 }),
      ],
    })));
    mocks.useStablecoins.mockReturnValue(query({ peggedAssets: [
      { id: "asset-a", pegType: "peggedUSD", circulating: { peggedUSD: 2_500_000_000 } },
      { id: "asset-b", pegType: "peggedEUR", circulating: { peggedEUR: 500_000_000 } },
    ] }));
  });

  afterEach(cleanupFrontendTest);

  it("reserves height until live grid cards load when opened in grid view", async () => {
    window.history.replaceState(null, "", "/safety-scores/?view=grid");
    renderSync(<ReportCardsV9Client />);
    expect(screen.getAllByLabelText("Loading safety card")).toHaveLength(2);
    expect(screen.getAllByLabelText("Loading safety card")[0].className).toContain("h-[274px]");
    expect((await screen.findAllByTestId("v9-card"))).toHaveLength(2);
    expect(screen.queryByText(/Ratings are held at the last verified snapshot/)).toBeNull();
  });

  it("defaults to the sortable Matrix Table with all 9 columns and toggles to Grid view", async () => {
    await render(<ReportCardsV9Client />);

    const table = screen.getByTestId("safety-scores-matrix-table");
    const rows = within(table).getAllByTestId("safety-matrix-row");
    expect(rows).toHaveLength(2);
    expect(within(table).getByRole("columnheader", { name: /Coin/ })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: /Grade \/ Score/ })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: /Backing/ })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: /Exit/ })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: /Control/ })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: /Top Driver \/ Cap/ })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: /MCap/ })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: /Peg/ })).toBeTruthy();
    expect(screen.queryByTestId("v9-card")).toBeNull();

    // Switch to Grid view via segmented toggle
    fireEvent.click(screen.getAllByRole("button", { name: "Grid" })[0]);
    expect(window.location.search).toContain("view=grid");
    expect(await screen.findAllByTestId("v9-card")).toHaveLength(2);
    expect(screen.queryByTestId("safety-scores-matrix-table")).toBeNull();

    // Switch back to Table view and drop default view param
    fireEvent.click(screen.getAllByRole("button", { name: "Table" })[0]);
    expect(window.location.search).not.toContain("view=");
    expect(screen.getByTestId("safety-scores-matrix-table")).toBeTruthy();
  });

  it("supports inline search, URL filter sync, column sorting, and compare selection", async () => {
    mocks.useReportCardsV9.mockReturnValue(query(makeReportCardsV9Response({
      cards: [
        makeV9Card({ id: "usdc-circle", grade: "A", score: 90 }),
        makeV9Card({ id: "usdt-tether", grade: "B", score: 75 }),
        makeV9Card({ id: "eurs-stasis", grade: "C", score: 60 }),
      ],
    })));
    await render(<ReportCardsV9Client />);

    // Inline search filters rows and syncs ?q=
    const searchInput = screen.getByLabelText(/Search safety scores/);
    fireEvent.change(searchInput, { target: { value: "tether" } });
    expect(window.location.search).toContain("q=tether");
    expect(getMatrixRows()).toHaveLength(1);
    expect(getMatrixRows()[0].textContent).toContain("USDT");

    // Clear search
    fireEvent.change(searchInput, { target: { value: "" } });
    expect(getMatrixRows()).toHaveLength(3);

    // Select 2 coins to compare and verify direct /compare/?coins=... link
    const table = screen.getByTestId("safety-scores-matrix-table");
    fireEvent.click(within(table).getByLabelText(/Select USD Coin \(USDC\) to compare/));
    fireEvent.click(within(table).getByLabelText(/Select Tether \(USDT\) to compare/));
    const compareBar = screen.getByTestId("safety-compare-bar");
    const compareLink = within(compareBar).getByRole("link", { name: /Compare 2 coins/ });
    expect(compareLink.getAttribute("href")).toBe("/compare/?coins=usdc-circle,usdt-tether");

    // Sort by Grade / Score ascending via column header
    fireEvent.click(within(table).getByRole("button", { name: "Sort by Grade / Score" }));
    expect(window.location.search).toContain("dir=asc");
    const sortedRows = getMatrixRows();
    expect(sortedRows[0].textContent).toContain("EURS");
  });

  it("hydrates active grade, peg, sort, search, and view state from URL query params", async () => {
    window.history.replaceState(null, "", "/safety-scores/?grade=B&peg=usd&sort=backing&dir=asc&view=grid&q=usdt");
    mocks.useReportCardsV9.mockReturnValue(query(makeReportCardsV9Response({
      cards: [
        makeV9Card({ id: "usdc-circle", grade: "A", score: 90 }),
        makeV9Card({ id: "usdt-tether", grade: "B", score: 75 }),
      ],
    })));
    await render(<ReportCardsV9Client />);
    expect(await screen.findAllByTestId("v9-card")).toHaveLength(1);
    expect(screen.getByTestId("v9-card").textContent).toBe("usdt-tether");
    expect((screen.getByLabelText(/Search safety scores/) as HTMLInputElement).value).toBe("usdt");
  });

  it("filters the matrix when clicking a grade segment in SafetyGradeDistributionBar", async () => {
    await render(<ReportCardsV9Client />);
    expect(getMatrixRows()).toHaveLength(2);

    const segment = screen.getAllByRole("button", { name: /Filter by grade B/ })[0];
    fireEvent.click(segment);

    expect(window.location.search).toContain("grade=B");
    expect(getMatrixRows()).toHaveLength(1);
    expect(getMatrixRows()[0].textContent).toContain("asset-b");

    // Clicking the active grade again clears the filter
    fireEvent.click(screen.getAllByRole("button", { name: /Filter by grade B/ })[0]);
    expect(window.location.search).not.toContain("grade=");
    expect(getMatrixRows()).toHaveLength(2);
  });

  it("paginates large sets and displays Page X of Y controls", async () => {
    const manyCards = Array.from({ length: 55 }, (_, i) =>
      makeV9Card({ id: `coin-${String(i).padStart(3, "0")}`, grade: "B", score: 75 - (i % 10) }),
    );
    mocks.useReportCardsV9.mockReturnValue(query(makeReportCardsV9Response({ cards: manyCards })));
    await render(<ReportCardsV9Client />);

    expect(getMatrixRows()).toHaveLength(48);
    expect(screen.getAllByText("Page 1 of 2").length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole("button", { name: "Go to next page" })[0]);
    expect(getMatrixRows()).toHaveLength(7);
    expect(screen.getAllByText("Page 2 of 2").length).toBeGreaterThan(0);
  });

  it("never leaks raw (A) or (B) cause codes in the scoring note", async () => {
    await render(<ReportCardsV9Client />);
    expect(document.body.textContent).not.toMatch(/\(A\)|\(B\)/);
    expect(document.body.textContent).toContain("Unavailable data feeds and public data awaiting curation do not score.");
  });

  it.each(["loading", "failed"])("keeps the hero map without numeric stats while ratings are %s", async (state) => {
    mocks.useReportCardsV9.mockReturnValue({
      ...query(undefined),
      isLoading: state === "loading",
      error: state === "failed" ? new Error("Ratings unavailable") : null,
    });
    const html = renderToStaticMarkup(<ReportCardsV9Client />);
    expect(html).toContain(MAP_PRELOAD);
    expect(html.match(/<img\b[^>]*src="\/safety-scores\/map\.webp"/g)).toHaveLength(1);
    const { container } = await render(<ReportCardsV9Client />);
    const hero = screen.getByRole("group", { name: "Ecosystem safety overview" });
    const image = hero.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("/safety-scores/map.webp");
    expect(image.getAttribute("fetchPriority")).toBe("high");
    expect(image.getAttribute("loading")).toBe("eager");
    expect(container.querySelectorAll('img[src="/safety-scores/map.webp"]')).toHaveLength(1);
    expect(hero.textContent).not.toMatch(/[0-9]/);
    if (state === "loading") {
      expect(hero.querySelectorAll("[data-slot=skeleton]").length).toBeGreaterThan(0);
    } else {
      expect(hero.querySelector("[data-slot=skeleton], .animate-pulse")).toBeNull();
      expect(hero.textContent).not.toContain("Ecosystem read");
    }
  });

  it.each([
    ["empty", []],
    ["unrated", [makeV9Card({ id: "nr", score: null, grade: "NR" })]],
    ["pipeline gaps", [makeReportCardsV9PipelineGapCard("control", "A", { id: "gap" })]],
  ] as const)("hides hero stat slots for loaded %s ratings", async (_state, cards) => {
    mocks.useReportCardsV9.mockReturnValue(query(makeReportCardsV9Response({ cards: [...cards] })));

    const { container } = await render(<ReportCardsV9Client />);
    const hero = screen.getByRole("group", { name: "Ecosystem safety overview" });
    expect(container.querySelectorAll('img[src="/safety-scores/map.webp"]')).toHaveLength(1);
    const image = hero.querySelector("img")!;
    expect(image.getAttribute("fetchPriority")).toBe("high");
    expect(image.getAttribute("loading")).toBe("eager");
    expect(hero.querySelector("[data-slot=skeleton], .animate-pulse")).toBeNull();
    expect(hero.textContent).not.toMatch(/Ecosystem read|Ecosystem avg|Supply in A\/B|By asset count|[0-9]/);
  });

  it("keeps the high-priority PNG preview when the WebP derivative is missing or fails", async () => {
    await render(<ReportCardsV9Client />);
    const preview = screen.getByRole("link", { name: "Open the Safety Score Map" });
    const image = preview.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("/safety-scores/map.webp");
    expect(image.getAttribute("fetchPriority")).toBe("high");
    expect(preview.querySelectorAll("img")).toHaveLength(1);

    fireEvent.error(image);
    expect(image.getAttribute("src")).toBe("/safety-scores/map.png");
    expect(image.getAttribute("fetchPriority")).toBe("high");
    expect(image.getAttribute("alt")).toBe("");
    expect(preview.querySelectorAll("img")).toHaveLength(1);
    expect(preview.textContent).not.toContain("Full market map");

    fireEvent.error(image);
    expect(preview.querySelector("img")).toBeNull();
    expect(preview.textContent).toContain("Full market map");
  });

  it("leaves held publication to /status while keeping accepted ratings visible", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const response = makeReportCardsV9Response({
      updatedAt: nowSec,
      cards: [makeV9Card({ id: "asset-a", grade: "A", score: 90 })],
    });
    response.publicationHealth = {
      ...response.publicationHealth,
      status: "held",
      heldSinceSec: nowSec - 60,
      attemptedAtSec: nowSec,
      reasons: [{ code: "assessment-failed", detail: "internal assessment detail" }],
    };
    mocks.useReportCardsV9.mockReturnValue({ ...query(response), dataUpdatedAt: nowSec * 1000 });
    await render(<ReportCardsV9Client />);
    expect(screen.queryByText(/Ratings are held at the last verified snapshot/)).toBeNull();
    expect(document.body.textContent).not.toContain("assessment-failed");
    expect(document.body.textContent).not.toContain("internal assessment detail");
    expect(getMatrixRows()).toHaveLength(1);
    expect(getMatrixRows()[0].textContent).toContain("asset-a");
  });

  it("filters technical gaps separately from NR while retaining rated partial cards", async () => {
    mocks.useReportCardsV9.mockReturnValue(query(makeReportCardsV9Response({ cards: [
      makeReportCardsV9PartialCard("exit", "B", { id: "partial", score: 75 }),
      makeReportCardsV9PipelineGapCard("control", "A", { id: "gap" }),
      makeV9Card({ id: "nr", score: null, grade: "NR" }),
    ] })));
    await render(<ReportCardsV9Client />);
    fireEvent.click(screen.getAllByRole("button", { name: "Pipeline gap (1)" })[0]);
    expect(getMatrixRows()).toHaveLength(1);
    expect(getMatrixRows()[0].textContent).toContain("gap");
    fireEvent.click(screen.getAllByRole("button", { name: "NR (1)" })[0]);
    expect(getMatrixRows()).toHaveLength(1);
    expect(getMatrixRows()[0].textContent).toContain("nr");
    fireEvent.click(screen.getAllByRole("button", { name: "B (1)" })[0]);
    expect(getMatrixRows()).toHaveLength(1);
    expect(getMatrixRows()[0].textContent).toContain("partial");
  });

  it("labels the non-USD, non-commodity peg bucket as other pegs", async () => {
    mocks.useReportCardsV9.mockReturnValue(query(makeReportCardsV9Response({
      cards: [
        makeV9Card({ id: "usdc-circle", grade: "A", score: 90 }),
        makeV9Card({ id: "eurs-stasis", grade: "B", score: 75 }),
      ],
    })));
    await render(<ReportCardsV9Client />);

    fireEvent.click(screen.getAllByRole("button", { name: "Other pegs" })[0]);

    expect(getMatrixRows()).toHaveLength(1);
    expect(getMatrixRows()[0].textContent).toContain("EURS");
    expect(screen.getByText(/· other peg/)).toBeTruthy();
  });

  it("keeps the peg filter usable while the independent stablecoins read is unavailable", async () => {
    mocks.useReportCardsV9.mockReturnValue(query(makeReportCardsV9Response({
      cards: [
        makeV9Card({ id: "usdc-circle", grade: "A", score: 90 }),
        makeV9Card({ id: "usdt-tether", grade: "B", score: 75 }),
      ],
    })));
    mocks.useStablecoins.mockReturnValue(query(undefined));

    await render(<ReportCardsV9Client />);
    fireEvent.click(screen.getAllByRole("button", { name: "USD" })[0]);

    expect(getMatrixRows()).toHaveLength(2);
    expect(screen.queryByText(/No coins match this filter/)).toBeNull();
  });

  it("shows Safety Score unavailable without legacy engine fallback or V9/V10 labels", async () => {
    mocks.useReportCardsV9.mockReturnValue({
      ...query(undefined),
      error: new Error("Ratings unavailable"),
    });

    await render(<ReportCardsV9Client />);

    const alertText = screen.getByRole("alert").textContent ?? "";
    expect(alertText).toContain("Safety Score ratings are temporarily unavailable");
    expect(alertText).toContain("Legacy ratings are not used as a fallback");
    expect(alertText).not.toMatch(/V8|V9|V10/);
  });

  it.each(["loading", "failed"])("keeps ratings visible when the independent supply query is %s", async (state) => {
    mocks.useStablecoins.mockReturnValue({
      ...query(undefined), isLoading: state === "loading", isPending: state === "loading",
      error: state === "failed" ? new Error("Supply unavailable") : null,
    });
    await render(<ReportCardsV9Client />);
    expect(getMatrixRows()).toHaveLength(2);
    expect(screen.getAllByText("Supply unavailable")).toHaveLength(2);
    expect(screen.queryByRole("img", { name: /by supply/ })).toBeNull();
    expect(screen.queryByText("0%")).toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("labels partial supply headlines without hiding otherwise valid ratings", async () => {
    mocks.useStablecoins.mockReturnValue(query({ peggedAssets: [
      { id: "asset-a", pegType: "peggedUSD", circulating: { peggedUSD: 100 } },
      { id: "asset-b", pegType: "peggedEUR", circulating: {} },
    ] }));
    await render(<ReportCardsV9Client />);
    expect(getMatrixRows()).toHaveLength(2);
    expect(screen.getByText("Known supply in A/B")).toBeTruthy();
    expect(screen.getByText(/1\/2 rated assets observed/)).toBeTruthy();
    expect(screen.queryByText("Supply in A/B")).toBeNull();
    expect(screen.getByText("By known supply")).toBeTruthy();
    expect(screen.getByText("$100.00 · 1 of 2 rated")).toBeTruthy();
    expect(screen.getByText(/Supply unavailable for 1 rated asset: excluded, not counted as zero/)).toBeTruthy();
  });

  it("renders observed zero dollars with an unavailable zero-denominator percentage", async () => {
    mocks.useStablecoins.mockReturnValue(query({ peggedAssets: [
      { id: "asset-a", circulating: { peggedUSD: 0 } },
      { id: "asset-b", circulating: { peggedUSD: 0 } },
    ] }));
    await render(<ReportCardsV9Client />);
    expect(screen.getByText("$0.00")).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
    expect(getMatrixRows()).toHaveLength(2);
  });

  it("preserves focus and map fallback through live handoff", async () => {
    holdPreviewClock();
    mocks.useReportCardsV9.mockReturnValue({ ...query(undefined), isLoading: true });
    mocks.useStablecoins.mockReturnValue(query(undefined));
    const preview = makePreview();
    const page = () => <Island initialPreview={preview}><Loading preview={preview} /></Island>;

    const html = renderToStaticMarkup(page());
    expect(html).toContain(MAP_PRELOAD);
    expect(html).toContain("Grades as of 2026-10-27");
    expect(html).toContain('href="/stablecoin/asset-a/"');
    mocks.useReportCardsV9.mockClear();
    const { container, rerender } = renderSync(page());
    const link = screen.getByText("Asset A").closest("a")!;
    const image = container.querySelector("img")!;
    fireEvent.error(image);
    link.focus();
    const flush = container.innerHTML;
    await act(() => import("./v9-client"));
    expect(mocks.useReportCardsV9).toHaveBeenCalled();
    expect(container.innerHTML).toBe(flush);
    expect(document.activeElement).toBe(link);
    expect(container.querySelector("img")).toBe(image);
    expectPreviewFacts();
    expect(screen.getByRole("group", { name: "Ecosystem safety overview" }).textContent).not.toMatch(/[0-9]/);

    image.closest("a")!.focus();
    mocks.useReportCardsV9.mockReturnValue(query(makeReportCardsV9Response({
      updatedAt: PREVIEW_PUBLISHED_AT_SEC, cards: [makeV9Card({ id: "asset-a", grade: "C", score: 55 })],
    })));
    rerender(page());
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Open the Safety Score Map" }));
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/safety-scores/map.png");
    expect(screen.queryByText("Grades as of 2026-10-27")).toBeNull();
    expect(getMatrixRows()).toHaveLength(1);
  });

  it("keeps focus on the preview coin link when a paused ratings request resumes", async () => {
    holdPreviewClock();
    const preview = makePreview();
    const pending = { ...query(undefined), isPending: true };
    mocks.useReportCardsV9.mockReturnValue({ ...pending, fetchStatus: "paused" });
    const { rerender } = await render(<ReportCardsV9Client initialPreview={preview} />);
    const link = screen.getByText("Asset A").closest("a")!;
    link.focus();
    mocks.useReportCardsV9.mockReturnValue({ ...pending, isLoading: true, fetchStatus: "fetching" });
    rerender(<ReportCardsV9Client initialPreview={preview} />);
    expect(document.activeElement).toBe(link);
  });

  it("retains the preview and its links through an initial API failure", async () => {
    holdPreviewClock();
    mocks.useReportCardsV9.mockReturnValue({
      ...query(undefined),
      error: new Error("Ratings unavailable"),
    });
    await renderPreview();
    expectPreviewFacts();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("follows a successful empty publication instead of retaining the preview", async () => {
    mocks.useReportCardsV9.mockReturnValue(query(makeReportCardsV9Response({
      updatedAt: PREVIEW_PUBLISHED_AT_SEC,
      cards: [],
    })));
    await renderPreview();
    expect(screen.queryByText("Grades as of 2026-10-27")).toBeNull();
    expect(screen.getByText(/No coins match this filter/)).toBeTruthy();
  });

  it("takes an admitted live downgrade over a higher build preview", async () => {
    mocks.useReportCardsV9.mockReturnValue(query(makeReportCardsV9Response({
      updatedAt: PREVIEW_PUBLISHED_AT_SEC + 600,
      cards: [makeV9Card({ id: "asset-a", grade: "F", score: 30 })],
    })));
    await renderPreview();
    expect(screen.queryByText("Grades as of 2026-10-27")).toBeNull();
    expect(getMatrixRows()).toHaveLength(1);
  });

  it("never regresses to the build preview after a refetch failure with accepted live data", async () => {
    mocks.useReportCardsV9.mockReturnValue({
      ...query(makeReportCardsV9Response({
        updatedAt: PREVIEW_PUBLISHED_AT_SEC + 600,
        cards: [makeV9Card({ id: "asset-a", grade: "C", score: 55 })],
      })),
      error: new Error("Refetch failed"),
    });
    await renderPreview();
    expect(screen.queryByText("Grades as of 2026-10-27")).toBeNull();
    expect(getMatrixRows()).toHaveLength(1);
  });

  it("keeps the dated preview when the live publication is older, and lets a changed methodology win", async () => {
    holdPreviewClock();
    const older = makeReportCardsV9Response({
      updatedAt: PREVIEW_PUBLISHED_AT_SEC - 600,
      cards: [makeV9Card({ id: "asset-a", grade: "C", score: 55 })],
    });
    mocks.useReportCardsV9.mockReturnValue(query(older));
    const { unmount } = await renderPreview();
    expectPreviewFacts();
    unmount();

    mocks.useReportCardsV9.mockReturnValue(query({ ...older,
      safetyScoreIdentity: { ...older.safetyScoreIdentity, methodologyVersion: "9.1" },
      methodology: { ...older.methodology, version: "9.1" },
    }));
    await renderPreview();
    expect(screen.queryByText(/Grades as of 2026-10-27/)).toBeNull();
    expect(getMatrixRows()).toHaveLength(1);
  });

  it.each([
    ["loading", 1000], ["paused", 1000], ["failed", 1000], ["failed", 2_147_484_647],
  ] as const)("expires a mounted preview while ratings remain %s (%i ms before expiry)", async (state, delay) => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const preview = makePreview();
    vi.setSystemTime(new Date(preview.expiresAtSec * 1000 - delay));
    mocks.useReportCardsV9.mockReturnValue({
      ...query(undefined), isLoading: state === "loading", isPending: state !== "failed",
      error: state === "failed" ? new Error("Ratings unavailable") : null,
    });
    mocks.useStablecoins.mockReturnValue(query(undefined));
    await render(<ReportCardsV9Client initialPreview={preview} />);
    act(() => vi.advanceTimersByTime(0));
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), Math.min(delay, 2_147_483_647));
    act(() => vi.advanceTimersByTime(delay - 1));
    expectPreviewFacts();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText(/Grades as of 2026-10-27/)).toBeNull();
    if (state !== "loading") {
      expect(screen.getByRole("alert").textContent).toContain("Legacy ratings are not used as a fallback");
    }
    vi.useRealTimers();
  });

  it("drops an expired preview after hydration and falls back to the neutral unavailable state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T00:00:00Z"));
    mocks.useReportCardsV9.mockReturnValue(query(undefined));
    mocks.useStablecoins.mockReturnValue(query(undefined));
    await renderPreview();
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(screen.queryByText(/Grades as of 2026-10-27/)).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Legacy ratings are not used as a fallback");
    vi.useRealTimers();
  });

  it("uses Control for the compact pillar sort label", async () => {
    await render(<ReportCardsV9Client />);
    expect(screen.getAllByRole("button", { name: "Control" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Econ. Control" })).toBeNull();
  });

  it("gates the Compact/Spacious density toggle to desktop table view (>= 1024px)", async () => {
    installMatchMediaMock(false);
    const { unmount } = await render(<ReportCardsV9Client />);
    expect(screen.getAllByRole("radiogroup", { name: "Table density" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("radio", { name: "Compact rows" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("radio", { name: "Spacious rows" }).length).toBeGreaterThan(0);
    unmount();

    installMatchMediaMock(true);
    await render(<ReportCardsV9Client />);
    expect(screen.queryByRole("radiogroup", { name: "Table density" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Compact rows" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Spacious rows" })).toBeNull();
  });
});

// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupFrontendTest, createNextLinkMock } from "@/test-utils/frontend";
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
vi.mock("@/components/report-card-mini-v9", () => ({
  ReportCardMiniV9: ({ card }: { card: { id: string } }) => <div data-testid="v9-card">{card.id}</div>,
}));
vi.mock("@/components/query-freshness-notices", () => ({
  QueryFreshnessNotices: () => null,
}));

import { ReportCardsV9Client } from "./v9-client";

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

function expectPreviewFacts() {
  expect(screen.getAllByText("Grades as of 2026-10-27")).toHaveLength(1);
  expect(screen.getByText("Top 2 of 2 rated active stablecoins by Safety Score")).toBeTruthy();
  expect(document.querySelector('a[href="/stablecoin/asset-a/"]')).not.toBeNull();
  expect(document.querySelector('a[href="/stablecoin/asset-b/"]')).not.toBeNull();
  expect(screen.getByText("90/100")).toBeTruthy();
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
      { id: "asset-a", pegType: "peggedUSD" },
      { id: "asset-b", pegType: "peggedEUR" },
    ] }));
  });

  afterEach(cleanupFrontendTest);

  it.each(["loading", "failed"])("keeps the hero map without numeric stats while ratings are %s", (state) => {
    mocks.useReportCardsV9.mockReturnValue({
      ...query(undefined),
      isLoading: state === "loading",
      error: state === "failed" ? new Error("Ratings unavailable") : null,
    });
    const html = renderToStaticMarkup(<ReportCardsV9Client />);
    expect(html.match(/<img\b[^>]*src="\/safety-scores\/map\.webp"/g)).toHaveLength(1);
    const { container } = render(<ReportCardsV9Client />);
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
  ] as const)("hides hero stat slots for loaded %s ratings", (_state, cards) => {
    mocks.useReportCardsV9.mockReturnValue(query(makeReportCardsV9Response({ cards: [...cards] })));

    const { container } = render(<ReportCardsV9Client />);
    const hero = screen.getByRole("group", { name: "Ecosystem safety overview" });
    expect(container.querySelectorAll('img[src="/safety-scores/map.webp"]')).toHaveLength(1);
    const image = hero.querySelector("img")!;
    expect(image.getAttribute("fetchPriority")).toBe("high");
    expect(image.getAttribute("loading")).toBe("eager");
    expect(hero.querySelector("[data-slot=skeleton], .animate-pulse")).toBeNull();
    expect(hero.textContent).not.toMatch(/Ecosystem read|Ecosystem avg|Supply in A\/B|By asset count|[0-9]/);
  });

  it("keeps the high-priority PNG preview when the WebP derivative is missing or fails", () => {
    render(<ReportCardsV9Client />);
    const preview = screen.getByRole("link", { name: "Open the Safety Score Map" });
    const image = preview.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("/safety-scores/map.webp");
    expect(image.getAttribute("fetchPriority")).toBe("high");
    expect(preview.querySelectorAll("img")).toHaveLength(1);

    // A 404, transport failure, or decoding failure all dispatch image error.
    fireEvent.error(image);
    expect(image.getAttribute("src")).toBe("/safety-scores/map.png");
    expect(image.getAttribute("fetchPriority")).toBe("high");
    expect(image.getAttribute("alt")).toBe("");
    expect(preview.querySelectorAll("img")).toHaveLength(1);
    expect(preview.textContent).not.toContain("Full market map");

    // The existing unavailable panel is reserved for both formats failing.
    fireEvent.error(image);
    expect(preview.querySelector("img")).toBeNull();
    expect(preview.textContent).toContain("Full market map");
  });

  it("leaves held publication to /status while keeping accepted ratings visible", () => {
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
    render(<ReportCardsV9Client />);
    expect(screen.queryByText(/Ratings are held at the last verified snapshot/)).toBeNull();
    expect(document.body.textContent).not.toContain("assessment-failed");
    expect(document.body.textContent).not.toContain("internal assessment detail");
    expect(screen.getByTestId("v9-card").textContent).toBe("asset-a");
  });

  it("does not show a held-publication notice for current ratings", () => {
    render(<ReportCardsV9Client />);
    expect(screen.queryByText(/Ratings are held at the last verified snapshot/)).toBeNull();
    expect(screen.getAllByTestId("v9-card")).toHaveLength(2);
  });

  it("filters technical gaps separately from NR while retaining rated partial cards", () => {
    mocks.useReportCardsV9.mockReturnValue(query(makeReportCardsV9Response({ cards: [
      makeReportCardsV9PartialCard("exit", "B", { id: "partial", score: 75 }),
      makeReportCardsV9PipelineGapCard("control", "A", { id: "gap" }),
      makeV9Card({ id: "nr", score: null, grade: "NR" }),
    ] })));
    render(<ReportCardsV9Client />);
    fireEvent.click(screen.getAllByRole("button", { name: "Pipeline gap (1)" })[0]);
    expect(screen.getByTestId("v9-card").textContent).toBe("gap");
    fireEvent.click(screen.getAllByRole("button", { name: "NR (1)" })[0]);
    expect(screen.getByTestId("v9-card").textContent).toBe("nr");
    fireEvent.click(screen.getAllByRole("button", { name: "B (1)" })[0]);
    expect(screen.getByTestId("v9-card").textContent).toBe("partial");
  });

  it("labels the non-USD, non-commodity peg bucket as other pegs", () => {
    mocks.useReportCardsV9.mockReturnValue(query(makeReportCardsV9Response({
      cards: [
        makeV9Card({ id: "usdc-circle", grade: "A", score: 90 }),
        makeV9Card({ id: "eurs-stasis", grade: "B", score: 75 }),
      ],
    })));
    render(<ReportCardsV9Client />);

    fireEvent.click(screen.getAllByRole("button", { name: "Other pegs" })[0]);

    expect(screen.getAllByTestId("v9-card")).toHaveLength(1);
    expect(screen.getByTestId("v9-card").textContent).toBe("eurs-stasis");
    expect(screen.getByText(/· other peg/)).toBeTruthy();
  });

  it("keeps the peg filter usable while the independent stablecoins read is unavailable", () => {
    mocks.useReportCardsV9.mockReturnValue(query(makeReportCardsV9Response({
      cards: [
        makeV9Card({ id: "usdc-circle", grade: "A", score: 90 }),
        makeV9Card({ id: "usdt-tether", grade: "B", score: 75 }),
      ],
    })));
    mocks.useStablecoins.mockReturnValue(query(undefined));

    render(<ReportCardsV9Client />);
    fireEvent.click(screen.getAllByRole("button", { name: "USD" })[0]);

    expect(screen.getAllByTestId("v9-card")).toHaveLength(2);
    expect(screen.queryByText(/No coins match this filter/)).toBeNull();
  });

  it("shows V9 unavailable without a V8 fallback", () => {
    mocks.useReportCardsV9.mockReturnValue({
      ...query(undefined),
      error: new Error("V9 unavailable"),
    });

    render(<ReportCardsV9Client />);

    expect(screen.getByRole("alert").textContent).toContain(
      "V8 ratings are not used as a fallback",
    );
  });

  it.each(["loading", "failed"])("keeps ratings visible when the independent supply query is %s", (state) => {
    mocks.useStablecoins.mockReturnValue({
      ...query(undefined), isLoading: state === "loading",
      error: state === "failed" ? new Error("Supply unavailable") : null,
    });
    render(<ReportCardsV9Client />);
    expect(screen.getAllByTestId("v9-card")).toHaveLength(2);
    // Headline detail plus the supply row's dashed strip; never a 0% bar.
    expect(screen.getAllByText("Supply unavailable")).toHaveLength(2);
    expect(screen.queryByRole("img", { name: /by supply/ })).toBeNull();
    expect(screen.queryByText("0%")).toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("labels partial supply headlines without hiding otherwise valid ratings", () => {
    mocks.useStablecoins.mockReturnValue(query({ peggedAssets: [
      { id: "asset-a", pegType: "peggedUSD", circulating: { peggedUSD: 100 } },
      { id: "asset-b", pegType: "peggedEUR", circulating: {} },
    ] }));
    render(<ReportCardsV9Client />);
    expect(screen.getAllByTestId("v9-card")).toHaveLength(2);
    expect(screen.getByText("Known supply in A/B")).toBeTruthy();
    expect(screen.getByText(/1\/2 rated assets observed/)).toBeTruthy();
    expect(screen.queryByText("Supply in A/B")).toBeNull();
    expect(screen.getByText("By known supply")).toBeTruthy();
    expect(screen.getByText("$100.00 · 1 of 2 rated")).toBeTruthy();
    expect(screen.getByText(/Supply unavailable for 1 rated asset: excluded, not counted as zero/)).toBeTruthy();
  });

  it("renders observed zero dollars with an unavailable zero-denominator percentage", () => {
    mocks.useStablecoins.mockReturnValue(query({ peggedAssets: [
      { id: "asset-a", circulating: { peggedUSD: 0 } },
      { id: "asset-b", circulating: { peggedUSD: 0 } },
    ] }));
    render(<ReportCardsV9Client />);
    expect(screen.getByText("$0.00")).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
    expect(screen.getAllByTestId("v9-card")).toHaveLength(2);
  });

  it("server-renders and hydrates the dated preview while the native query is pending", () => {
    mocks.useReportCardsV9.mockReturnValue({ ...query(undefined), isLoading: true });
    mocks.useStablecoins.mockReturnValue(query(undefined));
    const preview = makePreview();

    const html = renderToStaticMarkup(<ReportCardsV9Client initialPreview={preview} />);
    expect(html).toContain("Grades as of 2026-10-27");
    expect(html).toContain('href="/stablecoin/asset-a/"');
    render(<ReportCardsV9Client initialPreview={preview} />);
    expectPreviewFacts();
    // Hero and controls stay neutral: no preview-derived aggregate.
    expect(screen.getByRole("group", { name: "Ecosystem safety overview" }).textContent).not.toMatch(/[0-9]/);
  });

  it("retains the preview and its links through an initial API failure", () => {
    mocks.useReportCardsV9.mockReturnValue({
      ...query(undefined),
      isLoading: false,
      error: new Error("Ratings unavailable"),
    });
    render(<ReportCardsV9Client initialPreview={makePreview()} />);
    expectPreviewFacts();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("replaces the preview once an equal or newer admitted publication arrives", () => {
    mocks.useReportCardsV9.mockReturnValue(query(makeReportCardsV9Response({
      updatedAt: PREVIEW_PUBLISHED_AT_SEC,
      cards: [makeV9Card({ id: "asset-a", grade: "C", score: 55 })],
    })));
    render(<ReportCardsV9Client initialPreview={makePreview()} />);
    expect(screen.queryByText("Grades as of 2026-10-27")).toBeNull();
    expect(screen.getAllByTestId("v9-card")).toHaveLength(1);
  });

  it("follows a successful empty publication instead of retaining the preview", () => {
    mocks.useReportCardsV9.mockReturnValue(query(makeReportCardsV9Response({
      updatedAt: PREVIEW_PUBLISHED_AT_SEC,
      cards: [],
    })));
    render(<ReportCardsV9Client initialPreview={makePreview()} />);
    expect(screen.queryByText("Grades as of 2026-10-27")).toBeNull();
    expect(screen.getByText(/No coins match this filter/)).toBeTruthy();
  });

  it("takes an admitted live downgrade over a higher build preview", () => {
    mocks.useReportCardsV9.mockReturnValue(query(makeReportCardsV9Response({
      updatedAt: PREVIEW_PUBLISHED_AT_SEC + 600,
      cards: [makeV9Card({ id: "asset-a", grade: "F", score: 30 })],
    })));
    render(<ReportCardsV9Client initialPreview={makePreview()} />);
    expect(screen.queryByText("Grades as of 2026-10-27")).toBeNull();
    expect(screen.getAllByTestId("v9-card")).toHaveLength(1);
  });

  it("never regresses to the build preview after a refetch failure with accepted live data", () => {
    mocks.useReportCardsV9.mockReturnValue({
      ...query(makeReportCardsV9Response({
        updatedAt: PREVIEW_PUBLISHED_AT_SEC + 600,
        cards: [makeV9Card({ id: "asset-a", grade: "C", score: 55 })],
      })),
      error: new Error("Refetch failed"),
    });
    render(<ReportCardsV9Client initialPreview={makePreview()} />);
    expect(screen.queryByText("Grades as of 2026-10-27")).toBeNull();
    expect(screen.getAllByTestId("v9-card")).toHaveLength(1);
  });

  it("keeps the dated preview when the live publication is older, and lets a changed methodology win", () => {
    mocks.useReportCardsV9.mockReturnValue(query(makeReportCardsV9Response({
      updatedAt: PREVIEW_PUBLISHED_AT_SEC - 600,
      cards: [makeV9Card({ id: "asset-a", grade: "C", score: 55 })],
    })));
    const { unmount } = render(<ReportCardsV9Client initialPreview={makePreview()} />);
    expectPreviewFacts();
    unmount();

    const changed = makeReportCardsV9Response({
      updatedAt: PREVIEW_PUBLISHED_AT_SEC - 600,
      cards: [makeV9Card({ id: "asset-a", grade: "C", score: 55 })],
    });
    changed.safetyScoreIdentity = {
      ...changed.safetyScoreIdentity,
      methodologyVersion: "9.1",
    };
    changed.methodology = { ...changed.methodology, version: "9.1" };
    mocks.useReportCardsV9.mockReturnValue(query(changed));
    render(<ReportCardsV9Client initialPreview={makePreview()} />);
    expect(screen.queryByText(/Grades as of 2026-10-27/)).toBeNull();
    expect(screen.getAllByTestId("v9-card")).toHaveLength(1);
  });

  it("drops an expired preview after hydration and falls back to the neutral unavailable state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T00:00:00Z"));
    mocks.useReportCardsV9.mockReturnValue({ ...query(undefined), isLoading: false });
    mocks.useStablecoins.mockReturnValue(query(undefined));
    render(<ReportCardsV9Client initialPreview={makePreview()} />);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(screen.queryByText(/Grades as of 2026-10-27/)).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("V8 ratings are not used as a fallback");
    vi.useRealTimers();
  });
});

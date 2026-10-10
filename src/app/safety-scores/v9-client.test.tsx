// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupFrontendTest, createNextLinkMock } from "@/test-utils/frontend";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";
import { makeReportCardsV9PartialCard, makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";

const mocks = vi.hoisted(() => ({
  useReportCardsV9: vi.fn(),
  useStablecoins: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({ useReportCardsV9: mocks.useReportCardsV9 }));
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

  it("keeps the production grade-grouped card grid and V9 controls", () => {
    render(<ReportCardsV9Client />);

    expect(screen.getAllByTestId("v9-card")).toHaveLength(2);
    expect(screen.getByText("Filter:")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Backing" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Econ. Control" }).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Safety score cards")).toBeTruthy();
    expect(screen.queryByText(/assets are scored/)).toBeNull();
    expect(screen.getByRole("heading", { name: "Three questions behind every grade" })).toBeTruthy();
    expect(screen.getByText("Is there real value behind the token?")).toBeTruthy();
    expect(screen.getByText("Can I get my value out?")).toBeTruthy();
    expect(screen.getByText("Who can change or break the system?")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Find your coin" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open the Safety Score Map" }).getAttribute("href")).toBe(
      "/safety-scores/map/",
    );
  });
  it("discloses a fresh successful held publication while keeping accepted ratings visible", () => {
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
    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain("Ratings are held at the last verified snapshot");
    expect(notice.textContent).toContain("The latest ratings update could not be verified.");
    expect(notice.querySelector("time")?.getAttribute("datetime")).toBe(new Date((nowSec - 60) * 1000).toISOString());
    expect(notice.textContent).not.toContain("assessment-failed");
    expect(notice.textContent).not.toContain("internal assessment detail");
    expect(screen.getByTestId("v9-card").textContent).toBe("asset-a");
  });

  it("does not show a held-publication notice for current ratings", () => {
    render(<ReportCardsV9Client />);
    expect(screen.queryByText(/Ratings are held at the last verified snapshot/)).toBeNull();
    expect(screen.getAllByTestId("v9-card")).toHaveLength(2);
  });

  it("filters the card grid by the existing grade controls", () => {
    render(<ReportCardsV9Client />);

    fireEvent.click(screen.getAllByRole("button", { name: "A (1)" })[0]);
    expect(screen.getAllByTestId("v9-card")).toHaveLength(1);
    expect(screen.getByTestId("v9-card").textContent).toBe("asset-a");
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

  it("filters the card grid by consolidated peg groups", () => {
    render(<ReportCardsV9Client />);

    fireEvent.click(screen.getAllByRole("button", { name: "Fiat non USD" })[0]);
    expect(screen.getAllByTestId("v9-card")).toHaveLength(1);
    expect(screen.getByTestId("v9-card").textContent).toBe("asset-b");
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
    expect(screen.getByText("Supply unavailable")).toBeTruthy();
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
});

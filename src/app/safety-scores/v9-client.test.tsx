// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";

const mocks = vi.hoisted(() => ({
  useReportCardsV9: vi.fn(),
  useStablecoins: vi.fn(),
  useLogos: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({ useReportCardsV9: mocks.useReportCardsV9 }));
vi.mock("@/hooks/use-stablecoins", () => ({ useStablecoins: mocks.useStablecoins }));
vi.mock("@/hooks/use-logos", () => ({ useLogos: mocks.useLogos }));
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
    mocks.useReportCardsV9.mockReturnValue(query(makeReportCardsV9Response({
      cards: [
        makeV9Card({ id: "asset-a", grade: "A", score: 90 }),
        makeV9Card({ id: "asset-b", grade: "B", score: 75 }),
      ],
    })));
    mocks.useStablecoins.mockReturnValue(query({ peggedAssets: [] }));
    mocks.useLogos.mockReturnValue({ data: {} });
  });

  afterEach(cleanup);

  it("keeps the production grade-grouped card grid and V9 controls", () => {
    render(<ReportCardsV9Client />);

    expect(screen.getAllByTestId("v9-card")).toHaveLength(2);
    expect(screen.getByText("Filter:")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Backing" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Econ. Control" }).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Safety score cards")).toBeTruthy();
  });

  it("filters the card grid by the existing grade controls", () => {
    render(<ReportCardsV9Client />);

    fireEvent.click(screen.getAllByRole("button", { name: "A (1)" })[0]);
    expect(screen.getAllByTestId("v9-card")).toHaveLength(1);
    expect(screen.getByTestId("v9-card").textContent).toBe("asset-a");
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
});

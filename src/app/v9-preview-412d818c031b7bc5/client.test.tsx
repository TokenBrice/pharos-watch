// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";
import { SafetyScoreV9PreviewClient } from "./client";

const { useReportCardsV9Preview } = vi.hoisted(() => ({ useReportCardsV9Preview: vi.fn() }));

vi.mock("@/hooks/api-hooks", () => ({ useReportCardsV9Preview }));
vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: ({ name }: { name: string }) => <span data-testid="logo">{name}</span>,
}));

describe("SafetyScoreV9PreviewClient", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders candidate scores and filters by asset identity", () => {
    const cards = [
      makeV9Card(),
      makeV9Card({
        id: "usdt-tether",
        score: 72,
        grade: "B-",
        qualityScore: 74,
        pegAdjustedScore: 72,
      }),
    ];
    useReportCardsV9Preview.mockReturnValue({
      data: makeReportCardsV9Response({ cards }),
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    render(<SafetyScoreV9PreviewClient />);

    expect(screen.getByText("USDC")).toBeTruthy();
    expect(screen.getByText("USDT")).toBeTruthy();
    expect(screen.getByLabelText("Safety grade B+, score 84")).toBeTruthy();
    expect(screen.getByText("2 of 2 assets")).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search candidate ratings" }), {
      target: { value: "tether" },
    });

    expect(screen.queryByText("USDC")).toBeNull();
    expect(screen.getByText("USDT")).toBeTruthy();
    expect(screen.getByText("1 of 2 assets")).toBeTruthy();
  });

  it("shows a retryable unavailable state without implying V8 is affected", () => {
    const refetch = vi.fn();
    useReportCardsV9Preview.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("offline"),
      refetch,
    });

    render(<SafetyScoreV9PreviewClient />);

    expect(screen.getByRole("alert").textContent).toContain("live V8 ratings are unaffected");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("renders an accessible loading state", () => {
    useReportCardsV9Preview.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      refetch: vi.fn(),
    });

    render(<SafetyScoreV9PreviewClient />);

    expect(screen.getByRole("status", { name: "Loading V9 shadow ratings" })).toBeTruthy();
  });
});

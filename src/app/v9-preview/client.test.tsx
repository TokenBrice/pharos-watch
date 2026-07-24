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
      makeV9Card({ evidence: { level: "strong", freshness: "unknown", reasons: [] } }),
      makeV9Card({
        id: "usdt-tether",
        score: 72,
        grade: "B",
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
    expect(screen.getByLabelText("Safety grade A, score 84")).toBeTruthy();
    expect(screen.getByText("2 of 2 assets")).toBeTruthy();
    expect(screen.getByText("Grade distribution")).toBeTruthy();
    expect(screen.getByText("2 assets")).toBeTruthy();
    expect(document.querySelector('[title="Grade A: 1"]')).toBeTruthy();
    expect(document.querySelector('[title="Grade B: 1"]')).toBeTruthy();
    expect(screen.getByText("Strong")).toBeTruthy();
    expect(screen.queryByText("Unknown")).toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search candidate ratings" }), {
      target: { value: "tether" },
    });

    expect(screen.queryByText("USDC")).toBeNull();
    expect(screen.getByText("USDT")).toBeTruthy();
    expect(screen.getByText("1 of 2 assets")).toBeTruthy();
    expect(document.querySelector('[title="Grade A: 1"]')).toBeTruthy();
    expect(document.querySelector('[title="Grade B: 1"]')).toBeTruthy();
  });

  it("shows a retryable unavailable state without implying V8 is affected", () => {
    const refetch = vi.fn();
    useReportCardsV9Preview.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetching: false,
      error: new Error("offline"),
      refetch,
    });

    render(<SafetyScoreV9PreviewClient />);

    expect(screen.getByRole("alert").textContent).toContain("live V8 ratings are unaffected");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("shows visible progress while retrying the unavailable preview", () => {
    useReportCardsV9Preview.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetching: true,
      error: new Error("offline"),
      refetch: vi.fn(),
    });

    render(<SafetyScoreV9PreviewClient />);

    const alert = screen.getByRole("alert");
    const retry = screen.getByRole("button", { name: "Retrying" });
    expect(alert.getAttribute("aria-busy")).toBe("true");
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    expect(retry.querySelector("svg")?.getAttribute("class")).toContain("animate-spin");
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

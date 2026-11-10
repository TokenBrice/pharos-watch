// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const { useHomepageHistoryMock } = vi.hoisted(() => ({
  useHomepageHistoryMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useHomepageHistory: useHomepageHistoryMock,
}));

vi.mock("next/dynamic", () => ({
  default: () => function MockChart() {
    return <div data-testid="hero-chart" />;
  },
}));

import { HomeAltHeroLiveChart } from "@/components/home-alt-hero-live-chart";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HomeAltHeroLiveChart", () => {
  it("settles an empty live history into the neutral placeholder", () => {
    useHomepageHistoryMock.mockReturnValue({
      data: { rows: [] },
      error: null,
      isLoading: false,
    });

    render(<HomeAltHeroLiveChart nowMs={Date.now()} />);

    expect(screen.getByText("Updating")).toBeTruthy();
    expect(screen.queryByTestId("hero-chart")).toBeNull();
  });

  it("keeps the live chart when the read carries rows", () => {
    useHomepageHistoryMock.mockReturnValue({
      data: { rows: [{ ts: 1, total: 1, usdt: null, usdc: null, sky: null, others: null }] },
      error: null,
      isLoading: false,
    });

    render(<HomeAltHeroLiveChart nowMs={Date.now()} />);

    expect(screen.getByTestId("hero-chart")).toBeTruthy();
    expect(screen.queryByText("Updating")).toBeNull();
  });
});

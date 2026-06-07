// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HomeAltClient } from "@/components/home-alt-client";

const {
  homeAltRankingsPropsMock,
  homeAltMiniCardGridMock,
  useHomepageDiscoverySuggestionsMock,
} = vi.hoisted(() => ({
  homeAltRankingsPropsMock: vi.fn(),
  homeAltMiniCardGridMock: vi.fn(),
  useHomepageDiscoverySuggestionsMock: vi.fn(),
}));

vi.mock("next/dynamic", () => ({
  default: (loader: () => unknown) => {
    const source = String(loader);
    if (source.includes("home-alt-mini-card-grid")) {
      function MockHomeAltMiniCardGrid() {
        homeAltMiniCardGridMock();
        return <div data-testid="home-alt-mini-card-grid" />;
      }

      return MockHomeAltMiniCardGrid;
    }

    if (source.includes("home-alt-rankings-section")) {
      function MockHomeAltRankingsSection(props: Record<string, unknown>) {
        homeAltRankingsPropsMock(props);
        return <div data-testid="home-alt-rankings-section" />;
      }

      return MockHomeAltRankingsSection;
    }

    function MockDailyDigest() {
      return <div data-testid="daily-digest" />;
    }

    return MockDailyDigest;
  },
}));

vi.mock("@/components/lazy-section", () => ({
  LazySection: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/use-homepage-discovery", () => ({
  useHomepageDiscoverySuggestions: useHomepageDiscoverySuggestionsMock,
}));

vi.mock("@/components/homepage-discovery-module", () => ({
  HomepageDiscoveryModule: () => <div data-testid="homepage-discovery-module" />,
}));

describe("HomeAltClient", () => {
  beforeEach(() => {
    homeAltRankingsPropsMock.mockClear();
    homeAltMiniCardGridMock.mockClear();
    useHomepageDiscoverySuggestionsMock.mockReturnValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps the rankings module behind the homepage lazy boundary", () => {
    render(<HomeAltClient />);

    expect(screen.getByTestId("home-alt-mini-card-grid")).toBeTruthy();
    expect(screen.getByTestId("daily-digest")).toBeTruthy();
    expect(screen.getByTestId("homepage-discovery-module")).toBeTruthy();
    expect(screen.getByTestId("home-alt-rankings-section")).toBeTruthy();
    expect(
      document.querySelector('section[aria-label="Daily digest"]')?.className,
    ).not.toContain("min-h-");
    expect(document.getElementById("home-alt-rankings")).toBeTruthy();
    expect(homeAltRankingsPropsMock).toHaveBeenCalledWith({
      titleId: "home-alt-rankings-title",
    });
  });
});

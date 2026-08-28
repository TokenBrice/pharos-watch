// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PegDiversityHeroLive } from "@/app/alt-pegs/fiat-world-atlas/peg-diversity-hero-live";

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: () => ({
    data: { peggedAssets: [] },
    isLoading: false,
    isError: false,
  }),
}));

vi.mock("@/app/alt-pegs/fiat-world-atlas/sky-layer", () => ({
  SkyLayer: () => null,
}));

vi.mock("@/app/alt-pegs/fiat-world-atlas/fiat-emblems", () => ({
  FiatEmblems: () => null,
}));

vi.mock("@/lib/alt-peg-hero", () => ({
  buildPegDiversityHero: () => ({ skyCohorts: [], pegClusters: [] }),
}));

vi.mock("@/lib/alt-peg-market", () => ({
  buildAltPegSnapshot: () => ({
    distributionRows: [
      { peg: "EUR", label: "Euro", href: "/alt-pegs/euro", marketCap: 10, sharePct: 10, colorHex: "#1d4ed8" },
      { peg: "GBP", label: "Pound", href: "/alt-pegs/pound", marketCap: 9, sharePct: 9, colorHex: "#15803d" },
      { peg: "JPY", label: "Yen", href: "/alt-pegs/yen", marketCap: 8, sharePct: 8, colorHex: "#b91c1c" },
      { peg: "CHF", label: "Franc", href: "/alt-pegs/franc", marketCap: 7, sharePct: 7, colorHex: "#7c3aed" },
      { peg: "CAD", label: "Dollar", href: "/alt-pegs/dollar", marketCap: 6, sharePct: 6, colorHex: "#ea580c" },
      { peg: "AUD", label: "Aussie", href: "/alt-pegs/aussie", marketCap: 5, sharePct: 5, colorHex: "#0f766e" },
    ],
    topRows: [],
  }),
}));

describe("PegDiversityHeroLive", () => {

  it("shows the size key in the map frame and expands the cohort strip to five rows", () => {
    const { container } = render(<PegDiversityHeroLive worldMap={<div data-testid="world-map" />} />);

    expect(screen.getByLabelText("Fiat market cap size key")).toBeTruthy();
    expect(screen.queryByText("Fiat logo size")).toBeNull();
    expect(container.querySelector(".peg-hero__earth .peg-hero__scale-key")).not.toBeNull();
    expect(container.querySelector(".peg-hero__map-frame .peg-hero__scale-key")).toBeNull();
    expect(screen.getByText("Largest Cohorts")).toBeTruthy();
    expect(screen.getAllByRole("link")).toHaveLength(5);
  });

  it("omits the cohort overview in fullscreen mode", () => {
    render(<PegDiversityHeroLive worldMap={<div data-testid="world-map" />} variant="fullscreen" />);

    expect(screen.queryByText("Largest Cohorts")).toBeNull();
  });
});

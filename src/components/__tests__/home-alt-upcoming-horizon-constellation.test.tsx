// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HomeAltUpcomingHorizonConstellation } from "@/components/home-alt-upcoming-horizon-constellation";
import type * as HorizonConstellationLayoutModule from "@/lib/horizon-constellation-layout";

const horizonFixture = vi.hoisted(() =>
  Array.from({ length: 13 }, (_, index) => ({
    id: `coin-${index}`, name: `Coin ${index}`, symbol: `C${index}`,
    status: "pre-launch", launchPhase: "announced",
    expectedLaunchDate: `2027-01-${String(index + 1).padStart(2, "0")}`,
  })),
);

vi.mock("@/lib/horizon-constellation-layout", async (importOriginal) => ({
  ...(await importOriginal<typeof HorizonConstellationLayoutModule>()),
  HORIZON_PRE_LAUNCH_STABLECOINS: horizonFixture,
}));

vi.mock("@shared/lib/stablecoins/client-registry", () => ({
  CLIENT_TRACKED_STABLECOINS: horizonFixture,
}));
vi.mock("@/lib/logos", () => ({ logosById: {} }));

describe("HomeAltUpcomingHorizonConstellation", () => {
  it("represents thirteen coins as eight dots and an exact five-coin overflow", () => {
    render(<HomeAltUpcomingHorizonConstellation />);
    const dots = screen.getAllByRole("link").filter((link) => link.getAttribute("href")?.startsWith("/stablecoin/"));
    expect(dots.map((link) => link.getAttribute("href"))).toEqual([
      ...Array.from({ length: 8 }, (_, index) => `/stablecoin/coin-${index}`),
      ...Array.from({ length: 8 }, (_, index) => `/stablecoin/coin-${index}`),
    ]);
    expect(screen.getAllByText("+5")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "5 more announced stablecoins" }).getAttribute("href")).toMatch(/^\/upcoming\/?$/);
    expect(screen.getByRole("link", { name: "Open tracker" }).getAttribute("href")).toMatch(/^\/upcoming\/?$/);
  });

  it("renders nothing for an empty registry", () => {
    const coins = horizonFixture.splice(0);
    try {
      const { container } = render(<HomeAltUpcomingHorizonConstellation />);
      expect(container.firstChild).toBeNull();
    } finally {
      horizonFixture.push(...coins);
    }
  });
});

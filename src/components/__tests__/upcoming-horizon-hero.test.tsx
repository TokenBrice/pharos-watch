// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UpcomingHorizonHero } from "@/components/upcoming-horizon-hero";

vi.mock("@shared/lib/stablecoins/client-registry", () => ({
  CLIENT_TRACKED_STABLECOINS: Array.from({ length: 13 }, (_, index) => ({
    id: `horizon-${index}`, name: `Horizon ${index}`, symbol: `H${index}`,
    status: "pre-launch", launchPhase: "announced", expectedLaunchDate: "2027-01-01",
  })),
}));
vi.mock("@/lib/logos", () => ({ logosById: {} }));

describe("UpcomingHorizonHero", () => {
  it("links the exact eight displayed identities and five-coin overflow", () => {
    render(<UpcomingHorizonHero />);
    const links = screen.getAllByRole("link");
    const coinLinks = links.filter((link) => link.getAttribute("href")?.startsWith("/stablecoin/"));
    expect(coinLinks.map((link) => link.getAttribute("href"))).toEqual([
      ...Array.from({ length: 8 }, (_, index) => `/stablecoin/horizon-${index}`),
      ...Array.from({ length: 8 }, (_, index) => `/stablecoin/horizon-${index}`),
    ]);
    const overflow = screen.getByRole("link", { name: "5 more announced stablecoins" });
    expect(overflow.textContent).toBe("+5");
    expect(overflow.getAttribute("href")).toBe("/upcoming");
    expect(links).toHaveLength(17);
  });
});

// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HomeAltUpcomingHorizonConstellation } from "@/components/home-alt-upcoming-horizon-constellation";
import { LAUNCH_PHASE_LABELS } from "@/lib/pre-launch";
import { PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins/registry";

vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: ({ name, size }: { name: string; size?: number }) => (
    <span data-testid="stablecoin-logo" data-name={name} style={{ width: size, height: size }} />
  ),
}));

describe("HomeAltUpcomingHorizonConstellation", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the logo constellation module with every pre-launch coin linked", () => {
    render(<HomeAltUpcomingHorizonConstellation />);

    expect(screen.getAllByText("On the Horizon")).toHaveLength(1);
    expect(screen.queryByText("Nearest launches")).toBeNull();
    expect(screen.getByRole("link", { name: /open tracker/i }).getAttribute("href")).toBe("/upcoming");

    for (const coin of PRE_LAUNCH_STABLECOINS) {
      expect(coin.launchPhase).toBeDefined();
      const links = screen.getAllByLabelText(
        `${coin.name} (${coin.symbol}) — ${LAUNCH_PHASE_LABELS[coin.launchPhase!]}`,
        { selector: "a" },
      );
      expect(links.length).toBeGreaterThan(0);
    }
  });
});

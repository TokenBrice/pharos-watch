// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HomeAltUpcomingHorizonConstellation } from "@/components/home-alt-upcoming-horizon-constellation";
import { logosById } from "@/lib/logos";
import { LAUNCH_PHASE_LABELS } from "@/lib/pre-launch";
import { PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins/registry";

describe("HomeAltUpcomingHorizonConstellation", () => {

  it("links visible coins as dots and folds ring overflow into +N tracker links", () => {
    render(<HomeAltUpcomingHorizonConstellation />);

    expect(screen.getAllByText("On The Horizon")).toHaveLength(1);
    expect(screen.queryByText("Nearest launches")).toBeNull();
    expect(screen.getByRole("link", { name: /open tracker/i }).getAttribute("href")).toBe("/upcoming");
    expect(document.querySelector(".lg\\:grid")).toBeTruthy();
    expect(document.querySelector(".lg\\:hidden")).toBeTruthy();

    // Each pre-launch coin is either its own labeled dot-link, or (when its
    // readiness ring exceeds the dot cap) folded into a "+N" overflow link —
    // never silently dropped.
    let linkedCoins = 0;
    for (const coin of PRE_LAUNCH_STABLECOINS) {
      expect(coin.launchPhase).toBeDefined();
      const links = screen.queryAllByLabelText(
        `${coin.name} (${coin.symbol}) — ${LAUNCH_PHASE_LABELS[coin.launchPhase!]}`,
        { selector: "a" },
      );
      if (links.length > 0) linkedCoins++;
      if (logosById[coin.id]) {
        for (const link of links) {
          expect(link.querySelector("img")?.getAttribute("src")).toBeTruthy();
        }
      }
    }
    expect(linkedCoins).toBeGreaterThan(0);
    expect(linkedCoins).toBeLessThanOrEqual(PRE_LAUNCH_STABLECOINS.length);

    // Any "+N" overflow indicator links to the upcoming tracker so capped coins
    // remain reachable.
    for (const node of screen.queryAllByText(/^\+\d+$/)) {
      expect(node.closest("a")?.getAttribute("href")).toContain("/upcoming");
    }
  });
});

// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { UpcomingHorizonHero } from "@/components/upcoming-horizon-hero";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { LAUNCH_PHASE_LABELS } from "@/lib/pre-launch";
import { CLIENT_TRACKED_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { isPreLaunchStablecoinMeta } from "@shared/lib/stablecoins/status";
import type { LaunchPhase } from "@shared/types";
import type { StablecoinClientMeta } from "@shared/types/stablecoin-client-meta";

type PreLaunchCoin = StablecoinClientMeta & { launchPhase: LaunchPhase };

const PRE_LAUNCH_STABLECOINS = CLIENT_TRACKED_STABLECOINS.filter(
  (coin): coin is PreLaunchCoin => isPreLaunchStablecoinMeta(coin) && Boolean(coin.launchPhase),
);
const LABEL_SEPARATOR = "\u2014";

describe("UpcomingHorizonHero", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps phase dots linked and overflow reachable across responsive layouts", () => {
    render(<UpcomingHorizonHero />);

    expect(document.querySelector(".lg\\:grid")).toBeTruthy();
    expect(document.querySelector(".lg\\:hidden")).toBeTruthy();

    let linkedCoins = 0;
    for (const coin of PRE_LAUNCH_STABLECOINS) {
      const links = screen.queryAllByLabelText(
        `${coin.name} (${coin.symbol}) ${LABEL_SEPARATOR} ${LAUNCH_PHASE_LABELS[coin.launchPhase]}`,
        { selector: "a" },
      );

      if (links.length > 0) linkedCoins++;
      const expectedHref = buildStablecoinUrl(coin.id).replace(/\/$/, "");
      for (const link of links) {
        expect(link.getAttribute("href")).toBe(expectedHref);
      }
    }

    expect(linkedCoins).toBeGreaterThan(0);
    expect(linkedCoins).toBeLessThanOrEqual(PRE_LAUNCH_STABLECOINS.length);

    for (const node of screen.queryAllByText(/^\+\d+$/)) {
      expect(node.closest("a")?.getAttribute("href")).toContain("/upcoming");
    }
  });
});

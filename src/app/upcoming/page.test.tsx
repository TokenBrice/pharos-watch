// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { PRE_LAUNCH_UNPHASED_LABEL } from "@shared/lib/classification/pre-launch";
import { isLaunchedAwaitingData } from "@/lib/pre-launch";
import UpcomingPage, { metadata } from "./page";

vi.mock("@/components/upcoming-client", () => ({ UpcomingClient: () => <div data-testid="upcoming-client" /> }));
vi.mock("@/components/share-button", () => ({ ShareButton: () => null }));

describe("UpcomingPage", () => {
  it("server-renders the launch news list, launched section and currency groups linking every pre-launch profile", () => {
    const html = renderToStaticMarkup(<UpcomingPage />);
    const document = new DOMParser().parseFromString(html, "text/html");

    expect(document.getElementById("latest-launch-news")?.textContent).toBe("Latest launch news");
    const headings = [...document.querySelectorAll("h2")].map((heading) => heading.textContent ?? "");
    expect(headings).toContain("Upcoming Hong Kong Dollar (HKD) stablecoins");

    const groups = document.querySelector('[aria-label="Upcoming stablecoins by currency"]');
    const launched = document.querySelector('[aria-labelledby="launched-not-tracked"]');
    const hrefs = [groups, launched].flatMap((section) =>
      [...(section?.querySelectorAll("a[href]") ?? [])].map((link) => link.getAttribute("href") ?? ""));
    for (const coin of PRE_LAUNCH_STABLECOINS) {
      expect(hrefs.some((href) => href.startsWith(`/stablecoin/${coin.id}`)), coin.id).toBe(true);
    }
  });

  it("publishes a phase tally whose parts account for every upcoming coin", () => {
    const upcoming = PRE_LAUNCH_STABLECOINS.filter((coin) => !isLaunchedAwaitingData(coin));
    const description = String(metadata.description);
    const tally = description.slice(
      description.indexOf("By phase: ") + "By phase: ".length,
      description.indexOf(". Targets"),
    );
    const counts = tally.split(", ").map((part) => {
      const match = /^(.+) (\d+)$/.exec(part);
      expect(match, part).not.toBeNull();
      return Number(match![2]);
    });
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(upcoming.length);
    const unphased = upcoming.filter((coin) => !coin.launchPhase).length;
    if (unphased > 0) expect(tally).toContain(`${PRE_LAUNCH_UNPHASED_LABEL} ${unphased}`);
  });
});

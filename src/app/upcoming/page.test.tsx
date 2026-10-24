// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins/registry";
import UpcomingPage from "./page";

vi.mock("@/components/upcoming-client", () => ({ UpcomingClient: () => <div data-testid="upcoming-client" /> }));
vi.mock("@/components/share-button", () => ({ ShareButton: () => null }));

describe("UpcomingPage", () => {
  it("server-renders the launch news list and currency groups linking every pre-launch profile", () => {
    const html = renderToStaticMarkup(<UpcomingPage />);
    const document = new DOMParser().parseFromString(html, "text/html");

    expect(document.getElementById("latest-launch-news")?.textContent).toBe("Latest launch news");
    const headings = [...document.querySelectorAll("h2")].map((heading) => heading.textContent ?? "");
    expect(headings).toContain("Upcoming Hong Kong Dollar (HKD) stablecoins");

    const groups = document.querySelector('[aria-label="Upcoming stablecoins by currency"]');
    const hrefs = [...(groups?.querySelectorAll("a[href]") ?? [])].map((link) => link.getAttribute("href") ?? "");
    for (const coin of PRE_LAUNCH_STABLECOINS) {
      expect(hrefs.some((href) => href.startsWith(`/stablecoin/${coin.id}`)), coin.id).toBe(true);
    }
  });
});

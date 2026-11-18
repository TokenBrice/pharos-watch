import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getActiveChainIds } from "@shared/lib/chains";
import { CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH, CHAIN_HEALTH_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import ChainsPage from "./page";

vi.mock("./client", () => ({
  ChainsLeaderboardClient: () => <div data-testid="chains-client">chains client</div>,
}));

describe("ChainsPage", () => {
  it("keeps every chain profile link and the ItemList in the static HTML, folded after the leaderboard", () => {
    const html = renderToStaticMarkup(<ChainsPage />);

    // the directory is a fold, but its links ship in the server HTML for crawlers
    const ids = getActiveChainIds();
    expect(html).toContain(`All ${ids.length} chain profiles`);
    for (const id of ids) expect(html).toContain(`href="/chains/${id}"`);
    expect(html).toContain('"@type":"ItemList"');
    expect(html).not.toContain("tracked deployment");

    expect(html).toContain("Where stablecoin supply lives, how concentrated it is, and which chains are moving.");
    expect(html).toContain(`Chain Health methodology ${CHAIN_HEALTH_METHODOLOGY_VERSION}`);
    expect(html).toContain("Chains FAQ");
    expect(html).toContain("What is the Chain Health Score?");
    expect(html).toContain('"@type":"FAQPage"');

    const client = html.indexOf("chains client");
    const faq = html.indexOf("FAQ and Chain Health methodology");
    const directory = html.indexOf(`All ${ids.length} chain profiles`);
    const footer = html.indexOf("Supply from the Pharos stablecoin snapshot");
    expect(client).toBeGreaterThan(-1);
    expect(client).toBeLessThan(faq);
    expect(faq).toBeLessThan(directory);
    expect(directory).toBeLessThan(footer);
  });

  it("links to the declared Chain Health methodology on both sides of the release clock", () => {
    vi.useFakeTimers();
    try {
      for (const now of [1_795_053_599_000, 1_795_053_600_000]) {
        vi.setSystemTime(now);
        const html = renderToStaticMarkup(<ChainsPage />);
        expect(html).toContain(`Chain Health methodology ${CHAIN_HEALTH_METHODOLOGY_VERSION}`);
        expect(html).toContain(`href="${CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH.replace(/\/$/, "")}"`);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

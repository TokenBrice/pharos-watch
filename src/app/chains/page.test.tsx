import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getActiveChainIds } from "@shared/lib/chains";
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
    expect(html).toContain("Chain Health methodology 1.8");
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
});

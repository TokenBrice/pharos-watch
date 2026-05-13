import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ChainsPage from "./page";

vi.mock("./client", () => ({
  ChainsLeaderboardClient: () => <div data-testid="chains-client">chains client</div>,
}));

describe("ChainsPage", () => {
  it("renders a visible chain directory and visible FAQ copy around the client leaderboard", () => {
    const html = renderToStaticMarkup(<ChainsPage />);

    expect(html).toContain("Chain Profile Directory");
    expect(html).toContain('href="/chains/ethereum"');
    expect(html).toContain("tracked deployment");
    expect(html).not.toContain("sr-only");

    expect(html).toContain("Chains FAQ");
    expect(html).toContain("What is the Chain Health Score?");
    expect(html).toContain("Which chains have the most stablecoin supply?");

    expect(html.indexOf("Chain Profile Directory")).toBeLessThan(html.indexOf("chains client"));
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ChainProfilePage from "./page";

vi.mock("./client", () => ({
  ChainProfileClient: ({ chainId }: { chainId: string }) => (
    <div data-testid="chain-profile-client">chain client {chainId}</div>
  ),
}));

describe("ChainProfilePage", () => {
  it("renders the live client profile before related route hubs", async () => {
    const html = renderToStaticMarkup(
      await ChainProfilePage({ params: Promise.resolve({ chain: "ethereum" }) }),
    );

    expect(html).toContain("Ethereum Stablecoins: Supply, Risk &amp; Top Deployments");
    expect(html).toContain("Ethereum has");
    expect(html).toContain("Compare cohort");
    expect(html).toContain("Set up alerts");
    expect(html).toContain("chain client ethereum");
    expect(html).toContain("Tracked Stablecoins On Ethereum");
    expect(html).toContain('href="/stablecoin/usdc-circle"');
    expect(html).toContain('href="/stablecoins"');
    expect(html).toContain('href="/safety-scores"');
    expect(html).toContain("Stablecoin Research Surfaces");
    expect(html.indexOf("chain client ethereum")).toBeLessThan(html.indexOf("Tracked Stablecoins On Ethereum"));
    expect(html.indexOf("Tracked Stablecoins On Ethereum")).toBeLessThan(html.indexOf("Related Stablecoin Hubs"));
    expect(html.indexOf("chain client ethereum")).toBeLessThan(html.indexOf("Related Stablecoin Hubs"));
  });

});

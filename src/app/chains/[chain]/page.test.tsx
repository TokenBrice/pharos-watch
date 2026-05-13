import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ChainProfilePage from "./page";

vi.mock("./client", () => ({
  ChainProfileClient: ({ chainId }: { chainId: string }) => (
    <div data-testid="chain-profile-client">chain client {chainId}</div>
  ),
}));

describe("ChainProfilePage", () => {
  it("renders static chain detail content before the live client profile", async () => {
    const html = renderToStaticMarkup(
      await ChainProfilePage({ params: Promise.resolve({ chain: "ethereum" }) }),
    );

    expect(html).toContain("Tracked deployments on Ethereum");
    expect(html).toContain("USD Coin (USDC)");
    expect(html).toContain('href="/stablecoin/usdc-circle"');
    expect(html).toContain("Open Ethereum explorer");
    expect(html).toContain("/api/chains");
    expect(html).toContain('href="/chains"');
    expect(html).toContain('href="/stablecoins"');
    expect(html).toContain('href="/safety-scores"');
    expect(html.indexOf("Tracked deployments on Ethereum")).toBeLessThan(html.indexOf("chain client ethereum"));
  });
});

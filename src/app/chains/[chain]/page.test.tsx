import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getActiveChainIds } from "@shared/lib/chains";
import { isChainProfileIndexable, MIN_INDEXABLE_CHAIN_STABLECOINS } from "@/lib/chain-indexing";
import { getTrackedDeploymentsForChain } from "../static-chain-content";
import ChainProfilePage, { generateMetadata } from "./page";

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

    expect(html).toContain("Ethereum Stablecoins: USDT, USDC, and USDe, Supply &amp; Risk");
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

  it("noindexes chain profiles with fewer tracked stablecoins than the bar, and only those", async () => {
    for (const chain of getActiveChainIds()) {
      const thin = getTrackedDeploymentsForChain(chain).length < MIN_INDEXABLE_CHAIN_STABLECOINS;
      expect(isChainProfileIndexable(chain), chain).toBe(!thin);
    }
    const thinChain = getActiveChainIds().find((chain) => !isChainProfileIndexable(chain))!;
    const thinMetadata = await generateMetadata({ params: Promise.resolve({ chain: thinChain }) });
    expect(thinMetadata.robots).toEqual({ index: false, follow: true });
    const ethereumMetadata = await generateMetadata({ params: Promise.resolve({ chain: "ethereum" }) });
    expect(ethereumMetadata.robots).toMatchObject({ index: true, follow: true });
  });

  it("ranks base coins ahead of NAV tokens and variants, and writes whole-sentence descriptions", async () => {
    for (const chain of getActiveChainIds()) {
      const deployments = getTrackedDeploymentsForChain(chain);
      const metadata = await generateMetadata({ params: Promise.resolve({ chain }) });
      const description = String(metadata.description);
      expect(description, chain).toMatch(/\.$/);
      expect(description, chain).not.toContain("…");
      expect(description, chain).not.toMatch(/tracked deployments?/);
      const baseSymbols = [...new Set(deployments.filter((d) => !d.isNavOrVariant).map((d) => d.symbol))];
      if (baseSymbols.length >= 3) {
        const [first, second, third] = baseSymbols;
        expect(description, chain).toContain(`${first}, ${second}, and ${third}.`);
      }
    }
  });
});

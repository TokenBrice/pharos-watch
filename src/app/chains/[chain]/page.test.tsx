import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getActiveChainIds } from "@shared/lib/chains";
import { CHAIN_META } from "@shared/types/chain-identity";
import { isChainProfileIndexable, MIN_INDEXABLE_CHAIN_STABLECOINS } from "@/lib/chain-indexing";
import { buildChainProfileJsonLd } from "@/lib/chain-json-ld";
import { buildContractDeploymentAnchor } from "@/lib/contract-deployment-summary";
import { getTrackedDeploymentsForChain } from "../static-chain-content";
import ChainProfilePage, { generateMetadata } from "./page";

vi.mock("./client", () => ({
  ChainProfileClient: ({ chainId }: { chainId: string }) => (
    <div data-testid="chain-profile-client">chain client {chainId}</div>
  ),
}));

const PILOT_CHAINS = [
  { chain: "solana", chainName: "Solana" },
  { chain: "base", chainName: "Base" },
  { chain: "tron", chainName: "Tron" },
] as const;

/** Base coins first, then NAV tokens and variants: the table's documented order. */
function orderedChainContracts(chain: string) {
  const deployments = getTrackedDeploymentsForChain(chain);
  return [
    ...deployments.filter((deployment) => !deployment.isNavOrVariant),
    ...deployments.filter((deployment) => deployment.isNavOrVariant),
  ].flatMap((deployment) => deployment.contracts.map((contract) => ({ deployment, contract })));
}

async function renderChainPage(chain: string) {
  return renderToStaticMarkup(await ChainProfilePage({ params: Promise.resolve({ chain }) }));
}

/**
 * `<Link>` keeps the canonical `trailingSlash` form in a real build and strips
 * it in this bare SSR environment, so accept either before the fragment.
 */
function expectDeploymentFragment(
  html: string,
  href: string,
  contract: Parameters<typeof buildContractDeploymentAnchor>[0],
) {
  const base = href.replace(/\/+$/, "");
  const fragment = `#${encodeURIComponent(buildContractDeploymentAnchor(contract))}"`;
  const candidates = [`href="${base}${fragment}`, `href="${base}/${fragment}`];
  expect(candidates.some((candidate) => html.includes(candidate)), candidates.join(" | ")).toBe(true);
}

function expectHrefAllowTrailingSlash(html: string, href: string) {
  const base = href.replace(/\/+$/, "");
  expect(html.includes(`href="${base}"`) || html.includes(`href="${base}/"`)).toBe(true);
}

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

  it("places the bounded contract table below the live client and above the full directory", async () => {
    const html = await renderChainPage("solana");

    expect(html.indexOf("chain client solana")).toBeLessThan(html.indexOf("Recorded contract addresses on Solana"));
    expect(html.indexOf("Recorded contract addresses on Solana")).toBeLessThan(
      html.indexOf("Tracked Stablecoins On Solana"),
    );
  });

  it.each(PILOT_CHAINS)("renders a bounded four-column contract table on $chain", async ({ chain, chainName }) => {
    const html = await renderChainPage(chain);
    const candidates = orderedChainContracts(chain);
    const shown = candidates.slice(0, 20);

    expect(html).toContain(`Recorded contract addresses on ${chainName}`);
    expect(html).toContain('id="chain-contract-addresses"');
    expect(html).toContain(`Showing ${shown.length} of ${candidates.length} recorded deployments`);
    expect(shown.length).toBe(Math.min(20, candidates.length));
    expect(html.match(/scope="col"/g)).toHaveLength(4);
    expect(html.match(/scope="row"/g)).toHaveLength(shown.length);
    for (const header of ["Stablecoin", "Contract address", "Decimals", "Explorer"]) {
      expect(html).toContain(`>${header}</th>`);
    }

    for (const { deployment, contract } of shown) {
      expect(html).toContain(`>${contract.address}<`);
      expectDeploymentFragment(html, deployment.href, contract);
    }
  });

  it.each(PILOT_CHAINS)("keeps every profile directory link on $chain, including overflow", async ({ chain }) => {
    const html = await renderChainPage(chain);
    const deployments = getTrackedDeploymentsForChain(chain);
    const candidates = orderedChainContracts(chain);

    expect(deployments.length).toBeGreaterThan(0);
    for (const deployment of deployments) {
      expectHrefAllowTrailingSlash(html, deployment.href);
    }
    expect(html).toContain("Tracked Stablecoins On");
    if (candidates.length > 20) {
      const lastDeployment = deployments[deployments.length - 1];
      expectHrefAllowTrailingSlash(html, lastDeployment.href);
    }
  });

  it.each([
    { chain: "solana", coinId: "usdc-circle" },
    { chain: "base", coinId: "usdc-circle" },
    { chain: "tron", coinId: "usdt-tether" },
  ])("renders the exact $coinId address recorded on $chain", async ({ chain, coinId }) => {
    const html = await renderChainPage(chain);
    const deployment = getTrackedDeploymentsForChain(chain).find((entry) => entry.id === coinId);
    expect(deployment).toBeDefined();
    const contract = deployment!.contracts[0];

    expect(html).toContain(contract.address);
    expectDeploymentFragment(html, deployment!.href, contract);
  });

  it("keeps the nonpilot Ethereum profile unchanged", async () => {
    const html = await renderChainPage("ethereum");
    expect(html).not.toContain("chain-contract-addresses");
    expect(html).not.toContain("Recorded contract addresses on");
    expect(html).toContain("Tracked Stablecoins On Ethereum");
  });

  it("adds no table to a nonpilot chain with no recorded deployment", async () => {
    const html = await renderChainPage("bittorrent");
    expect(html).not.toContain("chain-contract-addresses");
    expect(html).not.toContain("Recorded contract addresses on");
  });

  it("keeps chain JSON-LD coin-level, never one entry per address", () => {
    const chainId = "solana";
    const deployments = getTrackedDeploymentsForChain(chainId);
    const [, itemList] = buildChainProfileJsonLd({ chainId, meta: CHAIN_META[chainId], deployments });

    expect(itemList.numberOfItems).toBe(deployments.length);
    expect(itemList.itemListElement).toHaveLength(deployments.length);
    expect(JSON.stringify(itemList)).not.toContain("contracts");
  });
});

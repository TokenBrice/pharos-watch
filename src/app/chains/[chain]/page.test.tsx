import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ChainProfilePage from "./page";
import { extractJsonLd } from "@/test/json-ld";

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

  it("emits structured data for tracked deployments", async () => {
    const html = renderToStaticMarkup(
      await ChainProfilePage({ params: Promise.resolve({ chain: "ethereum" }) }),
    );
    const jsonLd = extractJsonLd(html);
    const collection = jsonLd.find((node) => node["@type"] === "CollectionPage");
    const itemList = jsonLd.find((node) => node["@type"] === "ItemList");

    expect(collection).toMatchObject({
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      "@id": "https://pharos.watch/chains/ethereum/#collection",
      name: "Ethereum Stablecoin Analytics",
      url: "https://pharos.watch/chains/ethereum/",
      mainEntity: { "@id": "https://pharos.watch/chains/ethereum/#deployments" },
      about: expect.objectContaining({
        "@type": "Thing",
        "@id": "https://pharos.watch/chains/ethereum/#chain",
        name: "Ethereum",
      }),
    });
    expect(itemList).toMatchObject({
      "@context": "https://schema.org",
      "@type": "ItemList",
      "@id": "https://pharos.watch/chains/ethereum/#deployments",
      name: "Ethereum tracked stablecoin deployments",
    });
    expect(itemList.itemListElement).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item: expect.objectContaining({
            "@type": "Thing",
            name: "USD Coin (USDC)",
            url: "https://pharos.watch/stablecoin/usdc-circle/",
          }),
        }),
      ]),
    );
    expect(itemList.itemListElement.every((item: { item: { "@type": string } }) => item.item["@type"] === "Thing")).toBe(true);
    expect(JSON.stringify(jsonLd)).not.toContain("\"Product\"");
    expect(JSON.stringify(jsonLd)).not.toContain("/_site-data/");
  });

  it("renders the IOTA profile with its tracked stablecoin deployment anchor", async () => {
    const html = renderToStaticMarkup(
      await ChainProfilePage({ params: Promise.resolve({ chain: "iota" }) }),
    );

    expect(html).toContain("IOTA Stablecoins: VUSD, Supply &amp; Risk");
    expect(html).toContain("IOTA has 1 tracked deployment");
    expect(html).toContain("Tracked Stablecoins On IOTA");
    expect(html).toContain('href="/stablecoin/vusd-virtue"');
    expect(html).toContain("Virtue USD");
    expect(html).toContain("VUSD");
  });
});

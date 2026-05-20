import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ChainProfilePage from "./page";

function extractJsonLd(html: string) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .filter((json): json is string => Boolean(json))
    .map((json) => JSON.parse(json));
}

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

    expect(html).toContain("chain client ethereum");
    expect(html).toContain('href="/stablecoins"');
    expect(html).toContain('href="/safety-scores"');
    expect(html).toContain("Stablecoin Research Surfaces");
    expect(html.indexOf("chain client ethereum")).toBeLessThan(html.indexOf("Related Stablecoin Hubs"));
  });

  it("emits structured data for tracked deployments", async () => {
    const html = renderToStaticMarkup(
      await ChainProfilePage({ params: Promise.resolve({ chain: "ethereum" }) }),
    );
    const jsonLd = extractJsonLd(html).flat();
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
});

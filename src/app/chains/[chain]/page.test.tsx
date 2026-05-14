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

  it("emits structured data for the visible static deployment list", async () => {
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

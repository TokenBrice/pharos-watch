import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ChainsPage from "./page";
import { extractJsonLd, findJsonLdNode, getJsonLdNodeArrayProperty, isJsonLdNode } from "@/test/json-ld";

vi.mock("./client", () => ({
  ChainsLeaderboardClient: () => <div data-testid="chains-client">chains client</div>,
}));

describe("ChainsPage", () => {
  it("renders a visible chain directory and visible FAQ copy around the client leaderboard", () => {
    const html = renderToStaticMarkup(<ChainsPage />);

    expect(html).toContain("Chain Profile Directory");
    expect(html).toContain('href="/chains/ethereum"');
    expect(html).toContain('href="/chains/iota"');
    expect(html).toContain("tracked deployment");
    expect(html).not.toContain("sr-only");

    expect(html).toContain("Chains FAQ");
    expect(html).toContain("What is the Chain Health Score?");
    expect(html).toContain("Which chains have the most stablecoin supply?");

    expect(html.indexOf("chains client")).toBeLessThan(html.indexOf("Chains FAQ"));
    expect(html.indexOf("Chains FAQ")).toBeLessThan(html.indexOf("Chain Profile Directory"));
  });

  it("emits CollectionPage and ItemList structured data for crawlable chain profiles", () => {
    const html = renderToStaticMarkup(<ChainsPage />);
    const jsonLd = extractJsonLd(html);
    const collection = findJsonLdNode(jsonLd, (node) => node["@type"] === "CollectionPage", "CollectionPage");
    const itemList = findJsonLdNode(jsonLd, (node) => node["@type"] === "ItemList", "ItemList");
    const itemListElement = getJsonLdNodeArrayProperty(itemList, "itemListElement");

    expect(collection).toMatchObject({
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      "@id": "https://pharos.watch/chains/#collection",
      url: "https://pharos.watch/chains/",
      mainEntity: { "@id": "https://pharos.watch/chains/#itemlist" },
      isPartOf: { "@id": "https://pharos.watch#website" },
    });
    expect(itemList).toMatchObject({
      "@context": "https://schema.org",
      "@type": "ItemList",
      "@id": "https://pharos.watch/chains/#itemlist",
    });
    expect(itemListElement).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item: expect.objectContaining({
            "@type": "WebPage",
            "@id": "https://pharos.watch/chains/ethereum/#webpage",
            url: "https://pharos.watch/chains/ethereum/",
          }),
        }),
        expect.objectContaining({
          item: expect.objectContaining({
            "@type": "WebPage",
            "@id": "https://pharos.watch/chains/iota/#webpage",
            url: "https://pharos.watch/chains/iota/",
          }),
        }),
      ]),
    );
    expect(itemListElement.every((entry) => {
      const item = entry.item;
      return isJsonLdNode(item) && item["@type"] === "WebPage";
    })).toBe(true);
    expect(JSON.stringify(jsonLd)).not.toContain("\"Product\"");
    expect(JSON.stringify(jsonLd)).not.toContain("/_site-data/");
  });
});

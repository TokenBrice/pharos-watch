import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AboutPageContent } from "@/components/about/about-page-content";

vi.mock("next/link", async () => {
  // Vitest hoists mock factories; import the shared mock inside its factory.
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

describe("About structured-data documentation links", () => {
  it("discloses the native Hive market and its conservative CoinGecko dependency in static HTML", () => {
    const html = renderToStaticMarkup(<AboutPageContent />);
    expect(html).toContain("Hive internal market (HBD/HIVE)");
    expect(html).toContain("CoinGecko HIVE/USD conversion dependency");
    expect(html).toContain("not two independent votes");
    expect(html).toContain('href="https://developers.hive.io/apidefinitions/#condenser_api.get_order_book"');
  });
  it("points API and catalog mentions directly at Reference without changing entity identities", () => {
    const html = renderToStaticMarkup(<AboutPageContent />);
    const nodes = Array.from(html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs),
      (match) => JSON.parse(match[1]) as { "@type": string; mentions?: unknown[] });
    const about = nodes.find((node) => node["@type"] === "AboutPage");
    expect(about).toBeDefined();
    expect(about?.mentions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        "@type": "WebAPI",
        "@id": "https://pharos.watch/api/#webapi",
        url: "https://pharos.watch/api/reference/",
      }),
      expect.objectContaining({
        "@type": "DataCatalog",
        "@id": "https://pharos.watch/api/#data-catalog",
        url: "https://pharos.watch/api/reference/",
      }),
    ]));
  });
});

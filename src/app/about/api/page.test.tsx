import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import AboutApiPage from "./page";
import { extractJsonLd } from "@/test/json-ld";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

describe("AboutApiPage", () => {
  it("emits API artifact catalog structured data with crawlable public URLs", async () => {
    const html = renderToStaticMarkup(await AboutApiPage());
    const jsonLd = extractJsonLd(html);
    const catalog = jsonLd.find((node) => node["@type"] === "DataCatalog");
    const webApi = jsonLd.find((node) => node["@type"] === "WebAPI");
    const openApi = jsonLd.find((node) => node["@id"] === "https://pharos.watch/about/api/#openapi-spec");

    expect(catalog).toMatchObject({
      "@type": "DataCatalog",
      "@id": "https://pharos.watch/about/api/#data-catalog",
      dataset: expect.arrayContaining([
        { "@id": "https://pharos.watch/about/api/#openapi-spec" },
        { "@id": "https://pharos.watch/cemetery/#dataset" },
      ]),
    });
    expect(webApi).toMatchObject({
      "@type": "WebAPI",
      endpointUrl: "https://api.pharos.watch",
      documentation: "https://pharos.watch/about/api/",
    });
    expect(openApi).toMatchObject({
      "@type": "CreativeWork",
      additionalType: "https://schema.org/APIReference",
      url: "https://pharos.watch/openapi.json",
    });
    expect(JSON.stringify([catalog, webApi, openApi])).not.toContain("/_site-data/");
    expect(html).toContain('data-table-id="about-api-');
    expect(html).toContain('data-slot="table-viewport"');
    expect(html).toContain('data-slot="table"');
  });
});

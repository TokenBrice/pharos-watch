import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ApiPage from "./page";
import { ApiReferencePanel } from "./api-reference-panel";
import { extractJsonLd } from "@/test/json-ld";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

describe("ApiPage", () => {
  it("emits API artifact catalog structured data with crawlable public URLs", async () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>{await ApiPage()}</QueryClientProvider>,
    );
    const jsonLd = extractJsonLd(html);
    const catalog = jsonLd.find((node) => node["@type"] === "DataCatalog");
    const webApi = jsonLd.find((node) => node["@type"] === "WebAPI");
    const openApi = jsonLd.find((node) => node["@id"] === "https://pharos.watch/api/#openapi-spec");

    expect(catalog).toMatchObject({
      "@type": "DataCatalog",
      "@id": "https://pharos.watch/api/#data-catalog",
      dataset: expect.arrayContaining([
        { "@id": "https://pharos.watch/api/#openapi-spec" },
        { "@id": "https://pharos.watch/cemetery/#dataset" },
      ]),
    });
    expect(webApi).toMatchObject({
      "@type": "WebAPI",
      endpointUrl: "https://api.pharos.watch",
      documentation: "https://pharos.watch/api/",
    });
    expect(openApi).toMatchObject({
      "@type": "CreativeWork",
      additionalType: "https://schema.org/APIReference",
      url: "https://pharos.watch/openapi.json",
    });
    expect(JSON.stringify([catalog, webApi, openApi])).not.toContain("/_site-data/");
    // Both tabs ship in the static HTML; #reference deep-links the Reference tab.
    expect(html).toContain('id="access"');
    expect(html).toContain('id="reference"');
    const ids = [...html.matchAll(/(?<![\w-])id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    expect(html).toContain('data-table-id="api-reference-');
    expect(html).toContain('data-slot="table-viewport"');
    expect(html).toContain('data-slot="table"');
    expect(html).toMatch(/<code class="[^"]*\[overflow-wrap:anywhere\][^"]*">ph_live_0123456789abcdef_abcdefghijklmnopqrstuvwxyzABCDEF<\/code>/);
    const mirroredDatasets = jsonLd.filter((node) =>
      typeof node["@id"] === "string" && node["@id"].includes("/datasets/") && node["@type"] === "Dataset",
    );
    expect(mirroredDatasets).toHaveLength(4);
    const visibleHtml = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
    for (const dataset of mirroredDatasets) {
      const landingUrl = new URL(dataset.url as string);
      expect(landingUrl.pathname).toBe("/api/");
      expect(visibleHtml).toContain(`id="${landingUrl.hash.slice(1)}"`);
      expect(visibleHtml).toContain(dataset.name);
      for (const distribution of dataset.distribution as Array<{ contentUrl: string }>) {
        expect(visibleHtml).toContain(`href="${new URL(distribution.contentUrl).pathname}"`);
      }
    }
  });

  it("renders the full public reference from docs/api-reference.md without admin sections", async () => {
    const html = renderToStaticMarkup(await ApiReferencePanel());

    expect(html).toContain("Public Endpoints");
    expect(html).toContain('id="get-api-stablecoins"');
    expect(html).toContain('href="#get-api-stablecoins"');
    expect(html).not.toContain("Admin Auth And Idempotency");
    expect(html).not.toContain("Admin Endpoints");
  });
});

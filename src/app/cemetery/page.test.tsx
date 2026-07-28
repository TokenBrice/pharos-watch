import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import CemeteryPage from "./page";
import { extractJsonLd } from "@/test/json-ld";

vi.mock("@/components/cemetery-client", () => ({
  CemeteryClient: () => <section>cemetery tombstones</section>,
}));

vi.mock("@/components/cemetery-charts", () => ({
  CemeteryCharts: () => <section>cemetery charts</section>,
}));

describe("CemeteryPage", () => {
  it("places the tombstone field before the cemetery charts", () => {
    const html = renderToStaticMarkup(<CemeteryPage />);

    expect(html).toContain("Stablecoin Cemetery");
    expect(html.indexOf("cemetery tombstones")).toBeLessThan(html.indexOf("cemetery charts"));
  });

  it("emits cemetery Dataset downloads without site-data URLs", () => {
    const html = renderToStaticMarkup(<CemeteryPage />);
    const jsonLd = extractJsonLd(html);
    const dataset = jsonLd.find((node) => node["@type"] === "Dataset");

    expect(dataset).toMatchObject({
      "@context": "https://schema.org",
      "@type": "Dataset",
      "@id": "https://pharos.watch/cemetery/#dataset",
      name: "Pharos Stablecoin Cemetery Dataset",
      url: "https://pharos.watch/cemetery/",
      isAccessibleForFree: true,
      distribution: [
        {
          "@type": "DataDownload",
          encodingFormat: "application/json",
          contentUrl: "https://pharos.watch/datasets/stablecoin-cemetery.json",
        },
        {
          "@type": "DataDownload",
          encodingFormat: "text/csv",
          contentUrl: "https://pharos.watch/datasets/stablecoin-cemetery.csv",
        },
      ],
    });
    expect(dataset.variableMeasured).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "id" }),
        expect.objectContaining({ name: "causeOfDeath" }),
        expect.objectContaining({ name: "pharosUrl" }),
      ]),
    );
    expect(JSON.stringify(jsonLd)).not.toContain("/_site-data/");
  });
});

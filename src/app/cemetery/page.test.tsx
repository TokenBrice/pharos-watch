import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { sortCemeteryCoins } from "@shared/lib/cemetery";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import { CEMETERY_SECTION_ANCHORS } from "@/lib/cemetery-selection";
import { extractJsonLd, findJsonLdNode, getJsonLdNodeArrayProperty } from "@/test/json-ld";
import CemeteryPage, { metadata } from "./page";

vi.mock("next/link", async () => {
  // Vitest hoists this factory, so the mock helper must load within that boundary.
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

// The hero island, the register and the charts have their own suites; here they only mark their place.
vi.mock("@/components/cemetery/cemetery-hero", () => ({
  CemeteryHero: () => <section id="cemetery">cemetery hero</section>,
}));
vi.mock("@/components/cemetery/cemetery-register", () => ({
  CemeteryRegister: () => <section id="register">autopsy register</section>,
}));
vi.mock("@/components/cemetery/cemetery-analysis", () => ({
  CemeteryAnalysis: () => <section id="analysis">cemetery charts</section>,
}));

const html = renderToStaticMarkup(<CemeteryPage />);
const jsonLd = extractJsonLd(html);

/** Text as React writes it into markup. */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

describe("CemeteryPage", () => {
  it("renders the hero, then the analytics sections, and closes on the FAQ", () => {
    const sectionAnchors: readonly string[] = CEMETERY_SECTION_ANCHORS;
    const order = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]).filter((id) => sectionAnchors.includes(id));

    expect(order).toEqual(["cemetery", "key-facts", "causes", "register", "analysis", "methodology", "dataset", "faq"]);
  });

  it("links every ItemList record to its register anchor, newest death first", () => {
    const itemList = findJsonLdNode(jsonLd, (node) => node["@type"] === "ItemList", "ItemList");
    const urls = getJsonLdNodeArrayProperty(itemList, "itemListElement").map(
      (listItem) => (listItem.item as { url?: unknown } | undefined)?.url,
    );

    expect(itemList.numberOfItems).toBe(CEMETERY_ENTRIES.length);
    expect(urls).toEqual(
      sortCemeteryCoins(CEMETERY_ENTRIES, "newest").map((entry) => `https://pharos.watch/cemetery/#${entry.id}`),
    );
  });

  it("emits cemetery Dataset downloads without site-data URLs", () => {
    const dataset = findJsonLdNode(jsonLd, (node) => node["@type"] === "Dataset", "Dataset");

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

  it("emits FAQPage JSON-LD for exactly the questions shown under #faq", () => {
    const faq = findJsonLdNode(jsonLd, (node) => node["@type"] === "FAQPage", "FAQPage");
    const structured = getJsonLdNodeArrayProperty(faq, "mainEntity").map((question) => escapeHtml(String(question.name)));
    const faqMarkup = html.slice(html.indexOf(' id="faq"'));
    const shown = [...faqMarkup.matchAll(/<summary[^>]*>([^<]+)</g)].map((match) => match[1]);

    expect(shown).toEqual(structured);
  });

  it("shares the plot-map social card", () => {
    expect(metadata.openGraph?.images).toEqual([
      { url: "https://pharos.watch/og-cemetery.png", width: 1200, height: 630 },
    ]);
  });
});

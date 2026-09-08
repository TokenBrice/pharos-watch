// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import AboutPage from "./page";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import { extractJsonLd } from "@/test/json-ld";

vi.mock("next/font/local", () => ({
  default: () => ({ className: "mock-local-font", variable: "--mock-local-font" }),
}));

vi.mock("next/image", () => ({
  default: ({ alt, ...props }: { alt: string; src: string; width: number; height: number; className?: string }) => (
    <img alt={alt} {...props} />
  ),
}));

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

vi.mock("@/lib/page-metadata", () => ({
  buildPageMetadata: (input: unknown) => input,
}));

const html = renderToStaticMarkup(<AboutPage />);
const jsonLd = extractJsonLd(html);
const visibleDocument = document.implementation.createHTMLDocument();
visibleDocument.documentElement.innerHTML = html;
visibleDocument.querySelectorAll("script").forEach((script) => script.remove());

describe("AboutPage", () => {
  it("emits AboutPage JSON-LD tying Pharos to trust and data surfaces", () => {
    const aboutJsonLd = jsonLd.find((block) => {
      return Boolean(block && typeof block === "object" && (block as { "@type"?: string })["@type"] === "AboutPage");
    }) as { mentions: Array<{ "@id": string }> } | undefined;

    expect(aboutJsonLd).toMatchObject({
      "@type": "AboutPage",
      "@id": "https://pharos.watch/about/#about-page",
      about: { "@id": "https://pharos.watch#organization" },
      mainEntity: { "@id": "https://pharos.watch#organization" },
      publisher: { "@id": "https://pharos.watch#organization" },
    });
    expect(aboutJsonLd?.mentions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ "@id": "https://pharos.watch/about/api/#webapi" }),
        expect.objectContaining({ "@id": "https://pharos.watch/about/api/#data-catalog" }),
        expect.objectContaining({ "@id": "https://pharos.watch/docs/data-flow-map/#tech-article" }),
        expect.objectContaining({ "@id": "https://pharos.watch/about/#principles" }),
        expect.objectContaining({ "@id": "https://pharos.watch/funding/#funding" }),
      ]),
    );
  });

  it("renders visible FAQ content matching the emitted FAQPage JSON-LD", () => {
    const visibleText = visibleDocument.body.textContent ?? "";
    const faqJsonLdBlocks = jsonLd.filter((block) => {
      return Boolean(block && typeof block === "object" && (block as { "@type"?: string })["@type"] === "FAQPage");
    }) as Array<{ mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }> }>;
    const [faqJsonLd] = faqJsonLdBlocks;

    expect(faqJsonLdBlocks).toHaveLength(1);
    expect(faqJsonLd).toBeDefined();
    expect(visibleText).toContain("About Pharos FAQ");
    expect(visibleText).toContain(`${CEMETERY_ENTRIES.length} dead ones`);

    const faqSection = [...visibleDocument.querySelectorAll("section")].find(
      (section) => section.querySelector("h2")?.textContent === "About Pharos FAQ",
    );
    expect(faqSection).toBeDefined();
    const visibleItems = [...faqSection!.querySelectorAll("details")].map((item) => ({
      "@type": "Question",
      name: item.querySelector("summary")!.textContent,
      acceptedAnswer: { "@type": "Answer", text: item.querySelector("p")!.textContent },
    }));
    expect(visibleItems.length).toBeGreaterThan(0);
    expect(faqJsonLd.mainEntity).toEqual(visibleItems);
  });
});

// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import AboutPage from "./page";

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

function parseStaticDocument(html: string) {
  const parsed = document.implementation.createHTMLDocument();
  parsed.documentElement.innerHTML = html;
  return parsed;
}

function extractJsonLd(document: Document) {
  return [...document.querySelectorAll('script[type="application/ld+json"]')].map((script) =>
    JSON.parse(script.textContent ?? "null"),
  );
}

describe("AboutPage", () => {
  it("emits AboutPage JSON-LD tying Pharos to trust and data surfaces", () => {
    const html = renderToStaticMarkup(<AboutPage />);
    const aboutJsonLd = extractJsonLd(parseStaticDocument(html)).find((block) => {
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
        expect.objectContaining({ "@id": "https://pharos.watch/docs/data-pipeline/#tech-article" }),
        expect.objectContaining({ "@id": "https://pharos.watch/about/#principles" }),
        expect.objectContaining({ "@id": "https://pharos.watch/funding/#funding" }),
      ]),
    );
  });

  it("renders visible FAQ content matching the emitted FAQPage JSON-LD", () => {
    const html = renderToStaticMarkup(<AboutPage />);
    const document = parseStaticDocument(html);
    document.querySelectorAll("script").forEach((script) => script.remove());
    const visibleText = document.body.textContent ?? "";
    const faqJsonLdBlocks = extractJsonLd(parseStaticDocument(html)).filter((block) => {
      return Boolean(block && typeof block === "object" && (block as { "@type"?: string })["@type"] === "FAQPage");
    }) as Array<{ mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }> }>;
    const [faqJsonLd] = faqJsonLdBlocks;

    expect(faqJsonLdBlocks).toHaveLength(1);
    expect(faqJsonLd).toBeDefined();
    expect(visibleText).toContain("About Pharos FAQ");

    for (const item of faqJsonLd?.mainEntity ?? []) {
      expect(visibleText).toContain(item.name);
      expect(visibleText).toContain(item.acceptedAnswer.text);
    }
  });
});

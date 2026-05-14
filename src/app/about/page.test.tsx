import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import AboutPage from "./page";

vi.mock("next/image", () => ({
  default: ({ alt, ...props }: { alt: string; src: string; width: number; height: number; className?: string }) => (
    <img alt={alt} {...props} />
  ),
}));

vi.mock("next/link", () => ({
  default: ({ children, href, className }: { children: ReactNode; href: string; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

function decodeHtml(value: string) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractJsonLd(html: string) {
  const blocks: unknown[] = [];
  const pattern = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(html)) !== null) {
    blocks.push(JSON.parse(decodeHtml(match[1])));
  }
  return blocks;
}

describe("AboutPage", () => {
  it("renders visible FAQ content matching the emitted FAQPage JSON-LD", () => {
    const html = renderToStaticMarkup(<AboutPage />);
    const visibleHtml = decodeHtml(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " "));
    const faqJsonLd = extractJsonLd(html).find((block) => {
      return Boolean(block && typeof block === "object" && (block as { "@type"?: string })["@type"] === "FAQPage");
    }) as { mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }> } | undefined;

    expect(faqJsonLd).toBeDefined();
    expect(visibleHtml).toContain("About Pharos FAQ");

    for (const item of faqJsonLd?.mainEntity ?? []) {
      expect(visibleHtml).toContain(item.name);
      expect(visibleHtml).toContain(item.acceptedAnswer.text);
    }
  });
});

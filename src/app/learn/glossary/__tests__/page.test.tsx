import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import GlossaryPage from "../page";
import { GLOSSARY_ENTRIES } from "../content";
import { extractJsonLd } from "@/test/json-ld";

vi.mock("next/font/local", () => ({
  default: () => ({ className: "mock-local-font", variable: "--mock-local-font" }),
}));

vi.mock("next/link", () => ({
  default: ({ children, href, className }: { children: ReactNode; href: string; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/page-metadata", () => ({
  buildPageMetadata: (input: unknown) => input,
}));

describe("GlossaryPage", () => {
  it("emits DefinedTermSet JSON-LD for every glossary entry", () => {
    const html = renderToStaticMarkup(<GlossaryPage />);
    const jsonLd = extractJsonLd(html);
    const termSet = jsonLd.find((node) => node["@type"] === "DefinedTermSet") as
      | {
          hasDefinedTerm: Array<{
            "@id": string;
            name: string;
            termCode: string;
            subjectOf: { url: string };
          }>;
        }
      | undefined;

    expect(termSet).toMatchObject({
      "@type": "DefinedTermSet",
      "@id": "https://pharos.watch/learn/glossary/#defined-term-set",
      publisher: { "@id": "https://pharos.watch#organization" },
    });
    expect(termSet?.hasDefinedTerm).toHaveLength(GLOSSARY_ENTRIES.length);
    expect(termSet?.hasDefinedTerm).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          "@id": "https://pharos.watch/learn/glossary/#psi",
          name: "PSI",
          termCode: "psi",
          subjectOf: expect.objectContaining({
            "@type": "WebPage",
            url: "https://pharos.watch/methodology/#stability-index-methodology",
          }),
        }),
      ]),
    );
  });
});

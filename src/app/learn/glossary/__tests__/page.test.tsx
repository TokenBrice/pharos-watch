import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import GlossaryPage from "../page";
import { GLOSSARY_ENTRIES } from "@/lib/glossary-content";
import { extractJsonLd } from "@/test/json-ld";
import { DEWS_SIGNAL_LABELS } from "@shared/lib/dews-config";

vi.mock("next/font/local", () => ({
  default: () => ({ className: "mock-local-font", variable: "--mock-local-font" }),
}));

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

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

  it("publishes the canonical DEWS signal roster in visible and DefinedTerm definitions", () => {
    const html = renderToStaticMarkup(<GlossaryPage />);
    const termSet = extractJsonLd(html).find((node) => node["@type"] === "DefinedTermSet") as {
      hasDefinedTerm: Array<{ termCode: string; description: string }>;
    };
    const definition = termSet.hasDefinedTerm.find((term) => term.termCode === "dews")!.description;
    const signalList = definition.match(/sub-signals: ([^.]+)\./)?.[1]?.split(", ");
    expect(signalList).toEqual(Object.values(DEWS_SIGNAL_LABELS));
    expect(definition).toMatch(/Price Confidence.*confidence loss, not distance from peg/);
    expect(definition).toMatch(/Cross-Source Divergence.*source prices.*peg reference/);

    const visibleDefinition = html.match(/<article id="dews"[\s\S]*?<\/article>/)?.[0];
    expect(visibleDefinition).toContain(definition);
  });
});

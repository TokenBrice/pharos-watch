import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ARCHETYPE_CONTENT } from "@/app/learn/mechanisms/content";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

import { ArchetypeExplainerBody } from "@/app/learn/mechanisms/explainer-shell";

describe("ArchetypeExplainerBody", () => {
  it("orders sections: How → Tracked examples → Risk → Variations → What to watch → Tracked universe → Continue", () => {
    const html = renderToStaticMarkup(
      <ArchetypeExplainerBody content={ARCHETYPE_CONTENT.cdp} />,
    );

    const idxHow = html.indexOf("How it works");
    const idxExamples = html.indexOf("Tracked examples");
    const idxRisk = html.indexOf("Where the design fails");
    const idxVariations = html.indexOf("Variations");
    const idxWatch = html.indexOf("What to watch on Pharos");
    const idxUniverse = html.indexOf("Tracked universe");
    const idxContinue = html.indexOf("Continue reading");

    expect(idxHow).toBeGreaterThan(-1);
    expect(idxExamples).toBeGreaterThan(idxHow);
    expect(idxRisk).toBeGreaterThan(idxExamples);
    expect(idxVariations).toBeGreaterThan(idxRisk);
    expect(idxWatch).toBeGreaterThan(idxVariations);
    expect(idxUniverse).toBeGreaterThan(idxWatch);
    expect(idxContinue).toBeGreaterThan(idxUniverse);
  });

  it("renders a Decommissioned block for archetypes that curate one", () => {
    const algoHtml = renderToStaticMarkup(
      <ArchetypeExplainerBody content={ARCHETYPE_CONTENT.algorithmic} />,
    );
    expect(algoHtml).toContain("Decommissioned");
    expect(algoHtml).toContain("TerraUSD");
    expect(algoHtml).toContain("/cemetery/");

    const cdpHtml = renderToStaticMarkup(
      <ArchetypeExplainerBody content={ARCHETYPE_CONTENT.cdp} />,
    );
    expect(cdpHtml).toContain("Decommissioned");
    expect(cdpHtml).toContain("Kava USDX");

    // rwa-credit-fund has no curated decommissioned list — the section is omitted.
    const rwaHtml = renderToStaticMarkup(
      <ArchetypeExplainerBody content={ARCHETYPE_CONTENT["rwa-credit-fund"]} />,
    );
    expect(rwaHtml).not.toContain(">Decommissioned<");
  });

  it("renders the screener round-trip link in the tracked-coin list", () => {
    const html = renderToStaticMarkup(
      <ArchetypeExplainerBody content={ARCHETYPE_CONTENT["fiat-cash"]} />,
    );
    expect(html).toContain('href="/screener/?mechanisms=fiat-cash"');
  });
});

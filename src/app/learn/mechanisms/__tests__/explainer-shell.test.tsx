import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types";

import { ARCHETYPE_CONTENT } from "@/app/learn/mechanisms/content";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

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

  it("pluralizes the tracked-universe heading from total coins, not parent rows", async () => {
    vi.resetModules();

    const parent = {
      id: "parent-usd",
      name: "Parent USD",
      symbol: "pUSD",
    } as StablecoinMeta;
    const child = {
      id: "child-usd",
      name: "Child USD",
      symbol: "cUSD",
      variantOf: parent.id,
    } as StablecoinMeta;

    vi.doMock("@shared/lib/stablecoins/by-mechanism", () => ({
      getActiveByArchetype: () => [parent, child],
      getCoinsByLifecycleStatus: () => [],
      nestVariants: (_coins: StablecoinMeta[]) => ({
        parents: [parent],
        childrenByParentId: { [parent.id]: [child] },
      }),
    }));

    try {
      const { ArchetypeExplainerBody: MockedArchetypeExplainerBody } =
        await import("@/app/learn/mechanisms/explainer-shell");
      const html = renderToStaticMarkup(
        <MockedArchetypeExplainerBody content={ARCHETYPE_CONTENT.cdp} />,
      );

      expect(html).toContain("2 tracked stablecoins in this archetype");
      expect(html).not.toContain("1 tracked stablecoin in this archetype");
    } finally {
      vi.doUnmock("@shared/lib/stablecoins/by-mechanism");
      vi.resetModules();
    }
  });
});

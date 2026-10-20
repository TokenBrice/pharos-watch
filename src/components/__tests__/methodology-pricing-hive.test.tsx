// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { PricingPipelineMethodologySection } from "@/app/methodology/sections/core-sections-pricing";
import { PRICING_PIPELINE_SECTION_CONTENT } from "@/lib/methodology-content";
import { PRICING_PIPELINE_METHODOLOGY_CHANGELOG } from "@shared/lib/methodology-versions/registry";

afterEach(cleanup);

describe("native Hive public methodology", () => {
  it("renders dependency-capped trust and keeps the markdown summary aligned", () => {
    const html = renderToStaticMarkup(<PricingPipelineMethodologySection />);
    expect(html).toContain("Native Hive activation and acceptance");
    expect(html).toContain("Hive internal market (HBD/HIVE)");
    expect(html).toMatch(/href="\/methodology\/pricing-pipeline-changelog\/archive\/v6\/?#changelog-v-6-53"/);
    expect(html).toContain("not two");
    expect(html).toContain("requires depeg confirmation");
    const summary = PRICING_PIPELINE_SECTION_CONTENT.markdownParagraphs.join(" ");
    expect(summary).toContain("one CoinGecko-dependent soft observation");
    expect(summary).toContain("not two independent votes");
    expect(PRICING_PIPELINE_METHODOLOGY_CHANGELOG.find(({ version }) => version === "6.53")?.effectiveAt).toBe(1792368000);
    expect(summary).toContain("no supply changes or historical backfill");
  });

  it("retains durable source, supply and clock caveats in the shared technical content", () => {
    const root = document.createElement("div");
    root.innerHTML = renderToStaticMarkup(<PricingPipelineMethodologySection />);
    const text = root.textContent;
    const markdown = PRICING_PIPELINE_SECTION_CONTENT.markdown;
    for (const rule of [
      "500 HBD per side within 2%", "parent must be within five minutes", "earlier leg",
      "near-par direct CG quote", "SOFID uses exact-identity", "Kraken remains local-fetch",
      "Class assets are never circulating supply", "Quarantine persists",
      "at most seven days", "Disappearing chain rows cannot release quarantine",
      "observed zero stays zero", "14-day as-of budget", "original age",
      "observed flow × ticker confidence 0.55",
    ]) {
      expect(text).toContain(rule);
      expect(markdown).toContain(rule);
    }
    const details = [...root.querySelectorAll("details")].find((node) => node.textContent?.includes("Current source admission and exceptions"));
    expect(details?.textContent).toContain("Hive internal market (HBD/HIVE)");
    expect(details?.textContent).toContain("SOFID uses exact-identity");
  });
});

describe("pricing source availability", () => {
  it.each([
    { availability: undefined, expected: ["CoinGecko Onchain (address)"] },
    { availability: [{ key: "coingecko-onchain-address" as const, enabled: false }], expected: [] },
    { availability: [
      { key: "coingecko-onchain-address" as const, enabled: true },
      { key: "dexscreener-address" as const, enabled: false },
    ], expected: ["CoinGecko Onchain (address)"] },
  ])("renders only enabled exact-address sources: $expected", ({ availability, expected }) => {
    render(<PricingPipelineMethodologySection addressProviderAvailability={availability} />);
    const rows = within(screen.getByTestId("methodology-pricing-source-weights-table")).getAllByRole("row", { hidden: true });
    const addressCells = rows.map((row) => within(row).queryAllByRole("cell", { hidden: true }))
      .filter((cells) => cells[2]?.textContent === "Exact-address augmentation");
    expect(addressCells.map((cells) => cells[0].textContent)).toEqual(expected);
    for (const cells of addressCells) expect(cells[1].textContent).toBe("1");
  });
});

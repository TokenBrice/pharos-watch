// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { PricingPipelineMethodologySection } from "@/app/methodology/sections/core-sections-pricing";
import { PRICING_PIPELINE_SECTION_CONTENT } from "@/lib/methodology-content";

afterEach(cleanup);

describe("native Hive public methodology", () => {
  it("renders dependency-capped trust and keeps the markdown summary aligned", () => {
    const html = renderToStaticMarkup(<PricingPipelineMethodologySection />);
    expect(html).toContain("Native HBD market evidence (v6.53)");
    expect(html).toContain("Hive internal market (HBD/HIVE)");
    expect(html).toContain("Effective October 19, 2026.");
    expect(html).toContain("not two");
    expect(html).toContain("requires depeg confirmation");
    const summary = PRICING_PIPELINE_SECTION_CONTENT.markdownParagraphs.join(" ");
    expect(summary).toContain("one CoinGecko-dependent soft observation");
    expect(summary).toContain("not two independent votes");
    expect(summary).toContain("2026-10-19 00:00 UTC; 1792368000");
    expect(summary).toContain("no supply changes or historical backfill");
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

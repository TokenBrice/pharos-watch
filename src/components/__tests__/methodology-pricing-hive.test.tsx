import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PricingPipelineMethodologySection } from "@/app/methodology/sections/core-sections-pricing";
import { PRICING_PIPELINE_SECTION_CONTENT } from "@/lib/methodology-content";

describe("native Hive public methodology", () => {
  it("renders dependency-capped trust and keeps the markdown summary aligned", () => {
    const html = renderToStaticMarkup(<PricingPipelineMethodologySection />);
    expect(html).toContain("Native HBD market evidence (v6.53)");
    expect(html).toContain("Hive internal market (HBD/HIVE)");
    expect(html).toContain("not two");
    expect(html).toContain("requires depeg confirmation");
    const summary = PRICING_PIPELINE_SECTION_CONTENT.markdownParagraphs.join(" ");
    expect(summary).toContain("one CoinGecko-dependent soft observation");
    expect(summary).toContain("not two independent votes");
    expect(summary).toContain("no supply changes or historical backfill");
  });
});

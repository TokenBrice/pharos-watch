import { describe, expect, it } from "vitest";
import { API_ORIGIN } from "@shared/lib/runtime-origins";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import {
  buildApiOgImageUrl,
  buildStablecoinDetailDescription,
  summarizeText,
} from "@/lib/page-metadata";

describe("page metadata helpers", () => {
  it("builds phrase-safe stablecoin descriptions", () => {
    const usdt = TRACKED_META_BY_ID.get("usdt-tether");
    const usde = TRACKED_META_BY_ID.get("usde-ethena");

    expect(usdt).toBeDefined();
    expect(usde).toBeDefined();

    expect(buildStablecoinDetailDescription(usdt!)).toContain("backed by real-world assets");
    expect(buildStablecoinDetailDescription(usde!)).toContain("collateralized by crypto assets");
  });

  it("prefers a full first sentence for digest descriptions", () => {
    const text = "First sentence stays intact. Second sentence would push it over the limit.";

    expect(summarizeText(text, 60)).toBe("First sentence stays intact.");
  });

  it("falls back to word-boundary trimming when no short sentence exists", () => {
    const text =
      "This is a deliberately long paragraph without an early sentence break so the helper needs to trim on a word boundary instead of cutting the text midword";

    const summary = summarizeText(text, 80);

    expect(summary.length).toBeLessThanOrEqual(80);
    expect(summary.endsWith("…")).toBe(true);
    expect(summary).not.toContain("midwor");
  });

  it("builds OG URLs from the shared API origin", () => {
    expect(buildApiOgImageUrl("/api/og/depeg")).toBe(`${API_ORIGIN}/api/og/depeg`);
  });
});

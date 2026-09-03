import { describe, expect, it } from "vitest";
import { API_ORIGIN } from "@shared/lib/runtime-origins";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  buildApiOgImageUrl,
  buildStablecoinDetailDescription,
  buildStablecoinDetailMetadata,
  summarizeText,
} from "@/lib/page-metadata";

describe("page metadata helpers", () => {
  it("builds phrase-safe stablecoin descriptions", () => {
    const usdt = TRACKED_META_BY_ID.get("usdt-tether");
    const usde = TRACKED_META_BY_ID.get("usde-ethena");
    const nect = TRACKED_META_BY_ID.get("nect-beraborrow");

    expect(usdt).toBeDefined();
    expect(usde).toBeDefined();
    expect(nect).toBeDefined();

    expect(buildStablecoinDetailDescription(usdt!)).toContain("backed by real-world assets");
    expect(buildStablecoinDetailDescription(usde!)).toContain("collateralized by crypto assets");
    // nect-beraborrow was firmed to reviewedStatus true by the C10 access
    // review (live EMERGENCY_ROLE pause evidence). The description now carrn path is
    // reachable by any address the owner adds to the PSM-bond whitelist.
    expect(buildStablecoinDetailDescription(nect!)).toContain("Issuer can freeze addresses");
  });

  it("describes NAV tokens as NAV claims rather than fixed-dollar pegs", () => {
    const dusd = TRACKED_META_BY_ID.get("dusd-dialectic");

    expect(dusd).toBeDefined();
    const description = buildStablecoinDetailDescription(dusd!);
    expect(description).toContain("yield-bearing token with USDC-denominated NAV");
    expect(description).not.toContain("pegged to US Dollar");
  });

  it("uses pre-launch tracker wording before live stablecoin data exists", () => {
    const preLaunch = TRACKED_META_BY_ID.get("krw-imbank");

    expect(preLaunch).toBeDefined();

    const description = buildStablecoinDetailDescription(preLaunch!);
    const metadata = buildStablecoinDetailMetadata(preLaunch!);

    expect(metadata.title).toBe("KRW-iM (iM Bank KRW Stablecoin) Stablecoin Launch Tracker");
    expect(description).toContain("Pre-launch profile");
    expect(description).toContain("before live data begins");
    expect(description).not.toContain("Peg score");
    expect(description).not.toContain("liquidity");
    expect(metadata.description).toBe(description);
    expect(metadata.openGraph?.images).toEqual([
      {
        url: "/og-upcoming.png",
        width: 1200,
        height: 628,
      },
    ]);
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

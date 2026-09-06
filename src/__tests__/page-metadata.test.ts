import { describe, expect, it } from "vitest";
import { API_ORIGIN } from "@shared/lib/runtime-origins";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { INDEXABLE_ROBOTS } from "@/lib/seo-robots";
import {
  buildApiOgImageUrl,
  buildStablecoinDetailDescription,
  buildStablecoinDetailMetadata,
  summarizeText,
} from "@/lib/page-metadata";

describe("page metadata helpers", () => {
  it("builds phrase-safe stablecoin descriptions", () => {
    const usdt = TRACKED_META_BY_ID.get("usdt-tether");
    const nect = TRACKED_META_BY_ID.get("nect-beraborrow");

    expect(usdt).toBeDefined();
    expect(nect).toBeDefined();

    expect(buildStablecoinDetailDescription(usdt!)).toContain("backed by real-world assets");
    // nect-beraborrow was firmed to reviewedStatus true by the C10 access
    // review (live EMERGENCY_ROLE pause evidence). The description now carrn path is
    // reachable by any address the owner adds to the PSM-bond whitelist.
    expect(buildStablecoinDetailDescription(nect!)).toContain("Issuer can freeze addresses");
  });

  it.each([
    ["paxg-paxos", "PAX Gold (PAXG): Gold Backing, Custody & Risk", "Compare PAXG with XAUT"],
    ["usdg-paxos", "USDG (Global Dollar): Reserves, Redemption & Risk", "redemption access, freeze controls"],
    ["usde-ethena", "Ethena USDe: Backing, Peg Stability & Risk", "Compare its risk profile with sUSDe"],
    ["bold-liquity", "Liquity BOLD: Collateral, Redemption & Risk", "Compare its Safety Score and risk profile with LUSD"],
    ["fpi-frax", "Frax Price Index (FPI): CPI Peg, Backing & Risk", "CPI-linked target, backing and redemption mechanics"],
    ["sgho-aave", "Aave Savings GHO (sGHO): Yield, Withdrawals & Risk", "GHO-denominated yield and withdrawal mechanics"],
  ])("uses the bounded metadata pilot for %s without changing crawl policy", (id, title, descriptionPhrase) => {
    const coin = TRACKED_META_BY_ID.get(id)!;
    expect(coin).toBeDefined();
    const metadata = buildStablecoinDetailMetadata(coin);

    expect(metadata.title).toBe(title);
    expect(metadata.description).toContain(descriptionPhrase);
    expect(metadata.description!.length).toBeLessThanOrEqual(160);
    expect(metadata.description).toBe(buildStablecoinDetailDescription(coin));
    expect(metadata.alternates?.canonical).toBe(`/stablecoin/${id}/`);
    expect(metadata.robots).toEqual(INDEXABLE_ROBOTS);
    expect(metadata.openGraph).toMatchObject({ title, description: metadata.description, url: `/stablecoin/${id}/` });
    expect(metadata.twitter).toMatchObject({ title, description: metadata.description });
  });

  it("keeps USDC outside the metadata pilot", () => {
    const coin = TRACKED_META_BY_ID.get("usdc-circle")!;
    const metadata = buildStablecoinDetailMetadata(coin);
    expect(metadata.title).toBe("USDC (USD Coin) Stablecoin Safety Score & Risk Profile");
    expect(metadata.description).toContain("USDC risk profile for USD Coin:");
    expect(metadata.alternates?.canonical).toBe("/stablecoin/usdc-circle/");
    expect(metadata.robots).toEqual(INDEXABLE_ROBOTS);
  });

  it.each(["pre-launch", "quarantined", "delisted", "frozen"] as const)(
    "preserves %s metadata if a pilot coin leaves active monitoring",
    (status) => {
      const coin = { ...TRACKED_META_BY_ID.get("paxg-paxos")!, status };
      const metadata = buildStablecoinDetailMetadata(coin);
      const statusTitle = status === "pre-launch" ? "Launch Tracker" : status === "frozen" ? "Failed Stablecoin Archive" : "Inactive Listing Record";
      expect(metadata.title).toContain(statusTitle);
      expect(metadata.description).not.toContain("Compare PAXG with XAUT");
      expect(metadata.alternates?.canonical).toBe("/stablecoin/paxg-paxos/");
      expect(metadata.robots).toEqual(INDEXABLE_ROBOTS);
    },
  );

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

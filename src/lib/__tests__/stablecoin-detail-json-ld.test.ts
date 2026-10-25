import { describe, expect, it, vi } from "vitest";
import { makeStablecoinMeta } from "@shared/test-utils/stablecoin";
import {
  buildPreLaunchStablecoinJsonLd,
  buildStablecoinBreadcrumbItems,
  buildStablecoinDatasetJsonLd,
} from "@/lib/stablecoin-detail-json-ld";

vi.mock("@shared/lib/stablecoins/registry", () => ({
  TRACKED_META_BY_ID: new Map([["usdc-circle", { symbol: "USDC" }]]),
}));

vi.mock("@/lib/peg-landing", () => ({
  buildPegLandingUrl: (peg: string) => (peg === "USD" ? "/stablecoins/usd/" : null),
}));

describe("buildStablecoinDatasetJsonLd", () => {
  it("omits dateModified unless an explicit source date is provided", () => {
    const coin = makeStablecoinMeta();
    const withoutDate = buildStablecoinDatasetJsonLd(coin);
    const withDate = buildStablecoinDatasetJsonLd(coin, { dateModified: "2026-05-13T00:00:00.000Z" });

    expect(withoutDate).not.toHaveProperty("dateModified");
    expect(withDate.dateModified).toBe("2026-05-13T00:00:00.000Z");
  });

  it("emits each ISIN as a PropertyValue on the coin entity only", () => {
    const coin = makeStablecoinMeta({ identifiers: { isin: ["FR0014015LD3"] } });
    const jsonLd = buildStablecoinDatasetJsonLd(coin);
    const isinIdentifier = { "@type": "PropertyValue", propertyID: "ISIN", value: "FR0014015LD3" };

    expect(jsonLd.about.identifier).toContainEqual(isinIdentifier);
    expect(jsonLd.identifier).not.toContainEqual(isinIdentifier);
    expect(JSON.stringify(buildStablecoinDatasetJsonLd(makeStablecoinMeta()))).not.toContain('"ISIN"');
  });

  it.each([undefined, "quarantined", "delisted"] as const)(
    "declares the logo as image and primaryImageOfPage (status %s)",
    (status) => {
      const coin = makeStablecoinMeta({ status });
      const jsonLd = buildStablecoinDatasetJsonLd(coin, { logoPath: "/logos/coin.svg" });
      const logoUrl = "https://pharos.watch/logos/coin.svg";

      expect(jsonLd.image).toBe(logoUrl);
      expect(jsonLd.mainEntityOfPage).toMatchObject({
        "@type": "WebPage",
        url: jsonLd.url,
        primaryImageOfPage: { "@type": "ImageObject", contentUrl: logoUrl },
      });
    },
  );

  it("keeps mainEntityOfPage a plain URL when the coin has no logo", () => {
    const jsonLd = buildStablecoinDatasetJsonLd(makeStablecoinMeta());
    expect(jsonLd.mainEntityOfPage).toBe(jsonLd.url);
    expect(jsonLd).not.toHaveProperty("image");
  });
});

describe("buildPreLaunchStablecoinJsonLd", () => {
  it("dates the WebPage by its newest day-precision milestone", () => {
    const coin = makeStablecoinMeta({
      status: "pre-launch",
      milestones: [
        { date: "2026-08-12", type: "milestone", title: "Beta" },
        { date: "2026-10", type: "milestone", title: "Fuzzy month" },
        { date: "2026-10-16", type: "announcement", title: "Update" },
      ],
    });
    expect(buildPreLaunchStablecoinJsonLd(coin)[0].dateModified).toBe("2026-10-16");
    expect(buildPreLaunchStablecoinJsonLd(makeStablecoinMeta({ status: "pre-launch" }))[0]).not.toHaveProperty("dateModified");
  });

  it("drops planned and begin-after-launch copy for a launched row", () => {
    const [webPage] = buildPreLaunchStablecoinJsonLd(makeStablecoinMeta({
      status: "pre-launch",
      launchPhase: "launched",
      launchDate: "2026-10-15",
    }));
    expect(webPage.name).toMatch(/Stablecoin Status & Tracking$/);
    expect(webPage.description).toContain("launched Oct 15, 2026");
    expect(webPage.description).toContain("unavailable, not zero");
    expect(webPage.description).not.toMatch(/Planned|begin only after launch|Pre-launch/);
  });

  it("declares the logo on the WebPage and the stablecoin Thing", () => {
    const [webPage, thing] = buildPreLaunchStablecoinJsonLd(
      makeStablecoinMeta({ status: "pre-launch" }),
      { logoPath: "/logos/coin.png" },
    );

    expect(webPage).toMatchObject({
      "@type": "WebPage",
      primaryImageOfPage: { "@type": "ImageObject", contentUrl: "https://pharos.watch/logos/coin.png" },
    });
    expect(webPage).toHaveProperty("url");
    expect(thing).toMatchObject({ "@type": "Thing", image: "https://pharos.watch/logos/coin.png" });
  });
});

describe("buildStablecoinBreadcrumbItems", () => {
  it.each([undefined, "frozen", "quarantined", "delisted"] as const)(
    "puts the peg hub in the middle crumb (status %s)",
    (status) => {
      const coin = makeStablecoinMeta({ status });
      expect(buildStablecoinBreadcrumbItems(coin)[1]).toEqual({ name: "US Dollar Stablecoins", url: "/stablecoins/usd/" });
    },
  );

  it("falls back to the Stablecoins index without a built peg hub, and keeps Upcoming for pre-launch", () => {
    const base = makeStablecoinMeta();
    const noHub = makeStablecoinMeta({ flags: { ...base.flags, pegCurrency: "HKD" } });
    expect(buildStablecoinBreadcrumbItems(noHub)[1]).toEqual({ name: "Stablecoins", url: "/stablecoins/" });
    expect(buildStablecoinBreadcrumbItems(makeStablecoinMeta({ status: "pre-launch" }))[1])
      .toEqual({ name: "Upcoming", url: "/upcoming/" });
    expect(buildStablecoinBreadcrumbItems(base)).toHaveLength(3);
    expect(buildStablecoinBreadcrumbItems(base)[2].name).toBe(`${base.name} (${base.symbol})`);
  });
});

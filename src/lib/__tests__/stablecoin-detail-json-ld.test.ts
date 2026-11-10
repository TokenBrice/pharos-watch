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

  it("limits the asset sameAs to provider identity URLs, never catalog links", () => {
    const links = [
      { label: "Website", url: "https://tether.to/" },
      { label: "Transparency", url: "https://tether.to/en/transparency/?tab=reports" },
      { label: "USDT0", url: "https://usdt0.to/" },
    ];
    const coin = makeStablecoinMeta({
      id: "usdt-tether",
      name: "Tether",
      symbol: "USDT",
      geckoId: "tether",
      llamaId: "1",
      cmcSlug: "tether",
      links,
      proofOfReserves: { type: "attestation", url: "https://tether.to/en/transparency" },
    });
    const jsonLd = buildStablecoinDatasetJsonLd(coin);
    const about = jsonLd.about as Record<string, unknown>;

    expect(about.sameAs).toEqual([
      "https://www.coingecko.com/en/coins/tether",
      "https://defillama.com/stablecoin/1",
      "https://coinmarketcap.com/currencies/tether/",
    ]);
    for (const link of links) expect(about.sameAs).not.toContain(link.url);
    // Dataset identity stays the Pharos landing page and the catalog links remain source data.
    expect(jsonLd.sameAs).toEqual([jsonLd.url]);
    expect(coin.links).toEqual(links);
    expect(jsonLd.citation).toEqual(["https://tether.to/en/transparency"]);
    expect(jsonLd.license).toBe("https://creativecommons.org/licenses/by/4.0/");
    expect(jsonLd.distribution).toMatchObject([{ contentUrl: `${jsonLd.url}index.md` }]);
    expect(about["@id"]).toBe(`${jsonLd.url}#stablecoin`);
  });

  it("keeps a USDC-shaped profile on provider identity URLs only", () => {
    const links = [
      { label: "Website", url: "https://www.circle.com/" },
      { label: "Docs", url: "https://developers.circle.com/" },
      { label: "X", url: "https://x.com/circle" },
    ];
    const coin = makeStablecoinMeta({
      id: "usdc-circle",
      name: "USD Coin",
      symbol: "USDC",
      geckoId: "usd-coin",
      llamaId: "2",
      cmcSlug: "usd-coin",
      links,
    });
    const jsonLd = buildStablecoinDatasetJsonLd(coin);
    expect((jsonLd.about as Record<string, unknown>).sameAs).toEqual([
      "https://www.coingecko.com/en/coins/usd-coin",
      "https://defillama.com/stablecoin/2",
      "https://coinmarketcap.com/currencies/usd-coin/",
    ]);
    expect(JSON.stringify(jsonLd.about)).not.toMatch(/circle\.com|x\.com\/circle/);
  });

  it("omits the Thing sameAs when no provider identity exists, keeping Dataset identity", () => {
    const links = [{ label: "Website", url: "https://example.com/" }];
    const coin = makeStablecoinMeta({ id: "bare-coin", links });
    const jsonLd = buildStablecoinDatasetJsonLd(coin);
    expect(jsonLd.about).not.toHaveProperty("sameAs");
    expect(jsonLd.sameAs).toEqual([jsonLd.url]);
    expect(coin.links).toEqual(links);

    const [, preLaunchThing] = buildPreLaunchStablecoinJsonLd(makeStablecoinMeta({
      id: "bare-pre-launch",
      status: "pre-launch",
      links,
    }));
    expect(preLaunchThing).not.toHaveProperty("sameAs");
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
    expect(buildPreLaunchStablecoinJsonLd(coin)[0]).toHaveProperty("dateModified", "2026-10-16");
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

  it("uses only provider identity URLs on the pre-launch Thing", () => {
    const [, thing] = buildPreLaunchStablecoinJsonLd(makeStablecoinMeta({
      status: "pre-launch",
      geckoId: "tether",
      links: [
        { label: "Website", url: "https://tether.to/" },
        { label: "USDT0", url: "https://usdt0.to/" },
      ],
    }));
    expect((thing as { sameAs?: string[] }).sameAs).toEqual(["https://www.coingecko.com/en/coins/tether"]);
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

  it("names a launched-awaiting-data profile's published phase, not Upcoming", () => {
    const launched = makeStablecoinMeta({ status: "pre-launch", launchPhase: "launched" });
    expect(buildStablecoinBreadcrumbItems(launched)[1]).toEqual({
      name: "Launched – awaiting data",
      url: "/upcoming/",
    });
  });
});

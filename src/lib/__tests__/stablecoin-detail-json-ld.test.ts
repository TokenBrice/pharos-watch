import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  buildPreLaunchStablecoinJsonLd,
  buildStablecoinDatasetJsonLd,
  CONTRACT_IDENTIFIER_JSON_LD_LIMIT,
} from "@/lib/stablecoin-detail-json-ld";

describe("buildStablecoinDatasetJsonLd", () => {
  it("caps contract identifiers without exposing private site-data downloads", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    const jsonLd = buildStablecoinDatasetJsonLd(coin, {
      dateModified: "2026-05-13T00:00:00.000Z",
      logoPath: "/logos/usdt-tether.png",
    });
    const identifiers = jsonLd.identifier.filter(
      (identifier) => typeof identifier.propertyID === "string" && identifier.propertyID.startsWith("contract:"),
    );

    expect((coin.contracts ?? []).length).toBeGreaterThan(CONTRACT_IDENTIFIER_JSON_LD_LIMIT);
    expect(identifiers).toHaveLength(CONTRACT_IDENTIFIER_JSON_LD_LIMIT);
    expect(jsonLd.identifier).toContainEqual({
      "@type": "PropertyValue",
      propertyID: "Pharos URN",
      value: "urn:pharos:coin:usdt-tether",
    });
    expect(jsonLd.identifier).toContainEqual({
      "@type": "PropertyValue",
      propertyID: "llamaId",
      value: "1",
    });
    expect(jsonLd.identifier).toContainEqual({
      "@type": "PropertyValue",
      propertyID: "geckoId",
      value: "tether",
    });
    expect(jsonLd).toMatchObject({
      inLanguage: "en",
      mainEntityOfPage: "https://pharos.watch/stablecoin/usdt-tether/",
      about: {
        "@type": "Thing",
        "@id": "https://pharos.watch/stablecoin/usdt-tether/#stablecoin",
        name: "Tether",
        alternateName: "USDT",
        image: "https://pharos.watch/logos/usdt-tether.png",
      },
      image: "https://pharos.watch/logos/usdt-tether.png",
      creator: { "@id": "https://pharos.watch#organization", "@type": "Organization", name: "Pharos" },
      publisher: { "@id": "https://pharos.watch#organization", "@type": "Organization", name: "Pharos" },
    });
    expect(jsonLd).not.toHaveProperty("isPartOf");
    expect(jsonLd.distribution).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          "@type": "DataDownload",
          encodingFormat: "application/json",
          contentUrl: "https://api.pharos.watch/api/stablecoin/usdt-tether",
        }),
        expect.objectContaining({
          "@type": "DataDownload",
          encodingFormat: "text/markdown",
          contentUrl: "https://pharos.watch/stablecoin/usdt-tether/index.md",
        }),
      ]),
    );
    expect(JSON.stringify(jsonLd)).not.toContain("/_site-data/");
  });

  it("exposes redemption backstop coverage as an active analytics measurement", () => {
    const coin = TRACKED_META_BY_ID.get("usdc-circle")!;
    const jsonLd = buildStablecoinDatasetJsonLd(coin);

    expect(jsonLd.description).toContain("redemption backstop coverage");
    expect(jsonLd.variableMeasured).toContainEqual({
      "@type": "PropertyValue",
      name: "redemptionBackstopCoverage",
    });
  });

  it("omits dateModified unless an explicit source date is provided", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    const withoutDate = buildStablecoinDatasetJsonLd(coin);
    const withDate = buildStablecoinDatasetJsonLd(coin, { dateModified: "2026-05-13T00:00:00.000Z" });

    expect(withoutDate).not.toHaveProperty("dateModified");
    expect(withDate.dateModified).toBe("2026-05-13T00:00:00.000Z");
  });

  it("uses archive wording for frozen stablecoin datasets", () => {
    const coin = TRACKED_META_BY_ID.get("usnd-nerite")!;
    const jsonLd = buildStablecoinDatasetJsonLd(coin, { dateModified: "2026-05-13" });

    expect(jsonLd.name).toContain("Frozen Stablecoin Archive");
    expect(jsonLd.description).toContain("Historical archive");
    expect(jsonLd.description).not.toContain("Live analytics");
    expect(JSON.stringify(jsonLd.variableMeasured)).not.toContain("marketCap");
  });
});

describe("buildPreLaunchStablecoinJsonLd", () => {
  it("uses conservative WebPage and Thing schema for pre-launch stablecoins", () => {
    const coin = TRACKED_META_BY_ID.get("fiusd-fiserv")!;
    const jsonLd = buildPreLaunchStablecoinJsonLd(coin);

    expect(jsonLd).toHaveLength(2);
    expect(jsonLd[0]).toMatchObject({
      "@type": "WebPage",
      name: expect.stringContaining("Pre-launch Stablecoin Tracker"),
      url: "https://pharos.watch/stablecoin/fiusd-fiserv/",
    });
    expect(jsonLd[1]).toMatchObject({
      "@type": "Thing",
      name: coin.name,
      alternateName: coin.symbol,
    });
    expect(JSON.stringify(jsonLd)).not.toContain("Dataset");
    expect(JSON.stringify(jsonLd)).not.toContain("Live analytics");
  });
});

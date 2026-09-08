import { describe, expect, it, vi } from "vitest";
import { makeStablecoinMeta } from "@shared/test-utils/stablecoin";
import {
  buildPreLaunchStablecoinJsonLd,
  buildStablecoinDatasetJsonLd,
  CONTRACT_IDENTIFIER_JSON_LD_LIMIT,
} from "@/lib/stablecoin-detail-json-ld";

vi.mock("@shared/lib/stablecoins/registry", () => ({
  TRACKED_META_BY_ID: new Map([["usdc-circle", { symbol: "USDC" }]]),
}));

describe("buildStablecoinDatasetJsonLd", () => {
  it("caps contract identifiers without exposing private site-data downloads", () => {
    const coin = makeStablecoinMeta({
      id: "usdt-tether", name: "Tether", symbol: "USDT", llamaId: "1", geckoId: "tether",
      contracts: Array.from({ length: CONTRACT_IDENTIFIER_JSON_LD_LIMIT + 1 }, (_, index) => ({
        chain: "ethereum", address: `0x${index.toString(16).padStart(40, "0")}`, decimals: 6,
      })),
    });
    const jsonLd = buildStablecoinDatasetJsonLd(coin, {
      dateModified: "2026-05-13T00:00:00.000Z",
      logoPath: "/logos/usdt-tether.png",
    });
    const identifiers = jsonLd.identifier.filter(
      (identifier) => typeof identifier.propertyID === "string" && identifier.propertyID.startsWith("contract:"),
    );

    expect(identifiers.map((identifier) => identifier.value)).toEqual(
      coin.contracts!.slice(0, CONTRACT_IDENTIFIER_JSON_LD_LIMIT).map((contract) => contract.address),
    );
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
    expect(jsonLd.distribution).toEqual([
      expect.objectContaining({
        "@type": "DataDownload",
        encodingFormat: "text/markdown",
        contentUrl: "https://pharos.watch/stablecoin/usdt-tether/index.md",
      }),
    ]);
    // Dataset distributions must be publicly crawlable; the Worker API requires
    // X-API-Key and returned 401 to anonymous crawlers.
    expect(JSON.stringify(jsonLd.distribution)).not.toContain("api.pharos.watch");
    // sameAs on a Dataset identifies the dataset, not its subject. Third-party
    // coin identity links belong on the nested `about` Thing.
    expect(jsonLd.sameAs).toEqual(["https://pharos.watch/stablecoin/usdt-tether/"]);
    expect(JSON.stringify(jsonLd.sameAs)).not.toContain("coingecko");
    expect(JSON.stringify(jsonLd)).not.toContain("/_site-data/");
  });

  it("describes only the catalog fields actually present in the markdown profile", () => {
    const coin = makeStablecoinMeta();
    const jsonLd = buildStablecoinDatasetJsonLd(coin);

    expect(jsonLd.description).toContain("Build-time profile");
    expect(jsonLd.description).toContain("not live prices or scores");
    expect(jsonLd.variableMeasured.map((variable) => variable.name)).toEqual([
      "pegReference", "backing", "governance", "listingStatus",
    ]);
    expect(jsonLd.measurementTechnique).toContain("editorial summary update date");
    expect(JSON.stringify(jsonLd.variableMeasured)).not.toMatch(/price|marketCap|circulatingSupply|Score|Grade/);
  });

  it("uses NAV-aware descriptions for yield-bearing strategy shares", () => {
    const coin = makeStablecoinMeta({
      flags: { ...makeStablecoinMeta().flags, navToken: true, yieldBearing: true },
      pegReferenceId: "usdc-circle",
    });
    const jsonLd = buildStablecoinDatasetJsonLd(coin);

    expect(jsonLd.description).toContain("yield-bearing token with USDC-denominated NAV");
    expect(jsonLd.description).not.toContain("pegged to US Dollar");
  });

  it("omits dateModified unless an explicit source date is provided", () => {
    const coin = makeStablecoinMeta();
    const withoutDate = buildStablecoinDatasetJsonLd(coin);
    const withDate = buildStablecoinDatasetJsonLd(coin, { dateModified: "2026-05-13T00:00:00.000Z" });

    expect(withoutDate).not.toHaveProperty("dateModified");
    expect(withDate.dateModified).toBe("2026-05-13T00:00:00.000Z");
  });

  it("uses archive wording for frozen stablecoin datasets", () => {
    const coin = makeStablecoinMeta({ status: "frozen" });
    const jsonLd = buildStablecoinDatasetJsonLd(coin, { dateModified: "2026-05-13" });

    expect(jsonLd.name).toContain("Frozen Stablecoin Archive");
    expect(jsonLd.description).toContain("Historical archive");
    expect(jsonLd.description).not.toContain("Live analytics");
    expect(JSON.stringify(jsonLd.variableMeasured)).not.toContain("marketCap");
  });
});

describe("buildPreLaunchStablecoinJsonLd", () => {
  it("uses conservative WebPage and Thing schema for pre-launch stablecoins", () => {
    const coin = makeStablecoinMeta({ id: "fiusd-fiserv", status: "pre-launch" });
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

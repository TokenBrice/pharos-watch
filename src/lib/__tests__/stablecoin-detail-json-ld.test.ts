import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import {
  buildStablecoinDatasetJsonLd,
  CONTRACT_IDENTIFIER_JSON_LD_LIMIT,
} from "@/lib/stablecoin-detail-json-ld";

describe("buildStablecoinDatasetJsonLd", () => {
  it("caps contract identifiers and links the full site-data payload", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    const jsonLd = buildStablecoinDatasetJsonLd(coin, {
      siteUrl: "https://pharos.watch",
      dateModified: "2026-05-13T00:00:00.000Z",
    });
    const identifiers = jsonLd.identifier.filter(
      (identifier) => identifier.propertyID.startsWith("contract:"),
    );

    expect((coin.contracts ?? []).length).toBeGreaterThan(CONTRACT_IDENTIFIER_JSON_LD_LIMIT);
    expect(identifiers).toHaveLength(CONTRACT_IDENTIFIER_JSON_LD_LIMIT);
    expect(jsonLd.distribution).toEqual([
      {
        "@type": "DataDownload",
        name: `${coin.name} detail JSON`,
        encodingFormat: "application/json",
        contentUrl: `https://pharos.watch/_site-data/stablecoin/${coin.id}`,
      },
    ]);
  });
});

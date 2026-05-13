import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import {
  buildStablecoinDatasetJsonLd,
  CONTRACT_IDENTIFIER_JSON_LD_LIMIT,
} from "@/lib/stablecoin-detail-json-ld";

describe("buildStablecoinDatasetJsonLd", () => {
  it("caps contract identifiers without exposing private site-data downloads", () => {
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
    expect(jsonLd).not.toHaveProperty("distribution");
    expect(JSON.stringify(jsonLd)).not.toContain("/_site-data/");
  });

  it("omits dateModified unless an explicit source date is provided", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    const withoutDate = buildStablecoinDatasetJsonLd(coin, {
      siteUrl: "https://pharos.watch",
    });
    const withDate = buildStablecoinDatasetJsonLd(coin, {
      siteUrl: "https://pharos.watch",
      dateModified: "2026-05-13T00:00:00.000Z",
    });

    expect(withoutDate).not.toHaveProperty("dateModified");
    expect(withDate.dateModified).toBe("2026-05-13T00:00:00.000Z");
  });
});

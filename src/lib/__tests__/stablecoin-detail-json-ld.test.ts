import { describe, expect, it, vi } from "vitest";
import { makeStablecoinMeta } from "@shared/test-utils/stablecoin";
import {
  buildStablecoinDatasetJsonLd,
} from "@/lib/stablecoin-detail-json-ld";

vi.mock("@shared/lib/stablecoins/registry", () => ({
  TRACKED_META_BY_ID: new Map([["usdc-circle", { symbol: "USDC" }]]),
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
});


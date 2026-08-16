import { describe, expect, it } from "vitest";
import { buildStablecoinItemListEntries } from "@/lib/json-ld";

describe("buildStablecoinItemListEntries", () => {
  it("owns the canonical stablecoin label, URL, and optional entry fields", () => {
    expect(buildStablecoinItemListEntries(
      [{ id: "usdc-circle", name: "USD Coin", symbol: "USDC", href: "/stablecoin/usdc-circle/", note: "Tracked" }],
      {
        schemaType: "Thing",
        resolveUrl: (coin) => `https://pharos.watch${coin.href}`,
        resolveId: (coin) => `urn:coin:${coin.id}`,
        resolveImage: () => "https://pharos.watch/logos/usdc.png",
        resolveDescription: (coin) => coin.note,
        includeMainEntityOfPage: true,
      },
    )).toEqual([
      {
        item: {
          "@type": "Thing",
          "@id": "urn:coin:usdc-circle",
          name: "USD Coin (USDC)",
          url: "https://pharos.watch/stablecoin/usdc-circle/",
          image: "https://pharos.watch/logos/usdc.png",
          description: "Tracked",
          mainEntityOfPage: "https://pharos.watch/stablecoin/usdc-circle/",
        },
      },
    ]);
  });
});

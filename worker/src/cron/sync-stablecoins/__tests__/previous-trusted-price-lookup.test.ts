import { describe, expect, it } from "vitest";
import { buildPreviousTrustedPriceLookup } from "../pricing";
import type { PeggedAsset } from "../enrich-prices";
import { makePeggedAsset } from "./_fixtures";
import type { PriceCacheEntry } from "../../../lib/db-cache";

const NOW_SEC = 1_700_000_000;

function makeAsset(overrides: Partial<PeggedAsset> = {}): PeggedAsset {
  return makePeggedAsset({
    price: 1.0,
    priceSource: "pyth",
    priceConfidence: "single-source",
    priceObservedAt: NOW_SEC - 60,
    priceObservedAtMode: "upstream",
    priceUpdatedAt: NOW_SEC - 60,
    agreeSources: ["pyth"],
    ...overrides,
  });
}

function makeCacheEntry(overrides: Partial<PriceCacheEntry> = {}): PriceCacheEntry {
  return {
    price: 1.0,
    updatedAt: NOW_SEC - 60,
    source: "pyth",
    confidence: "single-source",
    observedAt: NOW_SEC - 60,
    observedAtMode: "upstream",
    syncedAt: NOW_SEC - 60,
    agreeSources: ["pyth"],
    ...overrides,
  };
}

describe("buildPreviousTrustedPriceLookup", () => {
  it("returns previous-cache row when replay cache has no matching entry", () => {
    const previous = new Map<string, PeggedAsset>([["usdt-tether", makeAsset({ price: 1.0 })]]);
    const replay = new Map<string, PriceCacheEntry>();

    const lookup = buildPreviousTrustedPriceLookup(previous, NOW_SEC, replay);

    const entry = lookup.get("usdt-tether");
    expect(entry).toBeDefined();
    expect(entry?.price).toBe(1.0);
    expect(entry?.source).toBe("pyth");
  });

  it("returns replay-cache row when previous-cache has no matching entry", () => {
    const previous = new Map<string, PeggedAsset>();
    const replay = new Map<string, PriceCacheEntry>([
      ["usdt-tether", makeCacheEntry({ price: 0.998 })],
    ]);

    const lookup = buildPreviousTrustedPriceLookup(previous, NOW_SEC, replay);

    const entry = lookup.get("usdt-tether");
    expect(entry).toBeDefined();
    expect(entry?.price).toBe(0.998);
    expect(entry?.source).toBe("pyth");
  });

  it("prefers replay-cache row when its observedAt is later than previous-cache", () => {
    const previous = new Map<string, PeggedAsset>([
      [
        "usdt-tether",
        makeAsset({
          price: 1.0,
          priceObservedAt: NOW_SEC - 300,
          priceUpdatedAt: NOW_SEC - 300,
        }),
      ],
    ]);
    const replay = new Map<string, PriceCacheEntry>([
      [
        "usdt-tether",
        makeCacheEntry({
          price: 0.9987,
          observedAt: NOW_SEC - 30,
          updatedAt: NOW_SEC - 30,
        }),
      ],
    ]);

    const lookup = buildPreviousTrustedPriceLookup(previous, NOW_SEC, replay);

    expect(lookup.get("usdt-tether")?.price).toBe(0.9987);
    expect(lookup.get("usdt-tether")?.observedAt).toBe(NOW_SEC - 30);
  });

  it("keeps previous-cache row when its observedAt is later than replay-cache", () => {
    const previous = new Map<string, PeggedAsset>([
      [
        "usdt-tether",
        makeAsset({
          price: 1.0003,
          priceObservedAt: NOW_SEC - 30,
          priceUpdatedAt: NOW_SEC - 30,
        }),
      ],
    ]);
    const replay = new Map<string, PriceCacheEntry>([
      [
        "usdt-tether",
        makeCacheEntry({
          price: 0.9987,
          observedAt: NOW_SEC - 300,
          updatedAt: NOW_SEC - 300,
        }),
      ],
    ]);

    const lookup = buildPreviousTrustedPriceLookup(previous, NOW_SEC, replay);

    expect(lookup.get("usdt-tether")?.price).toBe(1.0003);
    expect(lookup.get("usdt-tether")?.observedAt).toBe(NOW_SEC - 30);
  });

  it("uses replay-cache row regardless of observedAt when previous-cache is non-authoritative (low confidence)", () => {
    const previous = new Map<string, PeggedAsset>([
      [
        "usdt-tether",
        makeAsset({
          price: 1.02,
          priceConfidence: "low",
          priceObservedAt: NOW_SEC - 30,
          priceUpdatedAt: NOW_SEC - 30,
        }),
      ],
    ]);
    const replay = new Map<string, PriceCacheEntry>([
      [
        "usdt-tether",
        makeCacheEntry({
          price: 0.9987,
          observedAt: NOW_SEC - 300,
          updatedAt: NOW_SEC - 300,
        }),
      ],
    ]);

    const lookup = buildPreviousTrustedPriceLookup(previous, NOW_SEC, replay);

    // Previous is filtered out (non-authoritative); replay wins despite older observedAt.
    expect(lookup.get("usdt-tether")?.price).toBe(0.9987);
    expect(lookup.get("usdt-tether")?.source).toBe("pyth");
  });

  it("keeps previous-cache row when both have equal observedAt (first-writer wins; previousAssetsById is iterated before replay)", () => {
    // previousAssetsById is iterated first, then replayPriceCache. On ties, the
    // existing-lookup strict-gte short-circuit prevents replay from overwriting.
    const previous = new Map<string, PeggedAsset>([
      [
        "usdt-tether",
        makeAsset({
          price: 1.0,
          priceObservedAt: NOW_SEC - 60,
          priceUpdatedAt: NOW_SEC - 60,
        }),
      ],
    ]);
    const replay = new Map<string, PriceCacheEntry>([
      [
        "usdt-tether",
        makeCacheEntry({
          price: 0.997,
          observedAt: NOW_SEC - 60,
          updatedAt: NOW_SEC - 60,
        }),
      ],
    ]);

    const lookup = buildPreviousTrustedPriceLookup(previous, NOW_SEC, replay);

    // previousAssetsById is inserted first; equal observedAt means replay does NOT overwrite.
    expect(lookup.get("usdt-tether")?.price).toBe(1.0);
  });
});

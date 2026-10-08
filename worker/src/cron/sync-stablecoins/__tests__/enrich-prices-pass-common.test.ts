import { describe, expect, it } from "vitest";
import {
  collectMissingPriceCandidates,
  isFreshFallbackObservedAt,
  isUsableFallbackPrice,
  parseUnixOrIsoTimestampSec,
} from "../enrich-prices-pass-common";
import { makePeggedAsset } from "./_fixtures";

describe("fallback quote admission helpers", () => {
  it("preserves source indexes and omits unavailable enrichment rather than admitting it", () => {
    const assets = [
      makePeggedAsset({ id: "priced", price: 1 }),
      makePeggedAsset({ id: "missing", price: null }),
      makePeggedAsset({ id: "zero", price: 0 }),
    ];
    expect(collectMissingPriceCandidates(assets).map(({ asset, index }) => [asset.id, index])).toEqual([
      ["missing", 1], ["zero", 2],
    ]);
    expect(collectMissingPriceCandidates(assets, (asset) => asset.id === "missing" ? { target: "exact-address" } : null)).toEqual([
      { asset: assets[1], index: 1, target: "exact-address" },
    ]);
    expect(assets.map((asset) => asset.price)).toEqual([1, null, 0]);
  });

  it("requires an available clock inside the age and future-skew budgets", () => {
    const now = 1_777_000_000;
    expect(isFreshFallbackObservedAt(now - 600, 600, now)).toBe(true);
    expect(isFreshFallbackObservedAt(now - 601, 600, now)).toBe(false);
    expect(isFreshFallbackObservedAt(now + 120, 600, now)).toBe(true);
    expect(isFreshFallbackObservedAt(now + 121, 600, now)).toBe(false);
    for (const missing of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isFreshFallbackObservedAt(missing, 600, now)).toBe(false);
    }
  });

  it("parses upstream Unix/ISO clocks without inventing unavailable timestamps", () => {
    expect(parseUnixOrIsoTimestampSec(1_777_000_000.9)).toBe(1_777_000_000);
    expect(parseUnixOrIsoTimestampSec("2026-01-01T00:00:00Z")).toBe(1_767_225_600);
    for (const missing of [null, undefined, "", "not-a-date", Number.NaN, {}]) {
      expect(parseUnixOrIsoTimestampSec(missing)).toBeNull();
    }
  });

  it("admits plausible USD quotes and rejects nonpositive, nonfinite and out-of-peg values", () => {
    const asset = makePeggedAsset({ id: "usdt-tether", pegType: "peggedUSD" });
    expect(isUsableFallbackPrice(asset, 1, undefined)).toBe(true);
    for (const price of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 100]) {
      expect(isUsableFallbackPrice(asset, price, undefined)).toBe(false);
    }
  });
});

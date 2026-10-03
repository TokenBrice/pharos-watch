import { describe, expect, it } from "vitest";
import { BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC } from "@shared/types/live-reserve-adapter-policy";
import { decodeReserveNavPrice, reserveNavSupplyScopeReason } from "../reserve-nav-price";
import { LIVE_RESERVE_FRESHNESS_SEC } from "../live-reserves/store-shared";

const now = Date.parse("2026-10-03T12:00:00Z") / 1000;
const row = { source: "jpmorgan-nav", fetched_at: now - 60, metadata: JSON.stringify({ navPerToken: 0.998, sourceTimestamp: now - 2 * 86400 }) };
const classMetadata = {
  navPerToken: 1, sourceTimestamp: Date.parse("2026-10-01T00:00:00Z") / 1000, freshnessMode: "verified",
  details: { cusip: "46655R119", shareClassNumber: "4397", ticker: "JLTXX", dealingDate: "2026-10-01", classAssetsUsd: 700_000_000 },
};
const classRow = { ...row, metadata: JSON.stringify(classMetadata) };

describe("reserve NAV admission", () => {
  it("values current NAV in upstream units and preserves its evidence clock", () => {
    expect(decodeReserveNavPrice(row, now)).toMatchObject({ source: "jpmorgan-nav", price: 0.998, observedAt: now - 2 * 86400, observedAtMode: "upstream" });
  });

  it("cannot renew a stale issuer value by re-fetching the snapshot", () => {
    expect(decodeReserveNavPrice({ ...row, fetched_at: now, metadata: JSON.stringify({ navPerToken: 1, sourceTimestamp: now - BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC - 1 }) }, now)).toBeNull();
  });

  it("requires fresh successful-fetch evidence independently of the NAV clock", () => {
    expect(decodeReserveNavPrice({ ...row, fetched_at: now - LIVE_RESERVE_FRESHNESS_SEC - 1 }, now)).toBeNull();
    expect(decodeReserveNavPrice({ ...row, fetched_at: now + 1 }, now)).toBeNull();
  });

  it.each([
    "null", "[]", "broken", '{"navPerToken":1}',
    JSON.stringify({ navPerToken: 0, sourceTimestamp: now }),
    JSON.stringify({ navPerToken: -1, sourceTimestamp: now }),
    JSON.stringify({ navPerToken: "Infinity", sourceTimestamp: now }),
    JSON.stringify({ navPerToken: 1, sourceTimestamp: now + 3600 }),
  ])("withholds malformed or unavailable evidence (%s)", (metadata) => {
    expect(decodeReserveNavPrice({ ...row, metadata }, now)).toBeNull();
  });

  it("does not admit a NAV number from an unrelated reserve adapter", () => {
    expect(decodeReserveNavPrice({ ...row, source: "circle-transparency" }, now)).toBeNull();
  });

  it.each([696_500_000, 700_000_000, 703_500_000])("admits both inclusive 0.5%% boundaries (%s)", (valuation) => {
    expect(reserveNavSupplyScopeReason(decodeReserveNavPrice(classRow, now), valuation)).toBeNull();
  });

  it.each([600_000_000, 696_499_999, 703_500_001])("rejects out-of-scope supply valuations (%s)", (valuation) => {
    expect(reserveNavSupplyScopeReason(decodeReserveNavPrice(classRow, now), valuation)).toBe("class-assets-supply-divergence");
  });

  it.each([
    { ...classMetadata, freshnessMode: "unverified" },
    { ...classMetadata, details: { ...classMetadata.details, shareClassNumber: "wrong" } },
    { ...classMetadata, details: { ...classMetadata.details, dealingDate: "2026-09-30" } },
    { ...classMetadata, details: { ...classMetadata.details, classAssetsUsd: 0 } },
    { ...classMetadata, details: { ...classMetadata.details, classAssetsUsd: undefined } },
    { ...classMetadata, sourceTimestamp: now - BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC - 1 },
  ])("withholds unavailable, unverified, incoherent or stale class evidence (%s)", (metadata) => {
    const quote = decodeReserveNavPrice({ ...classRow, metadata: JSON.stringify(metadata) }, now);
    expect(reserveNavSupplyScopeReason(quote, 700_000_000)).toBe("class-assets-unavailable");
  });

  it.each([0, -1, NaN, Infinity])("rejects invalid native valuations rather than claiming scope (%s)", (valuation) => {
    expect(reserveNavSupplyScopeReason(decodeReserveNavPrice(classRow, now), valuation)).toBe("invalid-onchain-valuation");
  });
});

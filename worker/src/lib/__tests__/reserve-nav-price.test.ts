import { describe, expect, it } from "vitest";
import { BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC } from "@shared/types/live-reserve-adapter-policy";
import { decodeReserveNavPrice } from "../reserve-nav-price";
import { LIVE_RESERVE_FRESHNESS_SEC } from "../live-reserves/store-shared";

const now = Date.parse("2026-10-03T12:00:00Z") / 1000;
const row = { source: "jpmorgan-nav", fetched_at: now - 60, metadata: JSON.stringify({ navPerToken: 0.998, sourceTimestamp: now - 2 * 86400 }) };

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
});

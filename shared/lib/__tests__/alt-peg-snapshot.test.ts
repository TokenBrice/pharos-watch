import { describe, expect, it } from "vitest";
import { buildNonUsdMarketSnapshot, formatNonUsdShare, getCoreNonUsdPeg } from "../alt-peg-snapshot";
import { CLIENT_ACTIVE_META_BY_ID } from "../stablecoins/client-registry";
import { CLIENT_CORE_AGGREGATE_ACTIVE_IDS } from "../stablecoins/aggregate-client-registry";
import { CORE_NON_USD_IDS, coreNonUsdRows } from "../../test-utils/alt-peg-fixtures";

const row = (id: string, circulating: Record<string, number> | null) => ({ id, name: id, symbol: id.toUpperCase(), circulating });

const complete = (caps: Record<string, number | null | "omit">) =>
  coreNonUsdRows((id, cap) => row(id, cap === null ? {} : { usd: cap }), caps);

describe("buildNonUsdMarketSnapshot", () => {
  it("classifies by registry peg over the core universe, once per member", () => {
    const snapshot = buildNonUsdMarketSnapshot([
      row("usdc-circle", { usd: 100 }),
      row("eurc-circle", { usd: 60 }),
      row("not-a-coin", { usd: 1_000 }),
      ...complete({ "eurc-circle": 60, "paxg-paxos": 40 }),
    ]);
    expect(snapshot).toMatchObject({
      altMarketCap: 100,
      commodityMarketCap: 40,
      nonCommodityMarketCap: 60,
      commoditySharePct: 40,
      nonCommoditySharePct: 60,
      altCoinCount: CORE_NON_USD_IDS.length,
      altSupplyUnavailableCount: 0,
    });
    expect(snapshot.pegs.slice(0, 2).map((entry) => [entry.peg, entry.sharePct, entry.leader?.id])).toEqual([
      ["EUR", 60, "eurc-circle"],
      ["GOLD", 40, "paxg-paxos"],
    ]);
  });

  it("keeps an unavailable member out of the sum and withholds every share", () => {
    const snapshot = buildNonUsdMarketSnapshot(complete({ "eurc-circle": 60, "paxg-paxos": null }));
    expect(snapshot.altMarketCap).toBe(60);
    expect(snapshot.altSupplyUnavailableCount).toBe(1);
    expect(snapshot.commoditySharePct).toBeNull();
    expect(snapshot.pegs.every((entry) => entry.sharePct === null)).toBe(true);
  });

  it("counts a core member absent from the list as unavailable, like the homepage reducer", () => {
    const snapshot = buildNonUsdMarketSnapshot(complete({ "eurc-circle": 60, "eurs-stasis": "omit" }));
    expect(snapshot.altCoinCount).toBe(CORE_NON_USD_IDS.length);
    expect(snapshot.altSupplyUnavailableCount).toBe(1);
    expect(snapshot.altSharePct).toBeNull();
    expect(snapshot.commoditySharePct).toBeNull();
    expect(snapshot.pegs.find((entry) => entry.peg === "EUR")).toMatchObject({ marketCap: 60, sharePct: null, supplyUnavailableCount: 1 });
  });

  it("keeps an observed zero numeric", () => {
    const snapshot = buildNonUsdMarketSnapshot(complete({}));
    expect(snapshot.altMarketCap).toBe(0);
    expect(snapshot.altSupplyUnavailableCount).toBe(0);
  });

  it("returns no figure for absent rows", () => {
    expect(buildNonUsdMarketSnapshot(undefined).altMarketCap).toBeNull();
    expect(buildNonUsdMarketSnapshot([]).pegs).toEqual([]);
  });
});

describe("getCoreNonUsdPeg", () => {
  it("admits exactly the core members whose registry peg is not USD", () => {
    for (const id of CLIENT_CORE_AGGREGATE_ACTIVE_IDS) {
      const peg = CLIENT_ACTIVE_META_BY_ID.get(id)?.flags.pegCurrency;
      expect(getCoreNonUsdPeg(id)).toBe(peg && peg !== "USD" ? peg : null);
    }
    expect(getCoreNonUsdPeg("not-a-coin")).toBeNull();
  });
});

describe("formatNonUsdShare", () => {
  it("never prints a nonzero share as zero, and keeps unavailable distinct", () => {
    expect(formatNonUsdShare(0.03)).toBe("<0.1%");
    expect(formatNonUsdShare(0)).toBe("0.0%");
    expect(formatNonUsdShare(56.88)).toBe("56.9%");
    expect(formatNonUsdShare(null)).toBe("—");
  });
});

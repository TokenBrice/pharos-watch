import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS } from "../registry";
import {
  ACTIVE_REVIEW_HOLD_STABLECOINS,
  ACTIVE_TOKENIZED_FUNDS,
  ACTIVE_VARIANT_STABLECOINS,
  CORE_AGGREGATE_ACTIVE_IDS,
  CORE_AGGREGATE_ACTIVE_STABLECOINS,
} from "../aggregate-registry";
import {
  CLIENT_ACTIVE_TOKENIZED_FUND_IDS,
  CLIENT_ACTIVE_VARIANT_IDS,
  CLIENT_CORE_AGGREGATE_ACTIVE_IDS,
} from "../aggregate-client-registry";
import {
  filterCoreAggregateStablecoins,
  filterTokenizedFunds,
  isCoreAggregateStablecoinId,
} from "../aggregate-universe";
import { getListingClass, isTokenizedFundId } from "../listing-governance";

describe("core stablecoin aggregate universe", () => {
  it("includes only reviewed core stablecoins", () => {
    expect(CORE_AGGREGATE_ACTIVE_STABLECOINS.length).toBeGreaterThan(0);

    for (const stablecoin of CORE_AGGREGATE_ACTIVE_STABLECOINS) {
      expect(getListingClass(stablecoin.id)).toBe("core-stablecoin");
      expect(CORE_AGGREGATE_ACTIVE_IDS.has(stablecoin.id)).toBe(true);
      expect(CLIENT_CORE_AGGREGATE_ACTIVE_IDS.has(stablecoin.id)).toBe(true);
      expect(isCoreAggregateStablecoinId(stablecoin.id)).toBe(true);
      expect(isTokenizedFundId(stablecoin.id)).toBe(false);
    }
  });

  it("keeps variants, tokenized funds, and review-hold rows outside the monetary aggregate", () => {
    expect(ACTIVE_VARIANT_STABLECOINS.length).toBeGreaterThan(0);
    expect(ACTIVE_TOKENIZED_FUNDS.length).toBeGreaterThan(0);
    expect(ACTIVE_REVIEW_HOLD_STABLECOINS.length).toBeGreaterThan(0);

    for (const stablecoin of [
      ...ACTIVE_VARIANT_STABLECOINS,
      ...ACTIVE_TOKENIZED_FUNDS,
      ...ACTIVE_REVIEW_HOLD_STABLECOINS,
    ]) {
      expect(CORE_AGGREGATE_ACTIVE_IDS.has(stablecoin.id)).toBe(false);
    }

    expect(CLIENT_ACTIVE_VARIANT_IDS.size).toBe(ACTIVE_VARIANT_STABLECOINS.length);
    expect(CLIENT_ACTIVE_TOKENIZED_FUND_IDS.size).toBe(ACTIVE_TOKENIZED_FUNDS.length);
    for (const fund of ACTIVE_TOKENIZED_FUNDS) {
      expect(CLIENT_ACTIVE_TOKENIZED_FUND_IDS.has(fund.id)).toBe(true);
      expect(isTokenizedFundId(fund.id)).toBe(true);
    }
  });

  it("fails closed for rows without a listing decision", () => {
    expect(isCoreAggregateStablecoinId("unreviewed-asset")).toBe(false);
    expect(isTokenizedFundId("unreviewed-asset")).toBe(false);
    expect(filterCoreAggregateStablecoins([{ id: "unreviewed-asset" }])).toEqual([]);
    expect(filterTokenizedFunds([{ id: "unreviewed-asset" }])).toEqual([]);
  });

  it("partitions every active listing into the reviewed aggregate classes", () => {
    const partitions = [
      CORE_AGGREGATE_ACTIVE_STABLECOINS,
      ACTIVE_VARIANT_STABLECOINS,
      ACTIVE_TOKENIZED_FUNDS,
      ACTIVE_REVIEW_HOLD_STABLECOINS,
    ].map((coins) => coins.map((coin) => coin.id));
    const ids = partitions.flat();
    expect(ids.toSorted()).toEqual(ACTIVE_STABLECOINS.map((coin) => coin.id).toSorted());
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 0; i < partitions.length; i++) {
      for (const other of partitions.slice(i + 1)) {
        expect(partitions[i].filter((id) => other.includes(id))).toEqual([]);
      }
    }
  });
});

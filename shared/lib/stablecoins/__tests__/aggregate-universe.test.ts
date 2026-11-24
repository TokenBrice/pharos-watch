import { createHash } from "node:crypto";
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
  CLIENT_ACTIVE_ALL_STABLECOIN_IDS,
  CLIENT_ACTIVE_TOKENIZED_FUND_IDS,
  CLIENT_ACTIVE_VARIANT_IDS,
  CLIENT_CORE_AGGREGATE_ACTIVE_IDS,
} from "../aggregate-client-registry";
import {
  CORE_STABLECOIN_AGGREGATE_UNIVERSE,
  CORE_STABLECOIN_AGGREGATE_UNIVERSE_V1,
  CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_DATE,
  CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC,
  filterCoreAggregateStablecoins,
  filterTokenizedFunds,
  getCoreAggregateUniverseForTimestamp,
  isCoreAggregateStablecoinId,
} from "../aggregate-universe";
import {
  CORE_AGGREGATE_V1_MEMBERS_SNAPSHOT,
  CORE_AGGREGATE_V1_MEMBER_IDS,
  CORE_AGGREGATE_V1_MEMBER_LIST,
  CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_IDS,
  CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_LIST,
} from "../aggregate-universe-v1";
import { getListingClass, isTokenizedFundId } from "../listing-governance";
import {
  getLatestSupplyPerimeterChange,
  MARKET_PERIMETER_MARKERS,
  SUPPLY_PERIMETER_CHANGES,
} from "../../supply-perimeter-changes";

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
    expect(CLIENT_ACTIVE_ALL_STABLECOIN_IDS.size).toBe(
      CORE_AGGREGATE_ACTIVE_STABLECOINS.length +
        ACTIVE_VARIANT_STABLECOINS.length +
        ACTIVE_REVIEW_HOLD_STABLECOINS.length,
    );
    for (const fund of ACTIVE_TOKENIZED_FUNDS) {
      expect(CLIENT_ACTIVE_TOKENIZED_FUND_IDS.has(fund.id)).toBe(true);
      expect(CLIENT_ACTIVE_ALL_STABLECOIN_IDS.has(fund.id)).toBe(false);
      expect(isTokenizedFundId(fund.id)).toBe(true);
    }
    for (const stablecoin of [
      ...CORE_AGGREGATE_ACTIVE_STABLECOINS,
      ...ACTIVE_VARIANT_STABLECOINS,
      ...ACTIVE_REVIEW_HOLD_STABLECOINS,
    ]) {
      expect(CLIENT_ACTIVE_ALL_STABLECOIN_IDS.has(stablecoin.id)).toBe(true);
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

  it("exposes the v2 universe, single cutover date authority, and immutable frozen v1 membership", () => {
    expect(CORE_STABLECOIN_AGGREGATE_UNIVERSE_V1).toBe("core-stablecoins-v1");
    expect(CORE_STABLECOIN_AGGREGATE_UNIVERSE).toBe("core-stablecoins-v2");
    expect(CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC).toBe(
      Date.parse(`${CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_DATE}T00:00:00Z`) / 1000,
    );
    expect(getCoreAggregateUniverseForTimestamp(CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC - 1)).toBe("core-stablecoins-v1");
    expect(getCoreAggregateUniverseForTimestamp(CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC)).toBe("core-stablecoins-v2");

    // Frozen v1 membership at base commit 92c90ca72 must never mutate across v2 listing changes.
    expect(CORE_AGGREGATE_V1_MEMBERS_SNAPSHOT.schemaVersion).toBe(1);
    expect(CORE_AGGREGATE_V1_MEMBERS_SNAPSHOT.universe).toBe("core-stablecoins-v1");
    expect(CORE_AGGREGATE_V1_MEMBERS_SNAPSHOT.frozenFromCommit).toBe("92c90ca72");
    expect(CORE_AGGREGATE_V1_MEMBER_LIST).toHaveLength(262);
    expect(CORE_AGGREGATE_V1_MEMBER_IDS.size).toBe(262);
    expect([...CORE_AGGREGATE_V1_MEMBER_LIST].sort()).toEqual([...CORE_AGGREGATE_V1_MEMBER_LIST]);
    expect(createHash("sha256").update(JSON.stringify(CORE_AGGREGATE_V1_MEMBER_LIST)).digest("hex"))
      .toBe("0b06a93a1c7560bbba7e7c6658a67ca22a4f27bdaddd2d2cba6a7e8a42a50257");
    expect(CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_LIST).toHaveLength(48);
    expect(CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_IDS.size).toBe(48);
    expect([...CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_LIST].sort()).toEqual([...CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_LIST]);
    expect(createHash("sha256").update(JSON.stringify(CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_LIST)).digest("hex"))
      .toBe("412d63c841e807dc777d387021644b6262883b4f151d1adaaf7614f61ee7aa0f");
    expect(CORE_AGGREGATE_V1_MEMBER_IDS.has("buidl-blackrock")).toBe(true);
    expect(CORE_AGGREGATE_V1_MEMBER_IDS.has("eutbl-spiko")).toBe(true);
    expect(CORE_AGGREGATE_V1_MEMBER_IDS.has("apxusd-apyx")).toBe(false);
    expect(CORE_AGGREGATE_V1_MEMBER_IDS.has("susds-sky")).toBe(false);
  });

  it("registers the listing-policy v2 market-wide perimeter entry and chart marker from the cutover constant", () => {
    const v2Entry = SUPPLY_PERIMETER_CHANGES.find(
      (entry) => entry.marketWide && entry.changedAt === CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC,
    );
    expect(v2Entry).toBeDefined();
    expect(v2Entry?.stablecoinId).toBeNull();
    expect(getLatestSupplyPerimeterChange(
      CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC - 1,
      CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC,
    )).toBe(CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC);
    expect(MARKET_PERIMETER_MARKERS).toContainEqual(expect.objectContaining({
      id: CORE_STABLECOIN_AGGREGATE_UNIVERSE,
      date: CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_DATE,
      tsMs: CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC * 1000,
    }));
  });
});

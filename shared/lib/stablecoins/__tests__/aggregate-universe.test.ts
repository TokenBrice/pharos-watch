import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "../registry";
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
  CORE_AGGREGATE_V1_NON_ACTIVE_EXIT_DATES,
  CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_IDS,
  CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_LIST,
  CORE_AGGREGATE_V2_POST_CUTOVER_EXIT_DATES,
  getCoreAggregatePostCutoverExitSec,
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

    // Frozen v1 membership at base commit 1b79da4cb must never mutate across v2 listing changes.
    expect(CORE_AGGREGATE_V1_MEMBERS_SNAPSHOT.schemaVersion).toBe(1);
    expect(CORE_AGGREGATE_V1_MEMBERS_SNAPSHOT.universe).toBe("core-stablecoins-v1");
    expect(CORE_AGGREGATE_V1_MEMBERS_SNAPSHOT.frozenFromCommit).toBe("1b79da4cb");
    expect(CORE_AGGREGATE_V1_MEMBER_LIST).toHaveLength(260);
    expect(CORE_AGGREGATE_V1_MEMBER_IDS.size).toBe(260);
    expect([...CORE_AGGREGATE_V1_MEMBER_LIST].sort()).toEqual([...CORE_AGGREGATE_V1_MEMBER_LIST]);
    expect(createHash("sha256").update(JSON.stringify(CORE_AGGREGATE_V1_MEMBER_LIST)).digest("hex"))
      .toBe("fe51dd11c6a87dfcc2c106ee758539b3baa65a9f60bda32cd9f946aef819b506");
    expect(CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_LIST).toHaveLength(48);
    expect(CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_IDS.size).toBe(48);
    expect([...CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_LIST].sort()).toEqual([...CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_LIST]);
    expect(createHash("sha256").update(JSON.stringify(CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_LIST)).digest("hex"))
      .toBe("412d63c841e807dc777d387021644b6262883b4f151d1adaaf7614f61ee7aa0f");
    expect(CORE_AGGREGATE_V1_MEMBER_IDS.has("buidl-blackrock")).toBe(true);
    expect(CORE_AGGREGATE_V1_MEMBER_IDS.has("eutbl-spiko")).toBe(true);
    expect(CORE_AGGREGATE_V1_MEMBER_IDS.has("apxusd-apyx")).toBe(false);
    expect(CORE_AGGREGATE_V1_MEMBER_IDS.has("susds-sky")).toBe(false);
    for (const [id, date] of Object.entries(CORE_AGGREGATE_V2_POST_CUTOVER_EXIT_DATES)) {
      expect(CORE_AGGREGATE_V1_MEMBER_IDS.has(id)).toBe(true);
      expect(isCoreAggregateStablecoinId(id)).toBe(false);
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(getCoreAggregatePostCutoverExitSec(id)!).toBeGreaterThan(CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC);
    }
    for (const [id, date] of Object.entries(CORE_AGGREGATE_V1_NON_ACTIVE_EXIT_DATES)) {
      expect(CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_IDS.has(id)).toBe(true);
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Date.parse(`${date}T00:00:00Z`) / 1000).toBeLessThanOrEqual(CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_SEC);
    }
  });

  it("excludes every asset already delisted at the frozen v1 base commit 1b79da4cb", () => {
    const preV2DelistedAtBase = [
      "bd-basedollar",
      "bfusd-binance",
      "jusd-juicedollar",
      "pc0000031-tradable",
      "pc0000033-tradable",
      "pc0000089-tradable",
      "pc0000101-tradable",
      "pht-pht",
      "reur-royal-euro",
      "roughrider-bnd",
      "rusd-royal-dollar",
      "usdb-bridge",
      "vcred-vcred",
      "wusd-worldwide",
    ];
    for (const id of preV2DelistedAtBase) {
      expect(CORE_AGGREGATE_V1_MEMBER_IDS.has(id), `${id} was delisted at 1b79da4cb`).toBe(false);
      expect(CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_IDS.has(id), `${id} was delisted at 1b79da4cb`).toBe(false);
    }
    for (const id of [...CORE_AGGREGATE_V1_MEMBER_LIST, ...CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_LIST]) {
      expect(TRACKED_META_BY_ID.has(id), `${id} missing from tracked catalog`).toBe(true);
    }
    for (const id of CORE_AGGREGATE_V1_MEMBER_LIST) {
      expect(CORE_AGGREGATE_V1_NON_ACTIVE_MEMBER_IDS.has(id)).toBe(false);
    }

    // When the frozen base commit is reachable in local git history, verify dynamically
    // that no frozen v1 active member was delisted ("excluded") at 1b79da4cb.
    let baseDecisionsRaw: string | null = null;
    try {
      baseDecisionsRaw = execFileSync(
        "git",
        ["show", `${CORE_AGGREGATE_V1_MEMBERS_SNAPSHOT.frozenFromCommit}:shared/data/stablecoins/listing-decisions.json`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch {
      baseDecisionsRaw = null;
    }
    if (baseDecisionsRaw != null) {
      const baseDecisions = JSON.parse(baseDecisionsRaw) as { listingClassById: Record<string, string> };
      for (const id of CORE_AGGREGATE_V1_MEMBER_LIST) {
        const cls = baseDecisions.listingClassById[id];
        expect(cls === "core-stablecoin" || cls === "cash-equivalent", `${id} had v1 class ${cls}`).toBe(true);
      }
      for (const [id, cls] of Object.entries(baseDecisions.listingClassById)) {
        if (cls === "excluded") {
          expect(CORE_AGGREGATE_V1_MEMBER_IDS.has(id), `${id} was excluded at 1b79da4cb`).toBe(false);
        }
      }
    }
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

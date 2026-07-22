import { describe, expect, it } from "vitest";
import { fetchAerodromeData, fetchUniV3Data } from "../subgraph-source-families";
import {
  AERODROME_PAIR_PAGE_SIZE,
  UNIV3_POOL_PAGE_SIZE,
  buildAerodromePairQuery,
  buildUniV3PoolQuery,
} from "../constants";

describe("subgraph source families", () => {
  it("returns empty Uni V3 lookups when Graph API key is missing", async () => {
    const result = await fetchUniV3Data(null, new Map(), new Map());

    expect(result.uniV3PoolFees.size).toBe(0);
    expect(result.uniV3SymbolFees.size).toBe(0);
    expect(result.uniV3PriceObs.size).toBe(0);
  });

  it("returns empty Aerodrome lookups when Graph API key is missing", async () => {
    const result = await fetchAerodromeData(null, new Map(), new Map());

    expect(result.aerodromePriceObs.size).toBe(0);
    expect(result.aerodromeIsStable.size).toBe(0);
    expect(result.aerodromeV2ExecutionCandidates.size).toBe(0);
  });

  it("paginates the Uni V3 query by embedding the skip offset and page size", () => {
    expect(buildUniV3PoolQuery(0)).toContain(`first: ${UNIV3_POOL_PAGE_SIZE}`);
    expect(buildUniV3PoolQuery(0)).toContain("skip: 0");
    expect(buildUniV3PoolQuery(2000)).toContain("skip: 2000");
  });

  it("paginates the Aerodrome query by embedding the skip offset and page size", () => {
    expect(buildAerodromePairQuery(0)).toContain(`first: ${AERODROME_PAIR_PAGE_SIZE}`);
    expect(buildAerodromePairQuery(0)).toContain("skip: 0");
    expect(buildAerodromePairQuery(1000)).toContain("skip: 1000");
  });
});

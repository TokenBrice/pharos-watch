import { describe, expect, it } from "vitest";
import { fetchAerodromeData, fetchUniV3Data } from "../subgraph-source-families";

describe("subgraph source families", () => {
  it("returns empty Uni V3 lookups when Graph API key is missing", async () => {
    const result = await fetchUniV3Data(null, new Map(), new Map(), new Map());

    expect(result.uniV3PoolFees.size).toBe(0);
    expect(result.uniV3SymbolFees.size).toBe(0);
    expect(result.uniV3PriceObs.size).toBe(0);
  });

  it("returns empty Aerodrome lookups when Graph API key is missing", async () => {
    const result = await fetchAerodromeData(null, new Map(), new Map(), new Map());

    expect(result.aerodromePriceObs.size).toBe(0);
    expect(result.aerodromeIsStable.size).toBe(0);
  });
});

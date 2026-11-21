import { describe, expect, it } from "vitest";
import {
  buildFxReferenceClosureMarks, derivePoolVolume24hUsd, deriveTokenUsdObservation, getAdmittedDexMarketMark,
  getClosedReferenceDexValuation, getTokenReferenceUsdPrice, isClosureValuationMark,
} from "../dex-api-token-pricing";
import type { DexApiPool, DexApiPoolToken } from "../dex-api-types";

// Empty address + USD reference symbol resolves to a $1 reference price via the
// symbol fallback in getTokenReferenceUsdPrice, so each side's USD estimate is
// just its raw token volume — letting us assert the merge math directly.
function usdToken(symbol: string): DexApiPoolToken {
  return { address: "", symbol, decimals: 6 };
}

function pool(symbols: string[], tokenVolumes24h: number[], volume24hUsd: number): DexApiPool {
  return {
    source: "balancer",
    chain: "ethereum",
    poolAddress: "0xpool",
    poolType: "weighted",
    tokens: symbols.map(usdToken),
    price: 1,
    tvlUsd: 0,
    volume24hUsd,
    feeRate: null,
    balances: null,
    tokenVolumes24h,
  };
}

const NO_REFS = new Map<string, string>();
const NO_SYMBOL_REFS = new Map<string, Map<string, string[]>>();

describe("derivePoolVolume24hUsd", () => {
  it("averages the two per-side USD estimates for a 2-token pool", () => {
    const result = derivePoolVolume24hUsd(
      pool(["USDC", "USDT"], [75000, 25000], 999),
      NO_REFS,
      NO_SYMBOL_REFS,
    );
    expect(result).toBe(50000); // (75000 + 25000) / 2
  });

  it("returns the raw source volume for a 3+ token pool instead of averaging", () => {
    const result = derivePoolVolume24hUsd(
      pool(["USDC", "USDT", "DAI"], [75000, 25000, 50000], 120000),
      NO_REFS,
      NO_SYMBOL_REFS,
    );
    // Averaging 3 independent estimates of the same economic flow is wrong;
    // the raw source value is kept instead.
    expect(result).toBe(120000);
  });

  it("values native volume from a direct USD quote and preserves its observation clock", () => {
    const quoted = pool(["OTHER", "USDC"], [100, 0], 999);
    quoted.tokens[0] = { ...quoted.tokens[0], priceUsd: 1.25 };
    quoted.readStartedAtSec = 1_790_000_000;
    expect(derivePoolVolume24hUsd(quoted, NO_REFS, NO_SYMBOL_REFS)).toBe(125);
    expect(deriveTokenUsdObservation(quoted, 0, "other", NO_REFS, NO_SYMBOL_REFS, undefined, 1_790_000_010))
      .toEqual({ price: 1.25, observedAt: 1_790_000_000 });
  });
});

describe("getTokenReferenceUsdPrice", () => {
  const asUsdf = {
    address: "0x917af46b3c3c6e1bb7286b9f59637fb7c65851fb",
    symbol: "asUSDF",
    decimals: 18,
  };
  const addressRefs = new Map([[`bsc:${asUsdf.address}`, "asusdf-astherus"]]);

  it("fails a tracked NAV token closed when no trusted live price is available", () => {
    expect(getTokenReferenceUsdPrice(asUsdf, "bsc", addressRefs, NO_SYMBOL_REFS)).toBeNull();
  });

  it("uses a trusted live NAV price when one is available", () => {
    expect(
      getTokenReferenceUsdPrice(
        asUsdf,
        "bsc",
        addressRefs,
        NO_SYMBOL_REFS,
        undefined,
        new Map([["asusdf-astherus", 1.061756]]),
      ),
    ).toBe(1.061756);
  });
});

describe("buildFxReferenceClosureMarks", () => {
  it("keeps an untracked-price leg's open-session FX basis only during a closure and while the reference is fresh", () => {
    const at = Date.parse("2026-11-21T09:00:00Z") / 1000;
    const fixing = Date.parse("2026-11-20T13:10:00Z") / 1000;
    const refs = { rates: { peggedEUR: 1.09 }, type: "fresh" as const, updatedAt: fixing, updatedAtByPeg: { peggedEUR: fixing },
      typeByPeg: { peggedEUR: "fresh" as const }, sourceModeByPeg: { peggedEUR: "live" as const },
      sourceCadenceByPeg: { peggedEUR: "business-daily" as const }, sourceDateByPeg: { peggedEUR: "2026-11-20" } };
    const id = "eurcv-societe-generale-forge";
    const marks = buildFxReferenceClosureMarks(new Map(), refs, at, [id, "usdc-circle"]);
    expect([...marks.keys()]).toEqual([id]);
    const prices = Object.assign(new Map<string, number>(), { marketMarks: marks });
    expect(getClosedReferenceDexValuation(prices, id, at)?.mark).toMatchObject({ priceUsd: 1.09, source: "fx-reference:peggedEUR" });
    expect(getAdmittedDexMarketMark(prices, id, at)).toBeNull();
    expect(buildFxReferenceClosureMarks(new Map([[id, 1.09]]), refs, at, [id]).size).toBe(0);
    expect(buildFxReferenceClosureMarks(new Map(), refs, Date.parse("2026-11-20T15:00:00Z") / 1000, [id]).size).toBe(0);
    expect(isClosureValuationMark(marks.get(id), at, fixing + 7 * 86_400)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { derivePegRates, getPegReference } from "@shared/lib/peg-rates";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import type { PegAssetBase } from "@shared/types/price";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";

function asset(
  id: string,
  pegType: string,
  price: number,
  circulatingUsd: number,
): PegAssetBase {
  return {
    id,
    symbol: id.toUpperCase(),
    pegType,
    price,
    circulating: {
      peggedUSD: circulatingUsd,
    },
  };
}

describe("derivePegRates", () => {
  it("excludes nominal references from observed peer counts and medians", () => {
    const result = derivePegRates([
      { ...asset("nominal", "peggedEUR", 1, 2_000_000), priceObservedAtMode: "nominal_reference" },
      { ...asset("nominal-source", "peggedEUR", 1, 2_000_000), priceSource: "protocol-par+coingecko", priceObservedAt: 123_456 },
      { ...asset("unsupported", "peggedEUR", 1.3, 2_000_000), priceSource: "coingecko", priceObservedAtMode: "unsupported" },
      asset("market", "peggedEUR", 1.2, 2_000_000),
    ]);
    expect(result.rates.peggedEUR).toBe(1.2);
    expect(result.counts.peggedEUR).toBe(1);
    expect(result.contributors?.peggedEUR?.map(({ assetId }) => assetId)).toEqual(["market"]);
  });

  it("rejects invalid fallback rates consistently with and without fiat peers", () => {
    for (const rate of [-1, Infinity]) {
      const populated = derivePegRates([asset("eur", "peggedEUR", 1.2, 2_000_000)], undefined, { peggedEUR: rate });
      expect(populated.rates.peggedEUR).toBe(1.2);
      expect(populated.sources.peggedEUR).toBe("median");
      const empty = derivePegRates([], undefined, { peggedEUR: rate });
      expect(empty.rates.peggedEUR).toBeUndefined();
      expect(empty.sources.peggedEUR).toBeUndefined();
    }
  });

  it("excludes infinite candidate prices without discarding valid peers", () => {
    const result = derivePegRates([
      asset("invalid", "peggedEUR", Infinity, 2_000_000),
      asset("valid", "peggedEUR", 1.2, 2_000_000),
    ]);
    expect(result.rates.peggedEUR).toBe(1.2);
    expect(result.counts.peggedEUR).toBe(1);
  });

  it("includes exactly one million across circulating buckets but excludes one dollar less", () => {
    const atBoundary = { ...asset("exact", "peggedEUR", 1.2, 0), circulating: { peggedUSD: 600_000, peggedEUR: 400_000 } };
    const belowBoundary = { ...asset("below", "peggedEUR", 9, 0), circulating: { peggedUSD: 600_000, peggedEUR: 399_999 } };
    const result = derivePegRates([atBoundary, belowBoundary]);
    expect(result.rates.peggedEUR).toBe(1.2);
    expect(result.counts.peggedEUR).toBe(1);
  });

  it.each(["peggedGOLD", "peggedSILVER"])("uses local %s peers at quorum and falls back to spot below quorum", (peg) => {
    const now = Date.parse("2026-11-18T15:00:00Z") / 1000;
    const peers = [2000, 2200, 2400].map((price, i) => ({
      ...asset(`metal-${i}`, peg, price, 2_000_000), priceSource: "coingecko",
      priceObservedAtMode: "upstream" as const, priceObservedAt: now - 60,
    }));
    const spot = { pegKey: peg, source: "gold-api.com", cadence: "intraday", usdPerUnit: 3000, observedAtSec: now - 100 };
    for (const evidence of [undefined, { [peg]: spot }]) {
      const thin = derivePegRates(peers.slice(0, 2), undefined, { [peg]: 3000 }, evidence, now);
      expect([thin.rates[peg], thin.sources[peg], thin.counts[peg], thin.observations?.[peg]]).toEqual([3000, "fallback", 2, evidence?.[peg]]);
      const broad = derivePegRates(peers, undefined, { [peg]: 3000 }, evidence, now);
      expect([broad.rates[peg], broad.sources[peg], broad.counts[peg]]).toEqual([2200, "median", 3]);
      expect(broad.observations?.[peg]).toBeUndefined();
      expect(broad.contributors?.[peg]?.map(({ assetId }) => assetId)).toEqual(peers.map(({ id }) => id));
    }
  });

  it("retains the FX producer’s selected median cohort when list peers lack observation clocks", () => {
    const now = Date.parse("2026-11-18T15:00:00Z") / 1000;
    const peers = [2000, 2200, 2400].map((price, i) => asset(`gold-${i}`, "peggedGOLD", price, 2_000_000));
    const contributors = ["a", "b", "c"].map((assetId, i) => ({
      assetId, observedAtSec: now - 100 + i, provenanceKey: `market:${assetId}`, derivation: "traded-market",
    }));
    const selected = { pegKey: "peggedGOLD", source: "peer-median", cadence: "intraday", usdPerUnit: 2300, observedAtSec: now - 100, contributors };
    const rates = derivePegRates(peers, undefined, { peggedGOLD: 2300 }, { peggedGOLD: selected }, now);
    expect(rates.rates.peggedGOLD).toBe(2300);
    expect(rates.contributors?.peggedGOLD).toEqual(contributors);
    const listSelection = derivePegRates(peers);
    expect(listSelection.contributors?.peggedGOLD?.map((row) => row.assetId)).toEqual(["gold-0", "gold-1", "gold-2"]);
  });

  it("uses only eligible upstream bullion quotes during a closure, falling back to the close below quorum", () => {
    const now = Date.parse("2026-11-21T12:00:00Z") / 1000;
    const friday = Date.parse("2026-11-20T21:50:00Z") / 1000;
    const spot = { pegKey: "peggedGOLD", usdPerUnit: 4100, source: "gold-api.com", cadence: "intraday", observedAtSec: friday };
    const peers = [2870, 4099, 4101].map((price, i) => ({
      ...asset(`metal-${i}`, "peggedGOLD", price, 2_000_000), priceSource: "coingecko",
      priceObservedAtMode: "upstream" as const, priceObservedAt: now - 120 - i,
    }));
    const ineligible = [
      { ...peers[0], id: "local", price: 9000, priceObservedAtMode: "local_fetch" as const },
      { ...peers[0], id: "prior-session", price: 9000, priceObservedAt: friday },
      { ...peers[0], id: "future", price: 9000, priceObservedAt: now + 1 },
    ];
    const select = (fresh: typeof peers) => derivePegRates([...fresh, ...ineligible], undefined,
      { peggedGOLD: spot.usdPerUnit }, { peggedGOLD: spot }, now);
    const broad = select([...peers, peers[0], { ...peers[0], id: "conflicting" }, { ...peers[1], id: "conflicting" }]);
    expect([broad.rates.peggedGOLD, broad.counts.peggedGOLD]).toEqual([4099, 3]);
    expect(broad.contributors?.peggedGOLD?.map(({ assetId, observedAtSec }) => [assetId, observedAtSec]))
      .toEqual(peers.map(({ id, priceObservedAt }) => [id, priceObservedAt]));
    const thin = select([peers[0], peers[0], peers[1]]);
    expect([thin.rates.peggedGOLD, thin.sources.peggedGOLD, thin.observations?.peggedGOLD]).toEqual([4100, "fallback", spot]);
    expect(thin.contributors?.peggedGOLD).toBeUndefined();
    expect(derivePegRates(peers.slice(0, 2), undefined, undefined, {}, now).rates.peggedGOLD).toBeUndefined();
    expect(derivePegRates([...peers, ...ineligible], undefined, { peggedGOLD: 4100 }).rates.peggedGOLD).toBe(6550.5);
  });

  it("selects the newer bullion quorum by its oldest original observation and keeps that quorum's receipts", () => {
    const now = Date.parse("2026-11-18T15:00:00Z") / 1000;
    const producerAt = now - 35 * 60;
    const contributors = ["a", "b", "c"].map((assetId, i) => ({
      assetId, observedAtSec: producerAt + i, provenanceKey: "market:coingecko", derivation: "traded-market",
    }));
    const producer = { pegKey: "peggedGOLD", source: "peer-median", cadence: "intraday", usdPerUnit: 4100,
      observedAtSec: producerAt, publishedAtSec: now - 30, contributors };
    for (const oldest of [now - 120, producerAt, producerAt - 1]) {
      const peers = [4160, 4165.60, 4170].map((price, i) => ({
        ...asset(`metal-${i}`, "peggedGOLD", price, 2_000_000), priceSource: "coingecko",
        priceObservedAt: i === 0 ? oldest : now - 60, priceObservedAtMode: "upstream" as const,
      }));
      const result = derivePegRates(peers, undefined, { peggedGOLD: 4100 }, { peggedGOLD: producer }, now);
      if (oldest > producerAt) {
        expect(result.rates.peggedGOLD).toBe(4165.60);
        expect(result.observations?.peggedGOLD).toBeUndefined();
        expect(result.contributors?.peggedGOLD?.map(({ assetId, observedAtSec }) => [assetId, observedAtSec]))
          .toEqual(peers.map(({ id, priceObservedAt }) => [id, priceObservedAt]));
      } else {
        expect(result.rates.peggedGOLD).toBe(4100);
        expect(result.observations?.peggedGOLD).toEqual(producer);
        expect(result.contributors?.peggedGOLD).toEqual(contributors);
      }
    }
  });

  it("replaces the gold producer with the median and receipts of three strictly newer assets", () => {
    const now = Date.parse("2026-11-18T15:00:00Z") / 1000;
    const observedAtSec = now - 2100;
    const peers = [4100, 4150, 4160, 4180].map((price, i) => ({
      ...asset(`metal-${i}`, "peggedGOLD", price, 2_000_000), priceSource: "coingecko",
      priceObservedAt: i === 0 ? observedAtSec : now - 120, priceObservedAtMode: "upstream" as const,
    }));
    const producer = { pegKey: "peggedGOLD", source: "peer-median", cadence: "intraday", usdPerUnit: 4100, observedAtSec,
      contributors: peers.map(({ id }) => ({ assetId: id, observedAtSec, provenanceKey: "coingecko", derivation: "traded-market" })) };
    const result = derivePegRates(peers, undefined, { peggedGOLD: 4100 }, { peggedGOLD: producer }, now);
    expect([result.rates.peggedGOLD, result.counts.peggedGOLD]).toEqual([4160, 3]);
    expect(result.contributors?.peggedGOLD?.map(({ assetId, observedAtSec }) => [assetId, observedAtSec]))
      .toEqual(peers.slice(1).map(({ id, priceObservedAt }) => [id, priceObservedAt]));
    expect(result.observations?.peggedGOLD).toBeUndefined();
  });

  it("excludes an unresolved OTHER unit from its own reference on both sides of cutover", () => {
    const row = asset("sekau-allunity", "peggedOTHER", 0.106, 2_000_000);
    const meta = new Map([[row.id, { flags: { pegCurrency: "OTHER" as const, navToken: false } }]]);
    for (const evidence of [undefined, {}]) {
      const result = derivePegRates([row], meta, undefined, evidence);
      expect(result.rates.peggedOTHER).toBeUndefined();
      expect(result.contributors?.peggedOTHER).toBeUndefined();
    }
  });

  it("normalizes the XAGm peer only with an as-of entitlement for its quote date", () => {
    const now = 2 * 86400 + 100;
    const ozPerToken = 0.998380822;
    const quote = { ...asset("xagm-matrixdock", "peggedSILVER", 30 * ozPerToken, 2_000_000), priceObservedAt: now };
    const receipt = { ozPerToken, source: "matrixdock-frs" as const, generation: "ethereum:123", quoteObservedAtSec: now };
    const selected = derivePegRates([{ ...quote, commodityEntitlement: { ...receipt, observedAtSec: now - 1 } }]);
    expect(selected.rates.peggedSILVER).toBeCloseTo(30, 12);
    expect(selected.contributors?.peggedSILVER).toMatchObject([{ assetId: quote.id, observedAtSec: now }]);
    for (const observedAtSec of [now + 1, now - 101]) {
      expect(derivePegRates([{ ...quote, commodityEntitlement: { ...receipt, observedAtSec } }]).rates.peggedSILVER).toBeUndefined();
    }
    expect(derivePegRates([quote]).rates.peggedSILVER).toBeUndefined();
  });

  it("excludes < $1m supply assets when computing medians", () => {
    const result = derivePegRates([
      asset("thin-a", "peggedEUR", 0.98, 500_000),
      asset("thin-b", "peggedEUR", 1.02, 250_000),
    ]);

    expect(result.rates.peggedEUR).toBeUndefined();
    expect(result.sources.peggedEUR).toBeUndefined();
  });

  it("keeps canonical GBP NAV shares out of the median and its quorum", () => {
    const result = derivePegRates([
      asset("tgbp-tokenised", "peggedGBP", 1.336244, 2_000_000),
      asset("gbpsafo-spiko", "peggedGBP", 1.365366, 2_000_000),
      asset("uktbl-spiko", "peggedGBP", 1.368567, 2_000_000),
    ], WORKER_TRACKED_META_BY_ID);

    expect(result.rates.peggedGBP).toBe(1.336244);
    expect(result.counts.peggedGBP).toBe(1);
    expect(result.contributors?.peggedGBP).toHaveLength(1);
  });

  it("does not add a rate for an empty peg group", () => {
    const result = derivePegRates([], new Map(), {});

    expect(result.rates.peggedUSD).toBe(1);
    expect(result.rates.peggedEUR).toBeUndefined();
    expect(result.sources.peggedEUR).toBeUndefined();
  });

  it("uses authoritative FX rates for empty fiat peg groups", () => {
    const result = derivePegRates([], new Map(), { peggedTRY: 0.022417 });

    expect(result.rates.peggedTRY).toBe(0.022417);
    expect(result.sources.peggedTRY).toBe("fx");
    expect(result.counts.peggedTRY).toBe(0);
  });

  it("normalizes gold to per-ounce before median derivation", () => {
    const gramOz = 1 / 31.1034768;
    const metalMeta = new Map<string, StablecoinMeta>([
      [
        "gold-token",
        {
          id: "gold-token",
          name: "Gold Token",
          symbol: "GOLD",
          flags: {
            backing: "crypto-backed",
            pegCurrency: "GOLD",
            governance: "centralized",
            yieldBearing: false,
            rwa: true,
            navToken: false,
          },
          commodityOunces: gramOz,
        } as StablecoinMeta,
      ],
    ]);

    const result = derivePegRates(
      [asset("gold-token", "peggedGOLD", 1600, 2_000_000)],
      metalMeta,
    );

    expect(result.rates.peggedGOLD).toBeCloseTo(1600 / gramOz, 6);
  });

  it("excludes DGLD from the gold peer median", () => {
    const result = derivePegRates(
      [
        asset("xaut-tether-gold", "peggedGOLD", 2000, 2_000_000),
        asset("paxg-pax-gold", "peggedGOLD", 2200, 2_000_000),
        asset("dgld-gold-token-sa", "peggedGOLD", 10_000, 2_000_000),
      ],
      new Map(),
    );

    expect(result.rates.peggedGOLD).toBe(2100);
    expect(result.counts.peggedGOLD).toBe(2);
  });

  it("prefers an authoritative fiat FX rate over a broad peer median", () => {
    const result = derivePegRates(
      [
        asset("brl-a", "peggedREAL", 0.1950, 2_000_000),
        asset("brl-b", "peggedREAL", 0.1953, 3_000_000),
        asset("brl-c", "peggedREAL", 0.1928, 4_000_000),
        asset("brl-d", "peggedREAL", 0.1932, 5_000_000),
      ],
      undefined,
      { peggedREAL: 0.19504 },
    );

    expect(result.rates.peggedREAL).toBe(0.19504);
    expect(result.sources.peggedREAL).toBe("fx");
    expect(result.counts.peggedREAL).toBe(4);
  });

  it("keeps BRL alias maps compatible with raw peggedBRL consumers", () => {
    const result = derivePegRates([asset("brl-token", "peggedBRL", 0.18, 2_000_000)]);

    expect(result.rates.peggedREAL).toBe(0.18);
    expect(result.rates.peggedBRL).toBe(0.18);
    expect(result.sources.peggedBRL).toBe("median");
    expect(result.counts.peggedBRL).toBe(1);
  });

  it("normalizes fallback rates before aliasing", () => {
    const result = derivePegRates([], new Map(), { peggedBRL: 0.2 });

    expect(result.rates.peggedREAL).toBe(0.2);
    expect(result.rates.peggedBRL).toBe(0.2);
    expect(result.sources.peggedBRL).toBe("fx");
    expect(result.counts.peggedBRL).toBe(0);
  });
});

describe("normalizePegType", () => {
  it("handles peg types that match inherited object property names", () => {
    const result = derivePegRates([
      asset("constructor-token", "constructor", 1.23, 2_000_000),
      asset("proto-token", "__proto__", 1.25, 2_000_000),
      asset("tostring-token", "toString", 1.27, 2_000_000),
    ]);

    expect(result.rates["constructor"]).toBe(1.23);
    expect(result.rates["__proto__"]).toBe(1.25);
    expect(result.rates["toString"]).toBe(1.27);
    expect(result.sources["constructor"]).toBe("median");
    expect(result.counts["__proto__"]).toBe(1);
  });
});

describe("getPegReference", () => {
  it("rejects nonpositive and nonfinite references while accepting a positive rate", () => {
    for (const rate of [0, -1, NaN, Infinity]) {
      expect(getPegReference("peggedEUR", { peggedEUR: rate })).toBeNull();
    }
    expect(getPegReference("peggedEUR", { peggedEUR: 1.2 })).toBe(1.2);
  });

  it.each([
    ["peggedGOLD", 5000, 0.5, 2500],
    ["peggedSILVER", 100, 2, 200],
    ["peggedSILVER", 30, 0.998380822, 29.95142466],
  ])("scales %s at %s USD per ounce by the %s-ounce entitlement", (peg, usdPerOunce, ounces, par) => {
    expect(getPegReference(peg, { [peg]: usdPerOunce }, ounces)).toBeCloseTo(par, 10);
  });

  it("returns null for unknown peg types when no rate is available", () => {
    expect(getPegReference("peggedDOGE", {})).toBeNull();
    expect(getPegReference("peggedGOLD", {})).toBeNull();
    expect(getPegReference(undefined, {})).toBeNull();
  });

  it("keeps the USD reference at 1 without a derived rate", () => {
    expect(getPegReference("peggedUSD", {})).toBe(1);
  });

  it("uses the canonical BRL peg rate for legacy peggedBRL references", () => {
    expect(getPegReference("peggedBRL", { peggedREAL: 0.2 })).toBe(0.2);
  });
});

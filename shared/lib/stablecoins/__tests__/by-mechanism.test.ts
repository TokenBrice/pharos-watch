import { describe, expect, it } from "vitest";
import type { MechanismArchetype, StablecoinMeta } from "../../../types";
import {
  countActiveByArchetype,
  getActiveByArchetype,
  getCoinsByLifecycleStatus,
  nestVariants,
} from "../by-mechanism";
import { MECHANISM_ARCHETYPE_VALUES } from "../../../types/core";
import { makeCatalogCoin, NON_RWA_STABLECOIN_FLAGS } from "./test-support";

describe("countActiveByArchetype", () => {
  it("returns a count for every mechanism archetype", () => {
    const counts = countActiveByArchetype();
    for (const archetype of MECHANISM_ARCHETYPE_VALUES) {
      expect(typeof counts[archetype]).toBe("number");
      expect(counts[archetype]).toBeGreaterThanOrEqual(0);
    }
  });

  it("excludes commodity-peg coins (GOLD/SILVER) even when they declare an archetype", () => {
    // Fixture: a commodity coin with a non-null archetype. Real GOLD/SILVER
    // coins currently have null archetype, so injecting one proves the filter
    // — not the resolver — is what excludes it.
    const goldCoin = makeCatalogCoin({
      id: "gold-fixture",
      name: "Gold Fixture",
      symbol: "GOLD-FX",
      flags: {
        ...NON_RWA_STABLECOIN_FLAGS,
        pegCurrency: "GOLD",
        rwa: true,
      },
      mechanismArchetype: "fiat-cash",
    });
    const silverCoin = makeCatalogCoin({
      id: "silver-fixture",
      name: "Silver Fixture",
      symbol: "SILVER-FX",
      flags: {
        ...NON_RWA_STABLECOIN_FLAGS,
        pegCurrency: "SILVER",
        rwa: true,
      },
      mechanismArchetype: "rwa-credit-fund",
    });
    const usdCoin = makeCatalogCoin({
      id: "usd-fixture",
      name: "USD Fixture",
      symbol: "USD-FX",
      flags: NON_RWA_STABLECOIN_FLAGS,
      mechanismArchetype: "fiat-cash",
    });

    const fixtures = [goldCoin, silverCoin, usdCoin];
    const registry = new Map(fixtures.map((c) => [c.id, c]));
    const counts = countActiveByArchetype(fixtures, registry);

    // Only the USD coin should be counted.
    expect(counts["fiat-cash"]).toBe(1);
    expect(counts["rwa-credit-fund"]).toBe(0);

    // Sanity: the same fixtures with the commodity filter removed would
    // yield fiat-cash=2 + rwa-credit-fund=1. We can't disable the filter
    // from outside, but we can verify the commodity IDs don't appear in
    // any archetype bucket via getActiveByArchetype.
    const fiatCoins = getActiveByArchetype("fiat-cash", undefined, fixtures, registry);
    const rwaCoins = getActiveByArchetype("rwa-credit-fund", undefined, fixtures, registry);
    expect(fiatCoins.map((c) => c.id)).toEqual(["usd-fixture"]);
    expect(rwaCoins.map((c) => c.id)).toEqual([]);
  });

  it("real GOLD/SILVER coins do not contribute to any archetype bucket", () => {
    // Live-data invariant: regardless of resolver outcome, no commodity-peg
    // coin id should appear in any archetype bucket returned by getActiveByArchetype.
    const archetypes: MechanismArchetype[] = [...MECHANISM_ARCHETYPE_VALUES];
    for (const archetype of archetypes) {
      const coins = getActiveByArchetype(archetype);
      for (const coin of coins) {
        expect(coin.flags.pegCurrency).not.toBe("GOLD");
        expect(coin.flags.pegCurrency).not.toBe("SILVER");
      }
    }
  });

  it("rwa-credit-fund bucket is populated after T8 migration", () => {
    const counts = countActiveByArchetype();
    expect(counts["rwa-credit-fund"]).toBeGreaterThan(0);
  });

  it("fiat-cash bucket is populated", () => {
    const counts = countActiveByArchetype();
    expect(counts["fiat-cash"]).toBeGreaterThan(0);
  });
});

describe("getActiveByArchetype", () => {
  it("returns coins for fiat-cash archetype", () => {
    const coins = getActiveByArchetype("fiat-cash");
    expect(coins.length).toBeGreaterThan(0);
    for (const coin of coins) {
      expect(coin.flags.pegCurrency).not.toBe("GOLD");
      expect(coin.flags.pegCurrency).not.toBe("SILVER");
    }
  });

  it("sorts by supply descending when supply map is provided", () => {
    const coins = getActiveByArchetype("fiat-cash");
    if (coins.length < 2) return;

    const supplyById = new Map<string, number>();
    coins.forEach((c, i) => supplyById.set(c.id, (coins.length - i) * 1000));

    const sorted = getActiveByArchetype("fiat-cash", supplyById);
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = supplyById.get(sorted[i].id) ?? 0;
      const b = supplyById.get(sorted[i + 1].id) ?? 0;
      expect(a).toBeGreaterThanOrEqual(b);
    }
  });

  it("returns rwa-credit-fund coins after T8 migration", () => {
    const coins = getActiveByArchetype("rwa-credit-fund");
    expect(coins.length).toBeGreaterThan(0);
  });
});

describe("getCoinsByLifecycleStatus", () => {
  function makeLifecycleCoin(
    id: string,
    mechanismArchetype: MechanismArchetype,
    variantOf?: string,
  ): StablecoinMeta {
    return makeCatalogCoin({
      id,
      flags: NON_RWA_STABLECOIN_FLAGS,
      mechanismArchetype,
      ...(variantOf
        ? { variantOf, variantKind: "savings-passthrough" as const }
        : {}),
    });
  }

  it("returns active coins for fiat-cash archetype", () => {
    const coins = getCoinsByLifecycleStatus("fiat-cash", "active");
    expect(coins.length).toBeGreaterThan(0);
  });

  it("returns frozen coins only for an explicit frozen status", () => {
    const frozenCoins = getCoinsByLifecycleStatus("fiat-cash", "frozen");
    const invalidCoins = getCoinsByLifecycleStatus(
      "fiat-cash",
      "dead" as "active" | "pre-launch" | "frozen",
    );

    expect(frozenCoins.length).toBeGreaterThan(0);
    expect(invalidCoins).toEqual([]);
  });

  it("resolves variants against the full tracked registry across lifecycle buckets", () => {
    const activeParent = makeLifecycleCoin("active-parent", "fiat-cash");
    const preLaunchChild = makeLifecycleCoin(
      "pre-launch-child",
      "algorithmic",
      "active-parent",
    );
    const registry = new Map([
      [activeParent.id, activeParent],
      [preLaunchChild.id, preLaunchChild],
    ]);

    expect(
      getCoinsByLifecycleStatus("fiat-cash", "pre-launch", {
        registry,
        pools: { "pre-launch": [preLaunchChild] },
      }).map((coin) => coin.id),
    ).toEqual(["pre-launch-child"]);
    expect(
      getCoinsByLifecycleStatus("algorithmic", "pre-launch", {
        registry,
        pools: { "pre-launch": [preLaunchChild] },
      }),
    ).toEqual([]);
  });
});

describe("nestVariants", () => {
  function makeCoin(id: string, variantOf?: string): StablecoinMeta {
    return makeCatalogCoin({
      id,
      flags: NON_RWA_STABLECOIN_FLAGS,
      ...(variantOf ? { variantOf, variantKind: "savings-passthrough" as const } : {}),
    });
  }

  it("separates top-level parents from children", () => {
    const parent = makeCoin("parent-a");
    const child = makeCoin("child-a", "parent-a");
    const orphan = makeCoin("parent-b");

    const { parents, childrenByParentId } = nestVariants([parent, child, orphan]);

    expect(parents.map((c) => c.id)).toEqual(["parent-a", "parent-b"]);
    expect(childrenByParentId["parent-a"]?.map((c) => c.id)).toEqual(["child-a"]);
    expect(childrenByParentId["parent-b"]).toBeUndefined();
  });

  it("treats a variant whose parent is not in the list as a parent", () => {
    const child = makeCoin("child-a", "missing-parent");
    const { parents, childrenByParentId } = nestVariants([child]);

    expect(parents.map((c) => c.id)).toEqual(["child-a"]);
    expect(Object.keys(childrenByParentId)).toHaveLength(0);
  });
});

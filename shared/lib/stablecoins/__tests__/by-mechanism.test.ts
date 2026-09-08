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
    const counts = countActiveByArchetype([], new Map());
    for (const archetype of MECHANISM_ARCHETYPE_VALUES) {
      expect(counts[archetype]).toBe(0);
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

});

describe("getActiveByArchetype", () => {
  it("sorts unsorted supplies with missing supply last without mutating the input", () => {
    const coins = ["missing", "small", "large"].map((id) =>
      makeCatalogCoin({ id, flags: NON_RWA_STABLECOIN_FLAGS, mechanismArchetype: "fiat-cash" }),
    );
    const registry = new Map(coins.map((coin) => [coin.id, coin]));
    const supplyById = new Map([["small", 10], ["large", 100]]);
    expect(getActiveByArchetype("fiat-cash", supplyById, coins, registry).map((coin) => coin.id))
      .toEqual(["large", "small", "missing"]);
    expect(coins.map((coin) => coin.id)).toEqual(["missing", "small", "large"]);
    expect(getActiveByArchetype("fiat-cash", undefined, coins, registry).map((coin) => coin.id))
      .toEqual(["missing", "small", "large"]);
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

  it("selects each lifecycle pool independently and filters archetypes and commodities", () => {
    const statuses = ["active", "pre-launch", "frozen", "quarantined", "delisted"] as const;
    const pools = Object.fromEntries(statuses.map((status) => [
      status, [makeLifecycleCoin(status, "fiat-cash")],
    ]));
    pools.quarantined.push(
      makeLifecycleCoin("wrong-archetype", "algorithmic"),
      makeCatalogCoin({
        id: "commodity", mechanismArchetype: "fiat-cash",
        flags: { ...NON_RWA_STABLECOIN_FLAGS, pegCurrency: "GOLD", rwa: true },
      }),
    );
    const registry = new Map(Object.values(pools).flat().map((coin) => [coin.id, coin]));
    for (const status of statuses) {
      expect(getCoinsByLifecycleStatus("fiat-cash", status, { pools, registry }).map((coin) => coin.id))
        .toEqual([status]);
    }
    expect(getCoinsByLifecycleStatus("fiat-cash", "dead" as "active", { pools, registry })).toEqual([]);
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

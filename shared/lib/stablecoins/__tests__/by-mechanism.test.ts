import { describe, expect, it } from "vitest";
import type { MechanismArchetype, StablecoinMeta } from "../../../types";
import {
  countActiveByArchetype,
  getActiveByArchetype,
  getCoinsByLifecycleStatus,
} from "../by-mechanism";
import { MECHANISM_ARCHETYPE_VALUES } from "../../../types/core";
import { ACTIVE_META_BY_ID, ACTIVE_STABLECOINS, FROZEN_STABLECOINS, PRE_LAUNCH_STABLECOINS, TRACKED_META_BY_ID } from "../registry";
import { resolveMechanismArchetype } from "../../classification/resolve-mechanism-archetype";
import { makeCatalogCoin, NON_RWA_STABLECOIN_FLAGS } from "./test-support";

describe("countActiveByArchetype", () => {
  it("admits explicitly classified commodity pegs but not inherited family membership", () => {
    const goldCoin = makeCatalogCoin({
      id: "gold-fixture",
      name: "Gold Fixture",
      symbol: "GOLD-FX",
      flags: {
        ...NON_RWA_STABLECOIN_FLAGS,
        pegCurrency: "GOLD",
        rwa: true,
      },
      mechanismArchetype: "rwa-credit-fund",
    });
    const usdParent = makeCatalogCoin({
      id: "usd-parent",
      name: "USD Parent",
      symbol: "USD-P",
      flags: NON_RWA_STABLECOIN_FLAGS,
      mechanismArchetype: "fiat-cash",
    });
    const inheritedSilver = makeCatalogCoin({
      id: "silver-fixture",
      name: "Silver Fixture",
      symbol: "SILVER-FX",
      flags: {
        ...NON_RWA_STABLECOIN_FLAGS,
        pegCurrency: "SILVER",
        rwa: true,
      },
      variantOf: "usd-parent",
    });

    const fixtures = [goldCoin, usdParent, inheritedSilver];
    const registry = new Map(fixtures.map((c) => [c.id, c]));
    const counts = countActiveByArchetype(fixtures, registry);

    expect(counts["rwa-credit-fund"]).toBe(1);
    expect(counts["fiat-cash"]).toBe(1);
    expect(counts["commodity-claim"]).toBe(0);

    const fiatCoins = getActiveByArchetype("fiat-cash", undefined, fixtures, registry);
    expect(fiatCoins.map((c) => c.id)).toEqual(["usd-parent"]);
    const rwaCoins = getActiveByArchetype("rwa-credit-fund", undefined, fixtures, registry);
    expect(rwaCoins.map((c) => c.id)).toEqual(["gold-fixture"]);
  });

  it("counts every active coin that resolves to an archetype", () => {
    const classified = ACTIVE_STABLECOINS.filter(
      (coin) => resolveMechanismArchetype(coin, ACTIVE_META_BY_ID) !== null,
    );
    const counted = MECHANISM_ARCHETYPE_VALUES.reduce(
      (total, archetype) => total + countActiveByArchetype()[archetype],
      0,
    );

    expect(counted).toBe(classified.length);
  });

  it("includes the live commodity-claim family and only explicit commodity classifications elsewhere", () => {
    const commodityClaims = getActiveByArchetype("commodity-claim");
    expect(commodityClaims.map((coin) => coin.id)).toEqual(expect.arrayContaining(["xaut-tether", "paxg-paxos", "kag-kinesis"]));
    expect(countActiveByArchetype()["commodity-claim"]).toBe(commodityClaims.length);
    expect(getActiveByArchetype("rwa-credit-fund").map((coin) => coin.id)).toContain("gldy-streamex");
    for (const archetype of MECHANISM_ARCHETYPE_VALUES) {
      if (archetype === "commodity-claim") continue;
      for (const coin of getActiveByArchetype(archetype)) {
        if (coin.flags.pegCurrency !== "GOLD" && coin.flags.pegCurrency !== "SILVER") continue;
        expect(coin.mechanismArchetype, `${coin.id} in ${archetype}`).toBe(archetype);
      }
    }
  });

});

describe("getCoinsByLifecycleStatus", () => {
  it.each(["active", "pre-launch", "frozen", "quarantined", "delisted"] as const)(
    "includes explicitly classified commodity claims in the %s pool", (status) => {
      const coin = makeCatalogCoin({
        id: "gold-claim", mechanismArchetype: "commodity-claim",
        flags: { ...NON_RWA_STABLECOIN_FLAGS, pegCurrency: "GOLD", rwa: true },
      });
      const registry = new Map([[coin.id, coin]]);
      expect(getCoinsByLifecycleStatus("commodity-claim", status, { pools: { [status]: [coin] }, registry }))
        .toEqual([coin]);
      expect(countActiveByArchetype([coin], registry)["commodity-claim"]).toBe(1);
    },
  );

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
        id: "commodity", variantOf: "quarantined", variantKind: "savings-passthrough",
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

  it("matches the screener's resolved universe across lifecycles", () => {
    const pools = {
      active: ACTIVE_STABLECOINS,
      "pre-launch": PRE_LAUNCH_STABLECOINS,
      frozen: FROZEN_STABLECOINS,
    } as const;
    for (const [status, pool] of Object.entries(pools) as Array<
      [keyof typeof pools, readonly StablecoinMeta[]]
    >) {
      for (const archetype of MECHANISM_ARCHETYPE_VALUES) {
        expect(
          getCoinsByLifecycleStatus(archetype, status).map((coin) => coin.id),
          `${status}/${archetype}`,
        ).toEqual(
          pool
            .filter((coin) => resolveMechanismArchetype(coin, TRACKED_META_BY_ID) === archetype)
            .map((coin) => coin.id),
        );
      }
    }
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


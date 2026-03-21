import { describe, expect, it } from "vitest";
import { resolveCapacityConfidence, resolveFeeConfidence } from "@shared/lib/redemption-backstop-confidence";
import { COLLATERAL_REDEEM_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstop-configs/collateral-redeem";
import { OFFCHAIN_ISSUER_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstop-configs/offchain-issuer";
import { PSM_AND_BASKET_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstop-configs/psm-and-basket";
import { QUEUE_REDEEM_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstop-configs/queue-redeem";
import { STABLECOIN_REDEEM_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstop-configs/stablecoin-redeem";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { REDEMPTION_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstops";

const entries = Object.entries(REDEMPTION_BACKSTOP_CONFIGS);
const familyModules = [
  {
    name: "offchain-issuer",
    configs: OFFCHAIN_ISSUER_BACKSTOP_CONFIGS,
    allowedRouteFamilies: new Set(["offchain-issuer"]),
  },
  {
    name: "psm-and-basket",
    configs: PSM_AND_BASKET_BACKSTOP_CONFIGS,
    allowedRouteFamilies: new Set(["basket-redeem", "psm-swap"]),
  },
  {
    name: "collateral-redeem",
    configs: COLLATERAL_REDEEM_BACKSTOP_CONFIGS,
    allowedRouteFamilies: new Set(["collateral-redeem"]),
  },
  {
    name: "queue-redeem",
    configs: QUEUE_REDEEM_BACKSTOP_CONFIGS,
    allowedRouteFamilies: new Set(["queue-redeem"]),
  },
  {
    name: "stablecoin-redeem",
    configs: STABLECOIN_REDEEM_BACKSTOP_CONFIGS,
    allowedRouteFamilies: new Set(["stablecoin-redeem"]),
  },
] as const;

describe("redemption backstop config consistency", () => {
  it("every config ID exists in TRACKED_META_BY_ID", () => {
    const missing = entries.filter(([id]) => !TRACKED_META_BY_ID.has(id)).map(([id]) => id);
    expect(missing).toEqual([]);
  });

  it("no duplicate config IDs", () => {
    const ids = Object.keys(REDEMPTION_BACKSTOP_CONFIGS);
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const id of ids) {
      if (seen.has(id)) dupes.push(id);
      seen.add(id);
    }
    expect(dupes).toEqual([]);
  });

  it("offchain-issuer route requires issuer-api or manual access", () => {
    const violations = entries
      .filter(
        ([, c]) => c.routeFamily === "offchain-issuer" && c.accessModel !== "issuer-api" && c.accessModel !== "manual",
      )
      .map(([id, c]) => `${id}: offchain-issuer + ${c.accessModel}`);
    expect(violations).toEqual([]);
  });

  it("permissionless-onchain access excludes offchain-issuer route", () => {
    const violations = entries
      .filter(([, c]) => c.accessModel === "permissionless-onchain" && c.routeFamily === "offchain-issuer")
      .map(([id]) => id);
    expect(violations).toEqual([]);
  });

  it("atomic settlement excludes offchain-issuer route", () => {
    const violations = entries
      .filter(([, c]) => c.settlementModel === "atomic" && c.routeFamily === "offchain-issuer")
      .map(([id]) => id);
    expect(violations).toEqual([]);
  });

  it("queue-redeem route requires queued, days, or same-day settlement", () => {
    const violations = entries
      .filter(
        ([, c]) =>
          c.routeFamily === "queue-redeem" &&
          c.settlementModel !== "queued" &&
          c.settlementModel !== "days" &&
          c.settlementModel !== "same-day",
      )
      .map(([id, c]) => `${id}: queue-redeem + ${c.settlementModel}`);
    expect(violations).toEqual([]);
  });

  it("algorithmic backing excludes offchain-issuer route", () => {
    const violations = entries
      .filter(([id, c]) => {
        const meta = TRACKED_META_BY_ID.get(id);
        return meta?.flags.backing === "algorithmic" && c.routeFamily === "offchain-issuer";
      })
      .map(([id]) => id);
    expect(violations).toEqual([]);
  });

  it("delta-neutral protocols must not use supply-full capacity", () => {
    const DELTA_NEUTRAL_KEYWORDS = [
      "delta-neutral",
      "delta neutral",
      "funding rate arbitrage",
      "COIN-M perpetual short",
    ];

    const violations = entries
      .filter(([id, c]) => {
        const meta = TRACKED_META_BY_ID.get(id);
        if (!meta?.pegMechanism || c.capacityModel.kind !== "supply-full") return false;
        const peg = meta.pegMechanism.toLowerCase();
        return DELTA_NEUTRAL_KEYWORDS.some((kw) => peg.includes(kw.toLowerCase()));
      })
      .map(([id]) => id);
    expect(violations).toEqual([]);
  });

  it("family modules do not shadow ids across files", () => {
    const seenById = new Map<string, string>();
    const duplicates: string[] = [];

    for (const moduleEntry of familyModules) {
      for (const id of Object.keys(moduleEntry.configs)) {
        const previous = seenById.get(id);
        if (previous) {
          duplicates.push(`${id}: ${previous}, ${moduleEntry.name}`);
          continue;
        }
        seenById.set(id, moduleEntry.name);
      }
    }

    expect(duplicates).toEqual([]);
    expect(seenById.size).toBe(Object.keys(REDEMPTION_BACKSTOP_CONFIGS).length);
  });

  it("family modules only contain their declared route families", () => {
    const violations = familyModules.flatMap((moduleEntry) =>
      Object.entries(moduleEntry.configs)
        .filter(([, config]) => !moduleEntry.allowedRouteFamilies.has(config.routeFamily))
        .map(([id, config]) => `${moduleEntry.name}:${id}:${config.routeFamily}`),
    );

    expect(violations).toEqual([]);
  });

  it("every config resolves to an explicit confidence tier", () => {
    const violations = entries
      .filter(([, config]) => {
        const capacityConfidence = resolveCapacityConfidence(config.capacityModel);
        const feeConfidence = resolveFeeConfidence(config.costModel);
        return !capacityConfidence || !feeConfidence;
      })
      .map(([id]) => id);

    expect(violations).toEqual([]);
  });
});

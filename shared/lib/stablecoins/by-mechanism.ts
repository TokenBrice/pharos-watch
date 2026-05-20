import type { MechanismArchetype, StablecoinMeta } from "../../types";
import { MECHANISM_ARCHETYPE_VALUES } from "../../types/core";
import { resolveMechanismArchetype } from "../classification/resolve-mechanism-archetype";
import {
  ACTIVE_STABLECOINS,
  ACTIVE_META_BY_ID,
  PRE_LAUNCH_STABLECOINS,
  FROZEN_STABLECOINS,
} from "./registry";

const COMMODITY_PEG_CURRENCIES = new Set(["GOLD", "SILVER"] as const);

function isNotCommodity(coin: StablecoinMeta): boolean {
  return !COMMODITY_PEG_CURRENCIES.has(coin.flags.pegCurrency as "GOLD" | "SILVER");
}

/**
 * Count active, non-commodity stablecoins per mechanism archetype using the
 * inheritance resolver. Coins with a null effective archetype are excluded.
 *
 * `coins` and `registry` default to the live active registry; they are exposed
 * to allow tests to verify the commodity-exclusion filter against fixtures.
 */
export function countActiveByArchetype(
  coins: readonly StablecoinMeta[] = ACTIVE_STABLECOINS,
  registry: ReadonlyMap<string, StablecoinMeta> = ACTIVE_META_BY_ID,
): Record<MechanismArchetype, number> {
  const counts = Object.fromEntries(
    MECHANISM_ARCHETYPE_VALUES.map((a) => [a, 0]),
  ) as Record<MechanismArchetype, number>;

  for (const coin of coins) {
    if (!isNotCommodity(coin)) continue;
    const archetype = resolveMechanismArchetype(coin, registry);
    if (archetype !== null) {
      counts[archetype] += 1;
    }
  }

  return counts;
}

/**
 * Return active, non-commodity stablecoins for a given archetype.
 * When a supply map is provided, coins are sorted by supply descending;
 * otherwise they are returned in canonical order.
 *
 * `coins` and `registry` default to the live active registry; they are exposed
 * to allow tests to verify the commodity-exclusion filter against fixtures.
 */
export function getActiveByArchetype(
  archetype: MechanismArchetype,
  supplyById?: ReadonlyMap<string, number>,
  coins: readonly StablecoinMeta[] = ACTIVE_STABLECOINS,
  registry: ReadonlyMap<string, StablecoinMeta> = ACTIVE_META_BY_ID,
): StablecoinMeta[] {
  const filtered = coins.filter(
    (coin) =>
      isNotCommodity(coin) &&
      resolveMechanismArchetype(coin, registry) === archetype,
  );

  if (!supplyById) return filtered;

  return [...filtered].sort(
    (a, b) => (supplyById.get(b.id) ?? 0) - (supplyById.get(a.id) ?? 0),
  );
}

/**
 * Return stablecoins filtered by archetype and lifecycle status.
 * Uses the inheritance resolver for archetype resolution.
 */
export function getCoinsByLifecycleStatus(
  archetype: MechanismArchetype,
  status: "active" | "pre-launch" | "frozen" | "dead",
): StablecoinMeta[] {
  let pool: StablecoinMeta[];
  if (status === "active") pool = ACTIVE_STABLECOINS;
  else if (status === "pre-launch") pool = PRE_LAUNCH_STABLECOINS;
  else if (status === "frozen") pool = FROZEN_STABLECOINS;
  else return [];

  const registryForPool = new Map(pool.map((c) => [c.id, c]));

  return pool.filter(
    (coin) =>
      isNotCommodity(coin) &&
      resolveMechanismArchetype(coin, registryForPool) === archetype,
  );
}

/**
 * Separate a flat list of coins into parent coins and a map of their
 * direct children (1-level deep). Coins without variantOf are parents;
 * coins with variantOf are placed under their parent if present in the list.
 */
export function nestVariants(coins: StablecoinMeta[]): {
  parents: StablecoinMeta[];
  childrenByParentId: Record<string, StablecoinMeta[]>;
} {
  const coinSet = new Set(coins.map((c) => c.id));
  const parents: StablecoinMeta[] = [];
  const childrenByParentId: Record<string, StablecoinMeta[]> = {};

  for (const coin of coins) {
    if (coin.variantOf && coinSet.has(coin.variantOf)) {
      if (!childrenByParentId[coin.variantOf]) {
        childrenByParentId[coin.variantOf] = [];
      }
      childrenByParentId[coin.variantOf].push(coin);
    } else {
      parents.push(coin);
    }
  }

  return { parents, childrenByParentId };
}

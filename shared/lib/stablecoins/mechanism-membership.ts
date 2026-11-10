import type { MechanismArchetype, StablecoinMeta } from "../../types";
import { isCommodityPeg } from "../filter-tags";

/**
 * Membership authority for mechanism archetypes.
 *
 * Commodity pegs join the commodity-claim family and any family their own
 * classification explicitly names (for example a gold token curated as an
 * RWA credit fund). Inherited or absent classifications never widen
 * membership, so a commodity variant cannot follow its parent into a family
 * the coin itself does not declare.
 */
export function isIncludedInArchetype(
  coin: Pick<StablecoinMeta, "flags" | "mechanismArchetype">,
  archetype: MechanismArchetype | null,
): boolean {
  if (!isCommodityPeg(coin.flags.pegCurrency)) return true;
  return archetype === "commodity-claim" || coin.mechanismArchetype === archetype;
}

import type { MechanismArchetype, StablecoinMeta } from "../../types";

/**
 * Resolve the effective mechanismArchetype for a coin.
 *
 * Variant inheritance rule (Option B):
 * - If the coin has `archetypeOverride: true`, return its own archetype.
 * - If the coin has no `variantOf`, return its own archetype.
 * - Otherwise look up the parent in the registry and return the parent's archetype.
 * - If the parent is missing from the registry, fall back to the coin's own archetype.
 */
export function resolveMechanismArchetype(
  coin: StablecoinMeta,
  registry: ReadonlyMap<string, StablecoinMeta>,
): MechanismArchetype | null {
  if (coin.archetypeOverride === true || !coin.variantOf) {
    return coin.mechanismArchetype ?? null;
  }

  const parent = registry.get(coin.variantOf);
  if (!parent) {
    return coin.mechanismArchetype ?? null;
  }

  return parent.mechanismArchetype ?? null;
}

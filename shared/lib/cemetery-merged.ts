import type { DeadStablecoin } from "../types";
import logosByStablecoinId from "../../data/logos.json";
import { DEAD_STABLECOINS } from "./dead-stablecoins";
// Cemetery rendering needs obituary prose, contracts, and peak market cap —
// fields that intentionally live outside the slim client projection. Stay on
// the fat registry submodule; client cemetery surfaces that import this
// module accept the size cost in exchange for a single-import call site.
import { FROZEN_STABLECOINS } from "./stablecoins/registry";

export type CemeteryEntry = DeadStablecoin & { archivedDataAvailable?: boolean };

type FrozenStablecoin = (typeof FROZEN_STABLECOINS)[number];

function frozenLogoPath(coin: FrozenStablecoin): string {
  const registeredLogo = (logosByStablecoinId as Record<string, string | undefined>)[coin.id];
  if (registeredLogo) {
    return registeredLogo;
  }
  const symbolSlug = coin.symbol.toLowerCase();
  return coin.llamaId ? `/logos/${coin.llamaId}-${symbolSlug}.png` : `${symbolSlug}.png`;
}

export function frozenToDeadShape(coin: FrozenStablecoin): CemeteryEntry {
  if (!coin.obituary) {
    throw new Error(`Frozen coin ${coin.id} is missing obituary block`);
  }
  return {
    id: coin.id,
    name: coin.name,
    symbol: coin.symbol,
    llamaId: coin.llamaId,
    logo: frozenLogoPath(coin),
    pegCurrency: coin.flags.pegCurrency,
    causeOfDeath: coin.obituary.causeOfDeath,
    deathDate: coin.obituary.deathDate,
    epitaph: coin.obituary.epitaph,
    obituary: coin.obituary.obituary,
    peakMcap: coin.obituary.peakMcap,
    sourceUrl: coin.obituary.sourceUrl,
    sourceLabel: coin.obituary.sourceLabel,
    contracts: coin.contracts,
    archivedDataAvailable: true,
  };
}

/**
 * The frozen-coin slice the cemetery export actually consumes, in a stable
 * order. Dataset provenance hashes this projection rather than the whole
 * generated catalog: an active-coin edit must not rotate a published cemetery
 * checksum when no cemetery row moves.
 */
export function buildFrozenCemeteryProjection(): CemeteryEntry[] {
  return FROZEN_STABLECOINS.map(frozenToDeadShape).sort((left, right) => left.id.localeCompare(right.id));
}

export function buildMergedCemetery(): CemeteryEntry[] {
  const seenIds = new Set<string>();
  const merged: CemeteryEntry[] = [];
  for (const dead of DEAD_STABLECOINS) {
    if (seenIds.has(dead.id)) {
      throw new Error(
        `Cemetery id collision: ${dead.id} appears twice in dead-stablecoins.json`,
      );
    }
    seenIds.add(dead.id);
    merged.push(dead);
  }
  for (const frozen of FROZEN_STABLECOINS) {
    if (seenIds.has(frozen.id)) {
      throw new Error(
        `Cemetery id collision: ${frozen.id} is in both dead-stablecoins.json and FROZEN_STABLECOINS`,
      );
    }
    seenIds.add(frozen.id);
    merged.push(frozenToDeadShape(frozen));
  }
  return merged;
}

export const CEMETERY_ENTRIES: CemeteryEntry[] = buildMergedCemetery();

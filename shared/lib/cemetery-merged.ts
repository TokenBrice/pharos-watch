import type { DeadStablecoin } from "../types";
import { isValidIsoDateOnly } from "../types/date-primitives";
import logosByStablecoinId from "../../data/logos.json";
import { DEAD_STABLECOINS } from "./dead-stablecoins";
// Cemetery rendering needs obituary prose, contracts, and peak market cap —
// fields that intentionally live outside the slim client projection. Stay on
// the fat registry submodule; client cemetery surfaces that import this
// module accept the size cost in exchange for a single-import call site.
import { FROZEN_STABLECOINS } from "./stablecoins/registry";

export type CemeteryEntry = DeadStablecoin & { archivedDataAvailable?: boolean };

type FrozenStablecoin = (typeof FROZEN_STABLECOINS)[number];
export const CEMETERY_RECORDED_AT_DESCRIPTION =
  "UTC cemetery-entry/documentation date (YYYY-MM-DD); tracked rows default to frozenAt "
  + "unless obituary.recordedAt explicitly overrides it. Distinct from deathDate; null when not recorded.";


/** The cemetery UI's logo rule: absolute paths as-is, bare names under /logos/cemetery/. */
export function resolveCemeteryLogoUrl(logo?: string): string | undefined {
  if (!logo) return undefined;
  return logo.startsWith("/") ? logo : `/logos/cemetery/${logo}`;
}

function frozenLogoPath(coin: FrozenStablecoin): string {
  const registeredLogo = (logosByStablecoinId as Record<string, string | undefined>)[coin.id];
  if (registeredLogo) {
    return registeredLogo;
  }
  const symbolSlug = coin.symbol.toLowerCase();
  return coin.llamaId ? `/logos/${coin.llamaId}-${symbolSlug}.png` : `${symbolSlug}.png`;
}

/**
 * A frozen row normally entered the cemetery at `frozenAt`; an obituary
 * override separates the entry date from historical death-date freezes.
 * Invalid dates fail loudly rather than publishing fabricated ones.
 */
function frozenRecordedAt(coin: FrozenStablecoin): string | undefined {
  const date = coin.obituary?.recordedAt ?? coin.frozenAt;
  if (date === undefined) {
    return undefined;
  }
  const recordedAt = date.slice(0, 10);
  if (!isValidIsoDateOnly(recordedAt)) {
    const field = coin.obituary?.recordedAt !== undefined ? "recordedAt" : "frozenAt";
    throw new Error(`Frozen coin ${coin.id} has an invalid ${field}: ${date}`);
  }
  return recordedAt;
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
    mechanismArchetype: coin.mechanismArchetype,
    recordedAt: frozenRecordedAt(coin),
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

function buildMergedCemetery(): CemeteryEntry[] {
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

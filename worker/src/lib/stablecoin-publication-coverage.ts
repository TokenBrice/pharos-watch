import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";

export interface StablecoinPublicationWaiver {
  stablecoinId: string;
  owner: string;
  reason: string;
  expiresAt: number;
}

export interface StablecoinPublicationCoverage {
  complete: boolean;
  expectedActiveCount: number;
  presentActiveCount: number;
  waivedActiveCount: number;
  missingActiveIds: string[];
  waivedActiveIds: string[];
  expiredWaiverIds: string[];
  invalidWaiverIds: string[];
}

const NIGHT_WATCH_SUPPLY_WAIVER_EXPIRY_SEC = Date.UTC(2026, 7, 10) / 1000;

/**
 * Temporary exceptions for active assets that have no positive supply from an
 * existing permitted publication source. The 2026-07-10 audit confirmed that
 * these IDs are absent from the DefiLlama stablecoins list and CoinGecko
 * reports no market cap. Keep the roster explicit so a restored upstream row
 * supersedes its waiver automatically and expiry forces another review.
 */
export const STABLECOIN_PUBLICATION_WAIVERS: readonly StablecoinPublicationWaiver[] = [
  "benji-franklin-templeton",
  "wtgxx-wisdomtree",
  "busd0-usual",
  "tbill-openeden",
  "cetes-etherfuse",
  "jusd-jusd-stable-token",
  "vndc-jade-labs",
  "sofid-sofi",
].map((stablecoinId) => ({
  stablecoinId,
  owner: "data-platform",
  reason: "DefiLlama stablecoins has no row and CoinGecko reports no positive market cap",
  expiresAt: NIGHT_WATCH_SUPPLY_WAIVER_EXPIRY_SEC,
}));

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

export function evaluateStablecoinPublicationCoverage(
  publishedIds: Iterable<string>,
  nowSec: number = Math.floor(Date.now() / 1000),
  waivers: readonly StablecoinPublicationWaiver[] = STABLECOIN_PUBLICATION_WAIVERS,
  expectedActiveIds: readonly string[] = ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.id),
): StablecoinPublicationCoverage {
  const presentIds = new Set(publishedIds);
  const activeIds = new Set(expectedActiveIds);
  const waiverById = new Map<string, StablecoinPublicationWaiver>();
  const expiredWaiverIds = new Set<string>();
  const invalidWaiverIds = new Set<string>();

  for (const waiver of waivers) {
    if (
      !activeIds.has(waiver.stablecoinId)
      || !isNonEmpty(waiver.owner)
      || !isNonEmpty(waiver.reason)
      || !Number.isFinite(waiver.expiresAt)
      || waiver.expiresAt <= 0
    ) {
      invalidWaiverIds.add(waiver.stablecoinId);
      continue;
    }
    if (waiver.expiresAt <= nowSec) {
      expiredWaiverIds.add(waiver.stablecoinId);
      continue;
    }
    waiverById.set(waiver.stablecoinId, waiver);
  }

  const missingActiveIds: string[] = [];
  const waivedActiveIds: string[] = [];
  let presentActiveCount = 0;
  for (const stablecoinId of expectedActiveIds) {
    if (presentIds.has(stablecoinId)) {
      presentActiveCount++;
    } else if (waiverById.has(stablecoinId)) {
      waivedActiveIds.push(stablecoinId);
    } else {
      missingActiveIds.push(stablecoinId);
    }
  }

  return {
    complete: missingActiveIds.length === 0,
    expectedActiveCount: expectedActiveIds.length,
    presentActiveCount,
    waivedActiveCount: waivedActiveIds.length,
    missingActiveIds,
    waivedActiveIds,
    expiredWaiverIds: [...expiredWaiverIds].sort(),
    invalidWaiverIds: [...invalidWaiverIds].sort(),
  };
}

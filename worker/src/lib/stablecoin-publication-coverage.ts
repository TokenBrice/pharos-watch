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

/**
 * Deliberately empty by default. Any exception must identify an owner, explain
 * why the asset is unavailable, and expire so it cannot silently become policy.
 */
export const STABLECOIN_PUBLICATION_WAIVERS: readonly StablecoinPublicationWaiver[] = [];

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

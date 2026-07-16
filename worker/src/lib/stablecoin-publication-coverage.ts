import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { getCirculatingRaw } from "@shared/lib/supply";

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

export interface StablecoinPriceCoverageAsset {
  id: string;
  price?: number | null;
  priceSource?: string | null;
  priceConfidence?: string | null;
  priceObservedAt?: number | null;
  priceUpdatedAt?: number | null;
  circulating?: Record<string, number> | null;
}

export interface MissingActivePriceDetail {
  stablecoinId: string;
  marketCapUsd: number | null;
  currentPrice: number | null;
  currentSource: string | null;
  currentObservedAt: number | null;
  currentConfidence: string | null;
}

export interface StablecoinActivePriceCoverage {
  complete: boolean;
  expectedActiveCount: number;
  presentActiveCount: number;
  pricedActiveCount: number;
  missingPriceCount: number;
  pricedActiveIds: string[];
  missingActiveIds: string[];
  affectedMarketCapUsd: number;
  missingActiveAssets: MissingActivePriceDetail[];
}

export interface ResolvedStablecoinPublicationWaivers {
  activeById: ReadonlyMap<string, StablecoinPublicationWaiver>;
  expiredWaiverIds: string[];
  invalidWaiverIds: string[];
}

/** Active publication omissions are not silently waived. Price gaps and depegs
 * remain active monitoring failures. Only a persistent inability to establish
 * positive supply may move a row to quarantine after an explicit review. */
export const STABLECOIN_PUBLICATION_WAIVERS: readonly StablecoinPublicationWaiver[] = [];

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

export function resolveStablecoinPublicationWaivers(
  expectedActiveIds: readonly string[],
  nowSec: number,
  waivers: readonly StablecoinPublicationWaiver[],
): ResolvedStablecoinPublicationWaivers {
  const activeIds = new Set(expectedActiveIds);
  const activeById = new Map<string, StablecoinPublicationWaiver>();
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
    activeById.set(waiver.stablecoinId, waiver);
  }

  return {
    activeById,
    expiredWaiverIds: [...expiredWaiverIds].sort(),
    invalidWaiverIds: [...invalidWaiverIds].sort(),
  };
}

export function selectAppliedStablecoinPublicationWaivers(
  waivedActiveIds: readonly string[],
  resolvedWaivers: ResolvedStablecoinPublicationWaivers,
): StablecoinPublicationWaiver[] {
  return waivedActiveIds.map((stablecoinId) => {
    const waiver = resolvedWaivers.activeById.get(stablecoinId);
    if (!waiver) {
      throw new Error(`Missing resolved publication waiver for ${stablecoinId}`);
    }
    return waiver;
  });
}

export function evaluateStablecoinPublicationCoverage(
  publishedIds: Iterable<string>,
  nowSec: number = Math.floor(Date.now() / 1000),
  waivers: readonly StablecoinPublicationWaiver[] = STABLECOIN_PUBLICATION_WAIVERS,
  expectedActiveIds: readonly string[] = ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.id),
): StablecoinPublicationCoverage {
  const presentIds = new Set(publishedIds);
  const resolvedWaivers = resolveStablecoinPublicationWaivers(expectedActiveIds, nowSec, waivers);

  const missingActiveIds: string[] = [];
  const waivedActiveIds: string[] = [];
  let presentActiveCount = 0;
  for (const stablecoinId of expectedActiveIds) {
    if (presentIds.has(stablecoinId)) {
      presentActiveCount++;
    } else if (resolvedWaivers.activeById.has(stablecoinId)) {
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
    expiredWaiverIds: resolvedWaivers.expiredWaiverIds,
    invalidWaiverIds: resolvedWaivers.invalidWaiverIds,
  };
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function marketCapOrNull(asset: StablecoinPriceCoverageAsset | undefined): number | null {
  if (!asset?.circulating) return null;
  const hasFiniteBucket = Object.values(asset.circulating).some(
    (value) => typeof value === "number" && Number.isFinite(value),
  );
  return hasFiniteBucket ? getCirculatingRaw(asset) : null;
}

/** Price coverage is intentionally independent of row publication coverage.
 * A published active row with a null, zero, negative, or non-finite price is
 * still a public data-quality failure, but it must not block cache publication. */
export function evaluateStablecoinActivePriceCoverage(
  assets: Iterable<StablecoinPriceCoverageAsset>,
  expectedActiveIds: readonly string[] = ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.id),
): StablecoinActivePriceCoverage {
  const assetsById = new Map<string, StablecoinPriceCoverageAsset>();
  for (const asset of assets) {
    assetsById.set(asset.id, asset);
  }

  const pricedActiveIds: string[] = [];
  const missingActiveIds: string[] = [];
  const missingActiveAssets: MissingActivePriceDetail[] = [];
  let presentActiveCount = 0;
  let affectedMarketCapUsd = 0;

  for (const stablecoinId of expectedActiveIds) {
    const asset = assetsById.get(stablecoinId);
    if (asset) presentActiveCount++;

    const currentPrice = finiteNumberOrNull(asset?.price);
    if (currentPrice != null && currentPrice > 0) {
      pricedActiveIds.push(stablecoinId);
      continue;
    }

    const marketCapUsd = marketCapOrNull(asset);
    if (marketCapUsd != null && marketCapUsd > 0) {
      affectedMarketCapUsd += marketCapUsd;
    }
    missingActiveIds.push(stablecoinId);
    missingActiveAssets.push({
      stablecoinId,
      marketCapUsd,
      currentPrice,
      currentSource: typeof asset?.priceSource === "string" ? asset.priceSource : null,
      currentObservedAt: finiteNumberOrNull(asset?.priceObservedAt ?? asset?.priceUpdatedAt),
      currentConfidence: typeof asset?.priceConfidence === "string" ? asset.priceConfidence : null,
    });
  }

  return {
    complete: missingActiveIds.length === 0,
    expectedActiveCount: expectedActiveIds.length,
    presentActiveCount,
    pricedActiveCount: pricedActiveIds.length,
    missingPriceCount: missingActiveIds.length,
    pricedActiveIds,
    missingActiveIds,
    affectedMarketCapUsd,
    missingActiveAssets,
  };
}

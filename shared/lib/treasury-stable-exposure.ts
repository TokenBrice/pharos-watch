import { CHAIN_META } from "./chains";
import { scoreToGrade } from "./report-cards";
import { ACTIVE_STABLECOINS } from "./stablecoins";
import type {
  GovernanceType,
  ReportCard,
  TreasurySeed,
  TreasuryStableExposureEntity,
  TreasuryStableExposureHolding,
  TreasuryStableExposureResponse,
} from "../types";

export interface TreasuryBalanceToken {
  chainId: number;
  tokenAddress: string;
  usdValue: number;
}

export interface TreasuryWalletSnapshot {
  treasuryBalances: TreasuryBalanceToken[];
  stablecoinBalances: TreasuryBalanceToken[];
  warnings?: string[];
}

interface StablecoinContractRef {
  stablecoinId: string;
  name: string;
  symbol: string;
  governance: GovernanceType;
}

const CONTRACT_LOOKUP = new Map<string, StablecoinContractRef>();

for (const stablecoin of ACTIVE_STABLECOINS) {
  const deployments = [...(stablecoin.contracts ?? []), ...(stablecoin.tradedContracts ?? [])];
  for (const deployment of deployments) {
    const chainMeta = CHAIN_META[deployment.chain];
    if (!chainMeta?.evmChainId) continue;
    CONTRACT_LOOKUP.set(
      `${chainMeta.evmChainId}:${deployment.address.toLowerCase()}`,
      {
        stablecoinId: stablecoin.id,
        name: stablecoin.name,
        symbol: stablecoin.symbol,
        governance: stablecoin.flags.governance,
      },
    );
  }
}

function roundUsd(value: number): number {
  return Number(value.toFixed(2));
}

function roundPct(value: number | null): number | null {
  return value == null ? null : Number(value.toFixed(2));
}

function toPct(part: number, total: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null;
  return roundPct((part / total) * 100);
}

export function resolveTrackedTreasuryStablecoin(
  chainId: number,
  tokenAddress: string,
): StablecoinContractRef | null {
  if (!tokenAddress || tokenAddress === "native") return null;
  return CONTRACT_LOOKUP.get(`${chainId}:${tokenAddress.toLowerCase()}`) ?? null;
}

export function computeTreasuryStableExposureEntity(
  seed: TreasurySeed,
  wallets: TreasuryWalletSnapshot[],
  cards: readonly ReportCard[],
): TreasuryStableExposureEntity {
  const reportCardById = new Map(cards.map((card) => [card.id, card]));
  const trackedStableUsd = new Map<string, { meta: StablecoinContractRef; usdValue: number }>();

  let treasuryUsd = 0;
  let stablecoinSleeveUsd = 0;
  let untrackedStableUsd = 0;
  let untrackedStableCount = 0;

  const notes = new Set(seed.notes ?? []);
  for (const wallet of wallets) {
    for (const balance of wallet.treasuryBalances) {
      if (!Number.isFinite(balance.usdValue) || balance.usdValue <= 0) continue;
      treasuryUsd += balance.usdValue;
    }
    for (const balance of wallet.stablecoinBalances) {
      if (!Number.isFinite(balance.usdValue) || balance.usdValue <= 0) continue;
      stablecoinSleeveUsd += balance.usdValue;
      const resolved = resolveTrackedTreasuryStablecoin(balance.chainId, balance.tokenAddress);
      if (!resolved) {
        untrackedStableUsd += balance.usdValue;
        untrackedStableCount += 1;
        continue;
      }
      const existing = trackedStableUsd.get(resolved.stablecoinId);
      if (existing) {
        existing.usdValue += balance.usdValue;
      } else {
        trackedStableUsd.set(resolved.stablecoinId, {
          meta: resolved,
          usdValue: balance.usdValue,
        });
      }
    }
    for (const warning of wallet.warnings ?? []) notes.add(warning);
  }

  const governanceBuckets = {
    centralizedUsd: 0,
    centralizedDependentUsd: 0,
    decentralizedUsd: 0,
  };

  let ratedTrackedStableUsd = 0;
  let weightedSafetyNumerator = 0;

  const holdings: TreasuryStableExposureHolding[] = Array.from(trackedStableUsd.values())
    .map(({ meta, usdValue }) => {
      const roundedUsd = roundUsd(usdValue);
      const card = reportCardById.get(meta.stablecoinId);
      if (meta.governance === "centralized") governanceBuckets.centralizedUsd += roundedUsd;
      else if (meta.governance === "centralized-dependent") governanceBuckets.centralizedDependentUsd += roundedUsd;
      else governanceBuckets.decentralizedUsd += roundedUsd;

      if (card?.overallScore != null && roundedUsd > 0) {
        ratedTrackedStableUsd += roundedUsd;
        weightedSafetyNumerator += roundedUsd * card.overallScore;
      }

      return {
        stablecoinId: meta.stablecoinId,
        name: meta.name,
        symbol: meta.symbol,
        governance: meta.governance,
        usdValue: roundedUsd,
        pctOfTreasury: toPct(roundedUsd, treasuryUsd),
        pctOfStableSleeve: toPct(roundedUsd, stablecoinSleeveUsd),
        safetyScore: card?.overallScore ?? null,
        safetyGrade: card?.overallGrade ?? null,
      };
    })
    .sort((a, b) => b.usdValue - a.usdValue);

  const trackedStableTotal = holdings.reduce((sum, holding) => sum + holding.usdValue, 0);
  const weightedSafetyScore = ratedTrackedStableUsd > 0
    ? Number((weightedSafetyNumerator / ratedTrackedStableUsd).toFixed(1))
    : null;

  if (untrackedStableUsd > 0) {
    notes.add("Stable-sleeve percentages include untracked stablecoins returned by the balance provider.");
  }

  return {
    protocolId: seed.protocolId,
    slug: seed.slug,
    name: seed.name,
    category: seed.category,
    source: seed.source,
    adapterFile: seed.adapterFile,
    chains: seed.chains,
    treasuryUsd: roundUsd(treasuryUsd),
    stablecoinSleeveUsd: roundUsd(stablecoinSleeveUsd),
    trackedStableUsd: roundUsd(trackedStableTotal),
    decentralizedStableUsd: roundUsd(governanceBuckets.decentralizedUsd),
    decentralizedStablePctOfTreasury: toPct(governanceBuckets.decentralizedUsd, treasuryUsd),
    decentralizedStablePctOfStableSleeve: toPct(governanceBuckets.decentralizedUsd, stablecoinSleeveUsd),
    weightedSafetyScore,
    weightedSafetyGrade: scoreToGrade(weightedSafetyScore),
    governanceBuckets: {
      centralizedUsd: roundUsd(governanceBuckets.centralizedUsd),
      centralizedDependentUsd: roundUsd(governanceBuckets.centralizedDependentUsd),
      decentralizedUsd: roundUsd(governanceBuckets.decentralizedUsd),
    },
    holdings,
    coverage: {
      extractionMode: seed.extractionMode,
      ownerCount: new Set(seed.owners.map((owner) => owner.address.toLowerCase())).size,
      ownerChainCount: seed.owners.length,
      trackedStableUsd: roundUsd(trackedStableTotal),
      stablecoinSleeveUsd: roundUsd(stablecoinSleeveUsd),
      untrackedStableUsd: roundUsd(untrackedStableUsd),
      ratedTrackedStableUsd: roundUsd(ratedTrackedStableUsd),
      trackedStablePctOfTreasury: toPct(trackedStableTotal, treasuryUsd),
      trackedStablePctOfStableSleeve: toPct(trackedStableTotal, stablecoinSleeveUsd),
      ratedTrackedStablePct: toPct(ratedTrackedStableUsd, trackedStableTotal),
      untrackedStableCount,
      notes: [...notes],
    },
  };
}

export function buildTreasuryStableExposureSnapshot(
  seeds: readonly TreasurySeed[],
  entities: readonly TreasuryStableExposureEntity[],
  updatedAt: number,
): TreasuryStableExposureResponse {
  return {
    entities: [...entities],
    updatedAt,
    coverage: {
      entityCount: entities.length,
      registryCount: seeds.length,
      launchEligibleCount: seeds.filter((seed) => seed.launchEligible).length,
      ownerChainTuples: seeds.reduce((sum, seed) => sum + seed.owners.length, 0),
      launchOwnerChainTuples: seeds
        .filter((seed) => seed.launchEligible)
        .reduce((sum, seed) => sum + seed.owners.length, 0),
      evmOnly: true,
      extractionModes: {
        staticSeeded: seeds.filter((seed) => seed.extractionMode === "static-seeded").length,
        customReviewed: seeds.filter((seed) => seed.extractionMode === "custom-reviewed").length,
        dynamicUnresolved: seeds.filter((seed) => seed.extractionMode === "dynamic-unresolved").length,
        missing: seeds.filter((seed) => seed.extractionMode === "missing").length,
      },
    },
  };
}

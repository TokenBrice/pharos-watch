import { CHAIN_META } from "./chains";
import { scoreToGrade } from "./report-cards";
import { ACTIVE_STABLECOINS } from "./stablecoins";
import type {
  GovernanceType,
  ReportCard,
  TreasuryDenominatorStatus,
  TreasurySeed,
  TreasuryStableExposureEntity,
  TreasuryStableExposureHolding,
  TreasuryStableExposureResponse,
} from "../types";

export interface TreasuryBalanceToken {
  chainId: number;
  tokenAddress: string;
  usdValue: number;
  balanceKey?: string;
}

export interface TreasuryDerivedPosition {
  positionUsd: number | null;
  stableLegs: TreasuryBalanceToken[];
  consumedBalanceKeys?: string[];
  partialStableExposure?: boolean;
  warnings?: string[];
}

export interface TreasuryWalletSnapshot {
  treasuryBalances: TreasuryBalanceToken[];
  stablecoinBalances: TreasuryBalanceToken[];
  derivedPositions?: TreasuryDerivedPosition[];
  warnings?: string[];
}

interface StablecoinContractRef {
  stablecoinId: string;
  name: string;
  symbol: string;
  governance: GovernanceType;
}

export interface TreasuryStableExposureInvariantIssue {
  code: string;
  message: string;
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

function toPct(part: number, total: number | null): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total == null || total <= 0) return null;
  return roundPct((part / total) * 100);
}

function legacyBalanceKey(chainId: number, tokenAddress: string): string {
  return `${chainId}:${tokenAddress.toLowerCase()}`;
}

function getBalanceKey(balance: TreasuryBalanceToken): string {
  return balance.balanceKey ?? legacyBalanceKey(balance.chainId, balance.tokenAddress);
}

function pushNote(notes: string[], note: string): string[] {
  return notes.includes(note) ? notes : [...notes, note];
}

export function resolveTrackedTreasuryStablecoin(
  chainId: number,
  tokenAddress: string,
): StablecoinContractRef | null {
  if (!tokenAddress || tokenAddress === "native") return null;
  return CONTRACT_LOOKUP.get(`${chainId}:${tokenAddress.toLowerCase()}`) ?? null;
}

export function isTreasuryComparableEntity(entity: TreasuryStableExposureEntity): boolean {
  return entity.treasuryUsd != null
    && (entity.coverage.denominatorStatus === "direct-only" || entity.coverage.denominatorStatus === "adjusted-with-defi");
}

function getTreasuryStableExposureEntityInvariantIssues(
  entity: TreasuryStableExposureEntity,
): TreasuryStableExposureInvariantIssue[] {
  const issues: TreasuryStableExposureInvariantIssue[] = [];
  const epsilon = 0.01;

  if (Math.abs(entity.directWalletUsd - entity.coverage.directWalletUsd) > epsilon) {
    issues.push({
      code: "direct_wallet_mismatch",
      message: "Entity direct wallet total does not match coverage.directWalletUsd.",
    });
  }
  if (Math.abs(entity.trackedStableUsd - entity.coverage.trackedStableUsd) > epsilon) {
    issues.push({
      code: "tracked_stable_mismatch",
      message: "Entity trackedStableUsd does not match coverage.trackedStableUsd.",
    });
  }
  if (Math.abs(entity.stablecoinSleeveUsd - entity.coverage.stablecoinSleeveUsd) > epsilon) {
    issues.push({
      code: "stable_sleeve_mismatch",
      message: "Entity stablecoinSleeveUsd does not match coverage.stablecoinSleeveUsd.",
    });
  }

  if (entity.coverage.denominatorStatus === "partial" || entity.coverage.denominatorStatus === "invalid") {
    if (entity.treasuryUsd != null) {
      issues.push({
        code: "nulled_denominator_required",
        message: "Partial or invalid rows must not publish treasuryUsd.",
      });
    }
  }

  if (entity.treasuryUsd == null) {
    if (entity.decentralizedStablePctOfTreasury != null) {
      issues.push({
        code: "pct_of_treasury_must_be_null",
        message: "Rows without a treasury denominator must not publish decentralizedStablePctOfTreasury.",
      });
    }
    if (entity.coverage.trackedStablePctOfTreasury != null) {
      issues.push({
        code: "tracked_pct_of_treasury_must_be_null",
        message: "Rows without a treasury denominator must not publish trackedStablePctOfTreasury.",
      });
    }
    if (entity.holdings.some((holding) => holding.pctOfTreasury != null)) {
      issues.push({
        code: "holding_pct_of_treasury_must_be_null",
        message: "Rows without a treasury denominator must not publish holding treasury percentages.",
      });
    }
    return issues;
  }

  if (!Number.isFinite(entity.treasuryUsd) || entity.treasuryUsd <= 0) {
    issues.push({
      code: "invalid_treasury_usd",
      message: "Treasury-comparable rows must publish a positive treasuryUsd.",
    });
  }
  if (entity.stablecoinSleeveUsd > entity.treasuryUsd + epsilon) {
    issues.push({
      code: "stable_sleeve_exceeds_treasury",
      message: "Stable sleeve exceeds treasury denominator.",
    });
  }
  if (entity.trackedStableUsd > entity.stablecoinSleeveUsd + epsilon) {
    issues.push({
      code: "tracked_exceeds_sleeve",
      message: "Tracked stable sleeve exceeds total stable sleeve.",
    });
  }
  if (entity.decentralizedStableUsd > entity.trackedStableUsd + epsilon) {
    issues.push({
      code: "decentralized_exceeds_tracked",
      message: "Decentralized stable total exceeds tracked stable total.",
    });
  }
  if (entity.holdings.some((holding) => holding.usdValue > entity.treasuryUsd! + epsilon)) {
    issues.push({
      code: "holding_exceeds_treasury",
      message: "A holding exceeds the treasury denominator.",
    });
  }
  if (entity.holdings.some((holding) => (holding.pctOfTreasury ?? 0) > 100.01)) {
    issues.push({
      code: "holding_pct_exceeds_100",
      message: "A holding treasury percentage exceeds 100%.",
    });
  }
  if ((entity.coverage.trackedStablePctOfTreasury ?? 0) > 100.01) {
    issues.push({
      code: "tracked_pct_exceeds_100",
      message: "Tracked stable treasury percentage exceeds 100%.",
    });
  }
  if ((entity.decentralizedStablePctOfTreasury ?? 0) > 100.01) {
    issues.push({
      code: "decentralized_pct_exceeds_100",
      message: "Decentralized stable treasury percentage exceeds 100%.",
    });
  }
  if (entity.coverage.denominatorStatus === "direct-only" && Math.abs(entity.treasuryUsd - entity.directWalletUsd) > epsilon) {
    issues.push({
      code: "direct_only_denominator_mismatch",
      message: "Direct-only rows must use directWalletUsd as treasuryUsd.",
    });
  }

  return issues;
}

export function getTreasuryStableExposureResponseInvariantIssues(
  snapshot: TreasuryStableExposureResponse,
): TreasuryStableExposureInvariantIssue[] {
  const issues: TreasuryStableExposureInvariantIssue[] = [];

  if (snapshot.coverage.entityCount !== snapshot.entities.length) {
    issues.push({
      code: "entity_count_mismatch",
      message: "Top-level entityCount does not match entities.length.",
    });
  }

  const comparableEntityCount = snapshot.entities.filter(isTreasuryComparableEntity).length;
  const partialEntityCount = snapshot.entities.filter((entity) => entity.coverage.denominatorStatus === "partial").length;
  const invalidEntityCount = snapshot.entities.filter((entity) => entity.coverage.denominatorStatus === "invalid").length;
  const supplementedEntityCount = snapshot.entities.filter(
    (entity) =>
      entity.coverage.defiPositionUsd > 0
      || entity.coverage.consumedDirectBalanceUsd > 0
      || entity.coverage.skippedDerivedPositionCount > 0,
  ).length;

  if (snapshot.coverage.comparableEntityCount !== comparableEntityCount) {
    issues.push({
      code: "comparable_count_mismatch",
      message: "Top-level comparableEntityCount does not match entity statuses.",
    });
  }
  if (snapshot.coverage.partialEntityCount !== partialEntityCount) {
    issues.push({
      code: "partial_count_mismatch",
      message: "Top-level partialEntityCount does not match entity statuses.",
    });
  }
  if (snapshot.coverage.invalidEntityCount !== invalidEntityCount) {
    issues.push({
      code: "invalid_count_mismatch",
      message: "Top-level invalidEntityCount does not match entity statuses.",
    });
  }
  if (snapshot.coverage.supplementedEntityCount !== supplementedEntityCount) {
    issues.push({
      code: "supplemented_count_mismatch",
      message: "Top-level supplementedEntityCount does not match entity coverage.",
    });
  }

  for (const entity of snapshot.entities) {
    issues.push(...getTreasuryStableExposureEntityInvariantIssues(entity));
  }

  return issues;
}

function downgradeEntityToInvalid(
  entity: TreasuryStableExposureEntity,
  message: string,
): TreasuryStableExposureEntity {
  return {
    ...entity,
    treasuryUsd: null,
    decentralizedStablePctOfTreasury: null,
    holdings: entity.holdings.map((holding) => ({
      ...holding,
      pctOfTreasury: null,
    })),
    coverage: {
      ...entity.coverage,
      denominatorStatus: "invalid",
      trackedStablePctOfTreasury: null,
      notes: pushNote(entity.coverage.notes, message),
    },
  };
}

export function computeTreasuryStableExposureEntity(
  seed: TreasurySeed,
  wallets: TreasuryWalletSnapshot[],
  cards: readonly ReportCard[],
): TreasuryStableExposureEntity {
  const reportCardById = new Map(cards.map((card) => [card.id, card]));
  const trackedStableUsd = new Map<string, { meta: StablecoinContractRef; usdValue: number }>();
  const consumedStableBalanceKeys = new Set<string>();
  const directBalanceValueByKey = new Map<string, number>();

  let directWalletUsd = 0;
  let stablecoinSleeveUsd = 0;
  let untrackedStableUsd = 0;
  let derivedUntrackedStableUsd = 0;
  let untrackedStableCount = 0;
  let derivedUntrackedStableCount = 0;
  let derivedStableBalanceCount = 0;
  let derivedPositionUsdTotal = 0;
  let consumedDirectBalanceUsd = 0;
  let skippedDerivedPositionCount = 0;
  let hasPartialDenominator = false;

  const notes = new Set(seed.notes ?? []);

  function accumulateStableBalance(balance: TreasuryBalanceToken, source: "direct" | "derived") {
    if (!Number.isFinite(balance.usdValue) || balance.usdValue <= 0) return;
    stablecoinSleeveUsd += balance.usdValue;

    const resolved = resolveTrackedTreasuryStablecoin(balance.chainId, balance.tokenAddress);
    if (!resolved) {
      untrackedStableUsd += balance.usdValue;
      untrackedStableCount += 1;
      if (source === "derived") {
        derivedUntrackedStableUsd += balance.usdValue;
        derivedUntrackedStableCount += 1;
      }
      return;
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

  for (const wallet of wallets) {
    for (const balance of wallet.treasuryBalances) {
      if (!Number.isFinite(balance.usdValue) || balance.usdValue <= 0) continue;
      directWalletUsd += balance.usdValue;
      const key = getBalanceKey(balance);
      directBalanceValueByKey.set(key, (directBalanceValueByKey.get(key) ?? 0) + balance.usdValue);
    }
    for (const position of wallet.derivedPositions ?? []) {
      for (const consumedBalanceKey of position.consumedBalanceKeys ?? []) {
        consumedStableBalanceKeys.add(consumedBalanceKey);
      }
    }
  }

  for (const wallet of wallets) {
    for (const balance of wallet.stablecoinBalances) {
      if (consumedStableBalanceKeys.has(getBalanceKey(balance))) {
        continue;
      }
      accumulateStableBalance(balance, "direct");
    }

    for (const position of wallet.derivedPositions ?? []) {
      const hasStableLegs = position.stableLegs.some((balance) => Number.isFinite(balance.usdValue) && balance.usdValue > 0);
      if (position.partialStableExposure || (hasStableLegs && position.positionUsd == null)) {
        hasPartialDenominator = true;
        skippedDerivedPositionCount += 1;
      }
      if (hasStableLegs && position.positionUsd != null) {
        derivedPositionUsdTotal += position.positionUsd;
      }

      for (const balance of position.stableLegs) {
        derivedStableBalanceCount += 1;
        accumulateStableBalance(balance, "derived");
      }

      for (const warning of position.warnings ?? []) notes.add(warning);
    }

    for (const warning of wallet.warnings ?? []) notes.add(warning);
  }

  for (const consumedBalanceKey of consumedStableBalanceKeys) {
    consumedDirectBalanceUsd += directBalanceValueByKey.get(consumedBalanceKey) ?? 0;
  }

  let denominatorStatus: TreasuryDenominatorStatus = "direct-only";
  let treasuryUsd: number | null = roundUsd(directWalletUsd);
  const usedDefiSupplement = derivedStableBalanceCount > 0 || consumedDirectBalanceUsd > 0;

  if (usedDefiSupplement) {
    if (hasPartialDenominator) {
      denominatorStatus = "partial";
      treasuryUsd = null;
    } else {
      denominatorStatus = "adjusted-with-defi";
      treasuryUsd = roundUsd(Math.max(0, directWalletUsd - consumedDirectBalanceUsd + derivedPositionUsdTotal));
    }
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
    .filter((holding) => holding.usdValue > 0)
    .sort((a, b) => b.usdValue - a.usdValue);

  const trackedStableTotal = roundUsd(holdings.reduce((sum, holding) => sum + holding.usdValue, 0));
  const weightedSafetyScore = ratedTrackedStableUsd > 0
    ? Number((weightedSafetyNumerator / ratedTrackedStableUsd).toFixed(1))
    : null;

  if (untrackedStableUsd > 0) {
    notes.add("Stable-sleeve percentages include stable exposure that could not be mapped to a tracked Pharos stablecoin.");
  }
  if (derivedUntrackedStableUsd > 0) {
    notes.add("Some derived stable exposure came from LP, vault, or lending positions but could not be mapped to a tracked Pharos stablecoin.");
  }
  if (derivedStableBalanceCount > 0) {
    notes.add("Stable sleeve includes supported LP, vault, and lending positions decomposed to underlying stablecoins.");
  }
  if (denominatorStatus === "partial") {
    notes.add("Treasury-relative metrics are unavailable because one or more derived positions could not be valued end to end.");
  }

  let entity: TreasuryStableExposureEntity = {
    protocolId: seed.protocolId,
    slug: seed.slug,
    name: seed.name,
    category: seed.category,
    source: seed.source,
    adapterFile: seed.adapterFile,
    chains: seed.chains,
    directWalletUsd: roundUsd(directWalletUsd),
    treasuryUsd,
    stablecoinSleeveUsd: roundUsd(stablecoinSleeveUsd),
    trackedStableUsd: trackedStableTotal,
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
      denominatorStatus,
      directWalletUsd: roundUsd(directWalletUsd),
      defiPositionUsd: roundUsd(derivedPositionUsdTotal),
      consumedDirectBalanceUsd: roundUsd(consumedDirectBalanceUsd),
      trackedStableUsd: trackedStableTotal,
      stablecoinSleeveUsd: roundUsd(stablecoinSleeveUsd),
      untrackedStableUsd: roundUsd(untrackedStableUsd),
      derivedUntrackedStableUsd: roundUsd(derivedUntrackedStableUsd),
      ratedTrackedStableUsd: roundUsd(ratedTrackedStableUsd),
      trackedStablePctOfTreasury: toPct(trackedStableTotal, treasuryUsd),
      trackedStablePctOfStableSleeve: toPct(trackedStableTotal, stablecoinSleeveUsd),
      ratedTrackedStablePct: toPct(ratedTrackedStableUsd, trackedStableTotal),
      untrackedStableCount,
      derivedUntrackedStableCount,
      skippedDerivedPositionCount,
      notes: [...notes],
    },
  };

  if (denominatorStatus !== "partial") {
    const issues = getTreasuryStableExposureEntityInvariantIssues(entity);
    if (issues.length > 0) {
      entity = downgradeEntityToInvalid(
        entity,
        "Treasury-relative metrics are suppressed because the effective treasury denominator failed validation.",
      );
    }
  }

  return entity;
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
      comparableEntityCount: entities.filter(isTreasuryComparableEntity).length,
      partialEntityCount: entities.filter((entity) => entity.coverage.denominatorStatus === "partial").length,
      invalidEntityCount: entities.filter((entity) => entity.coverage.denominatorStatus === "invalid").length,
      supplementedEntityCount: entities.filter(
        (entity) =>
          entity.coverage.defiPositionUsd > 0
          || entity.coverage.consumedDirectBalanceUsd > 0
          || entity.coverage.skippedDerivedPositionCount > 0,
      ).length,
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

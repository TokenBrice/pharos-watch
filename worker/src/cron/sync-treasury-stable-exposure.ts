import { TREASURY_LAUNCH_SEEDS, TREASURY_SEEDS } from "@shared/lib/treasury-seeds";
import {
  buildTreasuryStableExposureSnapshot,
  computeTreasuryStableExposureEntity,
  isTreasuryComparableEntity,
} from "@shared/lib/treasury-stable-exposure";
import { CHAIN_META } from "@shared/lib/chains";
import type { TreasuryStableExposureEntity } from "@shared/types";
import { setCacheIfNewer, shouldSkipFreshCache } from "../lib/db-cache";
import { batchExecute } from "../lib/db";
import type { CronResult } from "../lib/cron-logger";
import { buildReportCardsSnapshot } from "../lib/report-cards-snapshot";
import { shouldAttemptFetch, recordOutcomeSafe } from "../lib/circuit-breaker";
import { sleepWithSignal } from "../lib/abort";
import { CIRCUIT_SOURCE, SIM_BALANCES_OWNER_GROUP_DELAY_MS } from "../lib/constants";
import { fetchSimWalletBalances, fetchSimWalletDefiTreasuryPositions } from "../lib/sim-balances";

const CACHE_KEY = "treasury-stable-exposure";
const STALE_SEC = 20 * 60 * 60;

interface OwnerGroup {
  address: string;
  chainIds: number[];
}

function groupOwners(protocolName: string, owners: readonly { chain: string; address: string }[]): OwnerGroup[] {
  const grouped = new Map<string, Set<number>>();

  for (const owner of owners) {
    const evmChainId = CHAIN_META[owner.chain]?.evmChainId;
    if (!evmChainId) {
      throw new Error(`[treasury-stable-exposure] ${protocolName} includes non-EVM owner ${owner.chain}:${owner.address}`);
    }
    const address = owner.address.toLowerCase();
    const chainIds = grouped.get(address) ?? new Set<number>();
    chainIds.add(evmChainId);
    grouped.set(address, chainIds);
  }

  return Array.from(grouped.entries())
    .map(([address, chainIds]) => ({
      address,
      chainIds: [...chainIds].sort((a, b) => a - b),
    }))
    .sort((a, b) => a.address.localeCompare(b.address));
}

function compareEntitiesForPublish(a: TreasuryStableExposureEntity, b: TreasuryStableExposureEntity): number {
  const decentralizedDiff = b.decentralizedStableUsd - a.decentralizedStableUsd;
  if (decentralizedDiff !== 0) return decentralizedDiff;

  const comparableDiff = Number(isTreasuryComparableEntity(b)) - Number(isTreasuryComparableEntity(a));
  if (comparableDiff !== 0) return comparableDiff;

  const pctDiff = (b.decentralizedStablePctOfTreasury ?? -1) - (a.decentralizedStablePctOfTreasury ?? -1);
  if (pctDiff !== 0) return pctDiff;

  return a.name.localeCompare(b.name);
}

async function persistTreasuryStableExposureHistory(
  db: D1Database,
  snapshotAt: number,
  entities: readonly TreasuryStableExposureEntity[],
): Promise<number> {
  const statements = entities.map((entity) =>
    db
      .prepare(
        `INSERT OR REPLACE INTO treasury_stable_exposure_history (
           snapshot_at,
           protocol_id,
           slug,
           denominator_status,
           direct_wallet_usd,
           treasury_usd,
           stablecoin_sleeve_usd,
           tracked_stable_usd,
           decentralized_stable_usd,
           coverage_json,
           holdings_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        snapshotAt,
        entity.protocolId,
        entity.slug,
        entity.coverage.denominatorStatus,
        entity.directWalletUsd,
        entity.treasuryUsd,
        entity.stablecoinSleeveUsd,
        entity.trackedStableUsd,
        entity.decentralizedStableUsd,
        JSON.stringify(entity.coverage),
        JSON.stringify(entity.holdings),
      )
  );

  return batchExecute(db, statements);
}

export async function syncTreasuryStableExposure(
  db: D1Database,
  simApiKey: string | null,
  signal?: AbortSignal,
): Promise<CronResult> {
  const syncStartSec = Math.floor(Date.now() / 1000);

  if (!simApiKey) {
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "sim-api-key-missing" }),
    };
  }

  if (await shouldSkipFreshCache(db, CACHE_KEY, STALE_SEC)) {
    return {
      itemCount: 0,
      metadata: JSON.stringify({ reason: "cache-fresh" }),
    };
  }

  if (!(await shouldAttemptFetch(db, CIRCUIT_SOURCE.SIM_BALANCES))) {
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "sim-balances-circuit-open" }),
    };
  }

  try {
    const reportCardsSnapshot = await buildReportCardsSnapshot(db);
    const entities: TreasuryStableExposureEntity[] = [];

    for (const seed of TREASURY_LAUNCH_SEEDS) {
      const groupedOwners = groupOwners(seed.name, seed.owners);
      const walletSnapshots = [];

      for (const [ownerIndex, owner] of groupedOwners.entries()) {
        const [treasuryBalancesResult, stablecoinBalancesResult, defiTreasuryPositionsResult] = await Promise.allSettled([
          fetchSimWalletBalances({
            apiKey: simApiKey,
            address: owner.address,
            chainIds: owner.chainIds,
            signal,
          }),
          fetchSimWalletBalances({
            apiKey: simApiKey,
            address: owner.address,
            chainIds: owner.chainIds,
            stablecoinOnly: true,
            signal,
          }),
          fetchSimWalletDefiTreasuryPositions({
            apiKey: simApiKey,
            address: owner.address,
            chainIds: owner.chainIds,
            signal,
          }),
        ]);

        if (treasuryBalancesResult.status === "rejected") throw treasuryBalancesResult.reason;
        if (stablecoinBalancesResult.status === "rejected") throw stablecoinBalancesResult.reason;

        const treasuryBalances = treasuryBalancesResult.value;
        const stablecoinBalances = stablecoinBalancesResult.value;
        const defiTreasuryPositions = defiTreasuryPositionsResult.status === "fulfilled"
          ? defiTreasuryPositionsResult.value
          : {
              positions: [],
              warnings: [
                "DeFi position supplement failed for one or more treasury owners; LP, vault, and lending exposure may be understated.",
              ],
            };

        walletSnapshots.push({
          treasuryBalances: treasuryBalances.balances,
          stablecoinBalances: stablecoinBalances.balances,
          derivedPositions: defiTreasuryPositions.positions,
          warnings: [...treasuryBalances.warnings, ...stablecoinBalances.warnings, ...defiTreasuryPositions.warnings],
        });

        if (ownerIndex < groupedOwners.length - 1) {
          await sleepWithSignal(SIM_BALANCES_OWNER_GROUP_DELAY_MS, signal);
        }
      }

      entities.push(computeTreasuryStableExposureEntity(seed, walletSnapshots, reportCardsSnapshot.cards));
    }

    entities.sort(compareEntitiesForPublish);

    const snapshot = buildTreasuryStableExposureSnapshot(TREASURY_SEEDS, entities, syncStartSec);
    await setCacheIfNewer(db, CACHE_KEY, JSON.stringify(snapshot), syncStartSec);
    const historyRowsWritten = await persistTreasuryStableExposureHistory(db, syncStartSec, entities);
    await recordOutcomeSafe(db, CIRCUIT_SOURCE.SIM_BALANCES, true);

    return {
      itemCount: entities.length,
      metadata: JSON.stringify({
        entityCount: entities.length,
        ownerChainTuples: snapshot.coverage.launchOwnerChainTuples,
        comparableEntityCount: snapshot.coverage.comparableEntityCount,
        partialEntityCount: snapshot.coverage.partialEntityCount,
        invalidEntityCount: snapshot.coverage.invalidEntityCount,
        supplementedEntityCount: snapshot.coverage.supplementedEntityCount,
        historyRowsWritten,
      }),
    };
  } catch (error) {
    await recordOutcomeSafe(db, CIRCUIT_SOURCE.SIM_BALANCES, false);
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        reason: "snapshot-build-failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

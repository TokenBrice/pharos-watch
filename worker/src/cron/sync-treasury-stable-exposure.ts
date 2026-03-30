import { TREASURY_LAUNCH_SEEDS, TREASURY_SEEDS } from "@shared/lib/treasury-seeds";
import {
  buildTreasuryStableExposureSnapshot,
  computeTreasuryStableExposureEntity,
} from "@shared/lib/treasury-stable-exposure";
import { CHAIN_META } from "@shared/lib/chains";
import { setCacheIfNewer, shouldSkipFreshCache } from "../lib/db-cache";
import type { CronResult } from "../lib/cron-logger";
import { buildReportCardsSnapshot } from "../lib/report-cards-snapshot";
import { shouldAttemptFetch, recordOutcomeSafe } from "../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../lib/constants";
import { fetchSimWalletBalances } from "../lib/sim-balances";

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
    const entities = [];

    for (const seed of TREASURY_LAUNCH_SEEDS) {
      const groupedOwners = groupOwners(seed.name, seed.owners);
      const walletSnapshots = [];

      for (const owner of groupedOwners) {
        const [treasuryBalances, stablecoinBalances] = await Promise.all([
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
        ]);

        walletSnapshots.push({
          treasuryBalances: treasuryBalances.balances,
          stablecoinBalances: stablecoinBalances.balances,
          warnings: [...treasuryBalances.warnings, ...stablecoinBalances.warnings],
        });
      }

      entities.push(computeTreasuryStableExposureEntity(seed, walletSnapshots, reportCardsSnapshot.cards));
    }

    entities.sort((a, b) => {
      const decentralizedDiff = b.decentralizedStableUsd - a.decentralizedStableUsd;
      if (decentralizedDiff !== 0) return decentralizedDiff;
      const pctDiff = (b.decentralizedStablePctOfTreasury ?? -1) - (a.decentralizedStablePctOfTreasury ?? -1);
      if (pctDiff !== 0) return pctDiff;
      return a.name.localeCompare(b.name);
    });

    const snapshot = buildTreasuryStableExposureSnapshot(TREASURY_SEEDS, entities, syncStartSec);
    await setCacheIfNewer(db, CACHE_KEY, JSON.stringify(snapshot), syncStartSec);
    await recordOutcomeSafe(db, CIRCUIT_SOURCE.SIM_BALANCES, true);

    return {
      itemCount: entities.length,
      metadata: JSON.stringify({
        entityCount: entities.length,
        ownerChainTuples: snapshot.coverage.launchOwnerChainTuples,
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

import type { PriceValidationReferences } from "../../lib/price-validation";
import type { DexPriceObs } from "../dex-liquidity/types";
import type { StagedPool } from "./types";

export const DISCOVERY_STAGE_TIMEOUT_MS = {
  cgOnchain: 8_000,
  geckoTerminal: 8_000,
  dexscreener: 6_000,
  cgTickers: 6_000,
} as const;

export type StagedPriceObservation = DexPriceObs & { stablecoinId: string };

export interface CrawlStageContext {
  stablecoinId: string;
  knownPoolIds: Set<string>;
  nowSec: number;
  pools: StagedPool[];
  priceObs: StagedPriceObservation[];
  signal?: AbortSignal;
  deadlineMs?: number;
  references?: PriceValidationReferences;
  timeExceeded(): boolean;
  buildStageSignal(timeoutMs: number): AbortSignal;
  hasKnownPool(poolId: string): boolean;
  knownPoolIdsForStablecoin(): Set<string>;
  addPool(pool: StagedPool): void;
  addPriceObs(obs: StagedPriceObservation): void;
}

interface CreateCrawlStageContextOptions {
  stablecoinId: string;
  knownPoolIds: Set<string>;
  nowSec: number;
  pools: StagedPool[];
  priceObs: StagedPriceObservation[];
  signal?: AbortSignal;
  deadlineMs?: number;
  references?: PriceValidationReferences;
}

type StagedPoolFields = Omit<StagedPool, "stablecoinId" | "discoveredAt" | "refreshedAt">;

export function knownPoolIdKey(stablecoinId: string, poolId: string): string {
  return `${stablecoinId}:${poolId}`;
}

function hasKnownPoolId(knownPoolIds: Set<string>, stablecoinId: string, poolId: string): boolean {
  return knownPoolIds.has(knownPoolIdKey(stablecoinId, poolId));
}

function rememberKnownPoolId(knownPoolIds: Set<string>, stablecoinId: string, poolId: string): void {
  knownPoolIds.add(knownPoolIdKey(stablecoinId, poolId));
}

function collectKnownPoolIdsForStablecoin(knownPoolIds: Set<string>, stablecoinId: string): Set<string> {
  const prefix = `${stablecoinId}:`;
  const poolIds = new Set<string>();
  for (const key of knownPoolIds) {
    if (key.startsWith(prefix)) {
      poolIds.add(key.slice(prefix.length));
    }
  }
  return poolIds;
}

export function buildStageSignal(
  signal: AbortSignal | undefined,
  deadlineMs: number | undefined,
  timeoutMs: number,
): AbortSignal {
  const remainingMs = deadlineMs == null ? timeoutMs : Math.max(1, Math.min(timeoutMs, deadlineMs - Date.now()));
  const timeout = AbortSignal.timeout(remainingMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function createCrawlStageContext({
  stablecoinId,
  knownPoolIds,
  nowSec,
  pools,
  priceObs,
  signal,
  deadlineMs,
  references,
}: CreateCrawlStageContextOptions): CrawlStageContext {
  return {
    stablecoinId,
    knownPoolIds,
    nowSec,
    pools,
    priceObs,
    signal,
    deadlineMs,
    references,
    timeExceeded: () => !!deadlineMs && Date.now() >= deadlineMs,
    buildStageSignal: (timeoutMs) => buildStageSignal(signal, deadlineMs, timeoutMs),
    hasKnownPool: (poolId) => hasKnownPoolId(knownPoolIds, stablecoinId, poolId),
    knownPoolIdsForStablecoin: () => collectKnownPoolIdsForStablecoin(knownPoolIds, stablecoinId),
    addPool(pool) {
      pools.push(pool);
      rememberKnownPoolId(knownPoolIds, stablecoinId, pool.poolId);
    },
    addPriceObs(obs) {
      priceObs.push(obs);
    },
  };
}

export function toStagedPool(
  context: Pick<CrawlStageContext, "stablecoinId" | "nowSec">,
  fields: StagedPoolFields,
): StagedPool {
  return {
    ...fields,
    stablecoinId: context.stablecoinId,
    discoveredAt: context.nowSec,
    refreshedAt: context.nowSec,
  };
}

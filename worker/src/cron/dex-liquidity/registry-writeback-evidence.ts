import { getCurveCompositePolicy } from "@shared/lib/curve-composite-policies";
import { HOUR_SECONDS } from "@shared/lib/time-constants";
import { canonicalExitRouteScopedKey } from "@shared/types/exit-route-identity";
import { parseJsonObject } from "../../lib/json-parse";
import type { StagedPool } from "../dex-discovery/types";
import type { PoolEntry } from "./types";

export function isCurveWriteback(row: Pick<StagedPool, "source" | "protocol" | "dexId">): boolean {
  return row.source === "dl" && (row.protocol === "curve" || row.dexId === "curve");
}

export function isPancakeV3Writeback(row: Pick<StagedPool, "source" | "poolType">): boolean {
  return row.source === "direct_api" && row.poolType?.startsWith("pancakeswap-v3") === true;
}

function isSundaeSwapPool(row: Pick<StagedPool, "source">): boolean {
  return row.source === "sundaeswap";
}

export function checkedRegistryClock(clock: unknown, readAt: number): number | null {
  return typeof clock === "number" && Number.isSafeInteger(clock) && clock > 0 && clock <= readAt ? clock : null;
}

function checkedHourlyWindowEnd(clock: unknown, readAt: number): number | null {
  const second = checkedRegistryClock(clock, readAt);
  return second != null && second % HOUR_SECONDS === 0 ? second : null;
}

export const checkedPancakeWindowEnd = checkedHourlyWindowEnd;

export function checkedCurveOverlap(
  chain: string, poolId: string, tvlUsd: number | null, evidence: unknown,
): PoolEntry["curveBasePoolOverlap"] {
  if (!evidence || typeof evidence !== "object" || tvlUsd == null || !Number.isFinite(tvlUsd)) return undefined;
  const { basePoolKey, lpLegTvlUsd } = evidence as Record<string, unknown>;
  if (
    typeof basePoolKey !== "string" || typeof lpLegTvlUsd !== "number" ||
    !Number.isFinite(lpLegTvlUsd) || lpLegTvlUsd <= 0 || lpLegTvlUsd > tvlUsd
  ) return undefined;
  const address = poolId.slice(poolId.indexOf(":") + 1);
  const policy = getCurveCompositePolicy(chain, address);
  if (
    policy?.quoteFunction !== "get_dy_underlying" ||
    canonicalExitRouteScopedKey(chain, policy.metapool.basePoolAddress) !== basePoolKey
  ) return undefined;
  return { basePoolKey, lpLegTvlUsd };
}

export function getRegistryPriceObservedAt(row: StagedPool): number | null {
  if (isCurveWriteback(row)) {
    return checkedRegistryClock(parseJsonObject(row.rawJson)?.curvePriceObservedAtSec, row.refreshedAt);
  }
  return row.source === "horizon" ? getHorizonValuationAt(row.rawJson, row.refreshedAt) : row.refreshedAt;
}

export function getHorizonValuationAt(raw: string | null, readAt: number): number | null {
  const valuation = parseJsonObject(raw)?.valuation as { kind?: unknown; observedAtSec?: unknown } | undefined;
  return valuation?.kind === "market" ? checkedRegistryClock(valuation.observedAtSec, readAt) : null;
}

export function getRegistryVolumeObservedAt(row: StagedPool): number | null {
  if (isPancakeV3Writeback(row)) {
    return checkedHourlyWindowEnd(parseJsonObject(row.rawJson)?.pancakeV3VolumeWindowEndSec, row.refreshedAt);
  }
  if (isSundaeSwapPool(row)) {
    return checkedHourlyWindowEnd(parseJsonObject(row.rawJson)?.sundaeswapVolumeWindowEndSec, row.refreshedAt);
  }
  return row.refreshedAt;
}

export function getRegistryCurveOverlap(row: StagedPool): PoolEntry["curveBasePoolOverlap"] {
  return isCurveWriteback(row)
    ? checkedCurveOverlap(row.chain, row.poolId, row.tvlUsd, parseJsonObject(row.rawJson)?.curveBasePoolOverlap)
    : undefined;
}

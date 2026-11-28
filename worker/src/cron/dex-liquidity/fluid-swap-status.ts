import { FLUID_SWAP_STATUS_MAX_AGE_SEC, unknownFluidSwapStatus } from "@shared/lib/fluid-swap-status";
import { canonicalEvmAddress } from "@shared/lib/evm-address";
import { canonicalExitRouteAssetKey, canonicalExitRouteChain } from "@shared/types/exit-route-identity";
import type { FluidSwapStatus } from "@shared/types/dex-liquidity";
import type { DexApiFetchResult } from "../../lib/dex-api-types";
import { buildPoolFingerprint } from "./pool-normalization";
import type { PoolEntry, SourcePoolGraph } from "./types";

export type FluidSwapStatusIndex = NonNullable<DexApiFetchResult["fluidSwapStatuses"]>;
const FLUID_NATIVE_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const LLAMA_NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";
const addressOf = (value: unknown) => canonicalEvmAddress(value, { allowZero: false });

function tokenFingerprint(chain: string, tokens: unknown): string | null {
  if (!Array.isArray(tokens) || tokens.length !== 2) return null;
  const [a, b] = tokens.map((value) => {
    const address = canonicalEvmAddress(value);
    return address === FLUID_NATIVE_TOKEN ? LLAMA_NATIVE_TOKEN : address;
  });
  return a && b && a !== b ? buildPoolFingerprint(chain, "fluid", [a, b]) : null;
}

/** A direct read of the venue's current-state endpoint. lastUpdateTimestamp is its last price change. */
export function indexFluidSwapStatuses(
  index: FluidSwapStatusIndex, chain: string, payload: unknown, checkedAtSec: number,
): void {
  if (!Array.isArray(payload)) throw new Error("Fluid swap state index was not an array");
  for (const row of payload) {
    const poolAddress = addressOf(row?.address);
    if (!poolAddress) continue;
    const key = canonicalExitRouteAssetKey(chain, poolAddress);
    const fingerprint = tokenFingerprint(chain, [row.token0Address, row.token1Address]);
    const paused = row.state?.isSwapAndArbitragePaused;
    const clock = { checkedAtSec, maxAgeSec: FLUID_SWAP_STATUS_MAX_AGE_SEC, poolAddress };
    const observation: FluidSwapStatus = index.has(key)
      ? unknownFluidSwapStatus("fluid-swap-state-conflicting", poolAddress, checkedAtSec)
      : paused === true ? { status: "paused", reason: "fluid-swaps-paused", ...clock }
        : paused === false ? { status: "active", reason: "fluid-swaps-active", ...clock }
          : unknownFluidSwapStatus("fluid-swap-state-missing", poolAddress, checkedAtSec);
    index.set(key, { observation, fingerprint });
  }
}

/** DefiLlama's pool_old and poolTokenAddress must name the same Fluid deployment. */
export function indexFluidDefiLlamaAliases(index: FluidSwapStatusIndex, payload: unknown): void {
  if (!payload || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data)) {
    throw new Error("Fluid DefiLlama alias index was not an array");
  }
  const uuids = new Set<string>();
  const physicalKeys = new Set<string>();
  const ambiguous = new Set<string>();
  for (const row of payload.data) {
    if (typeof row?.pool !== "string" || row.project !== "fluid-dex" || typeof row.chain !== "string") continue;
    const chain = canonicalExitRouteChain(row.chain);
    const key = `${chain}:defillama:${row.pool}`;
    if (uuids.has(row.pool)) ambiguous.add(row.pool);
    uuids.add(row.pool);
    const oldId = typeof row.pool_old === "string" ? row.pool_old.split("-") : [];
    const address = addressOf(oldId[1]);
    if (oldId.length !== 2 || canonicalExitRouteChain(oldId[0]!) !== chain || !address) continue;
    const physicalKey = canonicalExitRouteAssetKey(chain, address);
    if (physicalKeys.has(physicalKey)) ambiguous.add(physicalKey);
    physicalKeys.add(physicalKey);
    if (addressOf(row.poolTokenAddress) !== address) continue;
    const physical = index.get(physicalKey);
    if (physical?.fingerprint && physical.fingerprint === tokenFingerprint(chain, row.underlyingTokens)) {
      index.set(key, physical);
    }
  }
  for (const [key, item] of index) {
    const [chain, namespace, uuid] = key.split(":");
    if (namespace === "defillama" && (ambiguous.has(uuid!) ||
      (item.observation.poolAddress && ambiguous.has(canonicalExitRouteAssetKey(chain!, item.observation.poolAddress))))) {
      index.delete(key);
    }
  }
}

export function attachFluidSwapStatuses(metrics: ReadonlyMap<string, SourcePoolGraph>, index?: FluidSwapStatusIndex): void {
  for (const graph of metrics.values()) {
    for (const pool of graph.pools) {
      if (pool.project !== "fluid") continue;
      const alias = pool.poolId.includes(":defillama:");
      const entry = index?.get(pool.poolId);
      const chain = canonicalExitRouteChain(pool.chain);
      const prefix = `fp:${chain}:fluid:`;
      const fingerprint = pool.candidateFingerprint;
      const verified = entry && (!alias || (entry.fingerprint && fingerprint?.startsWith(prefix) &&
        entry.fingerprint === tokenFingerprint(chain, fingerprint.slice(prefix.length).split(":"))));
      pool.extra ??= {};
      pool.extra.fluidSwapStatus = verified ? entry.observation
        : unknownFluidSwapStatus(alias ? "fluid-pool-identity-unverified" : "fluid-swap-state-missing");
    }
  }
}

export function poolSwapsUsable(pool: PoolEntry): boolean {
  return pool.project !== "fluid" || pool.extra?.fluidSwapStatus?.status === "active";
}

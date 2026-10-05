import { canonicalExitRouteAssetKey, canonicalExitRouteChain } from "@shared/types/exit-route-identity";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { convertToGtNewPools, type DexApiPool } from "../../lib/dex-api-common";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { isDexApiRecord } from "./direct-api-json";
import { runPaginatedDirectApiFetch } from "./direct-api-paginated";
import { normalizeProtocol } from "./pool-helpers";
import type { LiquidityMetrics, SymbolLookups } from "./types";

const RAYDIUM_STANDARD_PROGRAMS: Record<string, true> = {
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": true,
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C": true,
};
const LEGACY_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** /info/ids proves native identity/type; a provider's cg-amm label never proves a CP invariant. */
export function parseRaydiumStandardDiscoveryPool(raw: unknown): DexApiPool | null {
  if (!isDexApiRecord(raw) || raw.type !== "Standard" || typeof raw.programId !== "string" ||
    !RAYDIUM_STANDARD_PROGRAMS[raw.programId] || typeof raw.id !== "string" ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw.id) || raw.hasDynamicFee === true) return null;
  if (isDexApiRecord(raw.config) && typeof raw.config.creatorFeeRate === "number" && raw.config.creatorFeeRate > 0) return null;
  if (raw.programId === "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C" &&
    (raw.hasDynamicFee !== false || !isDexApiRecord(raw.config) || raw.config.creatorFeeRate !== 0)) return null;
  const mints = [raw.mintA, raw.mintB];
  if (mints.some((mint) => !isDexApiRecord(mint) || mint.programId !== LEGACY_TOKEN_PROGRAM ||
    typeof mint.address !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint.address) ||
    typeof mint.symbol !== "string" || !mint.symbol.trim() || !Number.isInteger(mint.decimals) ||
    Number(mint.decimals) < 0 || Number(mint.decimals) > 18)) return null;
  const mintA = raw.mintA as Record<string, unknown>;
  const mintB = raw.mintB as Record<string, unknown>;
  if (mintA.address === mintB.address || typeof raw.tvl !== "number" || !Number.isFinite(raw.tvl) || raw.tvl <= 0 ||
    typeof raw.feeRate !== "number" || !Number.isFinite(raw.feeRate) || raw.feeRate < 0 || raw.feeRate >= 1 ||
    typeof raw.mintAmountA !== "number" || !Number.isFinite(raw.mintAmountA) || raw.mintAmountA <= 0 ||
    typeof raw.mintAmountB !== "number" || !Number.isFinite(raw.mintAmountB) || raw.mintAmountB <= 0) return null;
  return {
    source: "raydium", chain: "solana", poolAddress: raw.id, poolType: "raydium-amm",
    tokens: [mintA, mintB].map((mint) => ({ address: String(mint.address), symbol: String(mint.symbol), decimals: Number(mint.decimals) })),
    price: typeof raw.price === "number" && Number.isFinite(raw.price) && raw.price > 0 ? raw.price : null,
    tvlUsd: raw.tvl, feeRate: raw.feeRate, balances: [raw.mintAmountA, raw.mintAmountB], balancesNormalized: true,
    volume24hUsd: isDexApiRecord(raw.day) && typeof raw.day.volume === "number" && Number.isFinite(raw.day.volume) && raw.day.volume >= 0 ? raw.day.volume : null,
  };
}

export async function enrichRaydiumStandardDiscoveryExecutionModels(input: {
  metrics: Map<string, LiquidityMetrics>;
  chainAddressToId: SymbolLookups["chainAddressToId"];
  stablecoinPriceById: Map<string, number>;
  validationReferences?: PriceValidationReferences;
  signal?: AbortSignal;
  deadlineMs: number;
}): Promise<void> {
  const references = new Map<string, Array<{ stablecoinId: string; pool: LiquidityMetrics["topPools"][number] }>>();
  for (const [stablecoinId, metric] of input.metrics) {
    for (const pool of metric.topPools) {
      if (canonicalExitRouteChain(pool.chain) !== "solana" || normalizeProtocol(pool.project) !== "raydium" ||
        pool.poolType !== "cg-amm" || pool.extra?.ammExecutionModel) continue;
      const address = pool.poolId.startsWith("solana:") ? pool.poolId.slice(7) : "";
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) continue;
      const rows = references.get(address) ?? [];
      rows.push({ stablecoinId, pool }); references.set(address, rows);
    }
  }
  const ids = [...references.keys()];
  for (let start = 0; start < ids.length; start += 20) {
    throwIfAborted(input.signal);
    if (Date.now() >= input.deadlineMs) break;
    const batch = ids.slice(start, start + 20);
    try {
      const response = await runPaginatedDirectApiFetch<DexApiPool>({
        source: "raydium-standard-identity", buildUrl: () => `https://api-v3.raydium.io/pools/info/ids?ids=${batch.join(",")}`,
        pageSize: batch.length + 1, maxPages: 1, maxResponseBytes: 512 * 1024,
        timeoutMs: Math.min(15_000, input.deadlineMs - Date.now()), signal: input.signal,
        parsePage: (body) => isDexApiRecord(body) && body.success === true && Array.isArray(body.data) ? body.data : { error: "Raydium identity response unavailable" },
        mapRow: parseRaydiumStandardDiscoveryPool,
      });
      const unique = new Map<string, DexApiPool>();
      const ambiguous = new Set<string>();
      for (const pool of response.rows) {
        if (!references.has(pool.poolAddress) || !batch.includes(pool.poolAddress)) continue;
        if (unique.has(pool.poolAddress)) { ambiguous.add(pool.poolAddress); unique.delete(pool.poolAddress); }
        else if (!ambiguous.has(pool.poolAddress)) unique.set(pool.poolAddress, pool);
      }
      for (const [address, pool] of unique) {
        // Resolve token identity by canonical mint only: symbol fallback is not an exact join.
        const nativeAssets = pool.tokens.map((token) => input.chainAddressToId.get(canonicalExitRouteAssetKey("solana", token.address)));
        const shaped = convertToGtNewPools([pool], input.chainAddressToId, new Map(), input.validationReferences, input.stablecoinPriceById);
        for (const reference of references.get(address)!) {
          if (references.get(address)!.filter((row) => row.stablecoinId === reference.stablecoinId).length !== 1) continue;
          if (nativeAssets.filter((id) => id === reference.stablecoinId).length !== 1) continue;
          const candidates = shaped.get(reference.stablecoinId)?.filter((row) => row.address === address) ?? [];
          if (candidates.length !== 1 || !candidates[0]!.ammExecutionModel) continue;
          reference.pool.extra = { ...(reference.pool.extra ?? {}), ammExecutionModel: candidates[0]!.ammExecutionModel };
          delete reference.pool.extra.executionCapabilityGate;
        }
      }
    } catch (error) {
      rethrowIfAborted(error, input.signal);
      // Failed metadata does not change a discovery-shaped row into an exact claim.
    }
  }
}

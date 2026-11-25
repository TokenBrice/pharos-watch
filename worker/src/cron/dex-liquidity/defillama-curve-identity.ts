import { canonicalEvmAddress } from "@shared/lib/evm-address";
import { canonicalExitRouteChain } from "@shared/types/exit-route-identity";
import { CURVE_API_CHAIN_PATHS } from "./constants";
import type { LlamaPool } from "./types";

export const DEFILLAMA_CURVE_IDENTITIES_URL =
  "https://yields.llama.fi/poolsPro?project=curve-dex";
const DEFILLAMA_CURVE_IDENTITIES_MAX_ROWS = 2_000;
export const DEFILLAMA_CURVE_IDENTITIES_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const DEFILLAMA_CURVE_IDENTITIES_TIMEOUT_MS = 10_000;

function curveTokenSet(value: unknown): string | null {
  if (!Array.isArray(value) || value.length < 2 || value.length > 8) return null;
  const tokens = value.map((token) => canonicalEvmAddress(token));
  if (tokens.some((token) => token === null)) return null;
  const normalized = tokens as string[];
  normalized.sort();
  return new Set(normalized).size === normalized.length ? normalized.join(":") : null;
}

/** Enrich identity only: the list endpoint remains the authority for all pool measurements. */
export function attachDefiLlamaCurvePoolIdentities(pools: LlamaPool[], payload: unknown): number {
  if (!payload || typeof payload !== "object" || !("data" in payload)) return 0;
  const rows = payload.data;
  if (!Array.isArray(rows) || rows.length > DEFILLAMA_CURVE_IDENTITIES_MAX_ROWS) return 0;

  const byUuid = new Map<string, { poolAddress: string; tokens: string; chain: string } | null>();
  const uuidsByPhysicalKey = new Map<string, Set<string>>();

  for (const row of rows) {
    if (!row || typeof row !== "object" || typeof row.pool !== "string" || row.pool.trim().length === 0) {
      continue;
    }
    const uuid = row.pool;
    const rawChain = typeof row.chain === "string" ? row.chain.trim() : "";
    const canonicalChain = rawChain.length > 0 ? canonicalExitRouteChain(rawChain) : "";
    const match = typeof row.pool_old === "string"
      ? /^(0x[0-9a-f]{40})-([a-z0-9_-]+)$/i.exec(row.pool_old)
      : null;
    const expectedSuffix = canonicalChain.length > 0
      ? (CURVE_API_CHAIN_PATHS[canonicalChain] ?? canonicalChain)
      : "";
    const poolAddress = match ? match[1]!.toLowerCase() : null;
    const chainSuffixMatches =
      canonicalChain.length > 0 && match != null && match[2]!.toLowerCase() === expectedSuffix;

    if (row.project === "curve-dex" && poolAddress != null && chainSuffixMatches) {
      const physicalKey = `${canonicalChain}:${poolAddress}`;
      const claimants = uuidsByPhysicalKey.get(physicalKey) ?? new Set<string>();
      claimants.add(uuid);
      uuidsByPhysicalKey.set(physicalKey, claimants);
    }

    if (byUuid.has(uuid)) {
      byUuid.set(uuid, null);
      continue;
    }

    const poolTokenAddressOk =
      typeof row.poolTokenAddress !== "string" ||
      row.poolTokenAddress.trim().length === 0 ||
      canonicalEvmAddress(row.poolTokenAddress) === poolAddress;
    const tokens = curveTokenSet(row.underlyingTokens);

    byUuid.set(
      uuid,
      row.project === "curve-dex" &&
        poolAddress != null &&
        chainSuffixMatches &&
        poolTokenAddressOk &&
        tokens != null
        ? { poolAddress, tokens, chain: canonicalChain }
        : null,
    );
  }

  for (const claimants of uuidsByPhysicalKey.values()) {
    if (claimants.size > 1) {
      for (const uuid of claimants) {
        byUuid.set(uuid, null);
      }
    }
  }

  let attached = 0;
  for (const pool of pools) {
    if (pool.project !== "curve-dex") continue;
    const identity = byUuid.get(pool.pool);
    if (
      !identity ||
      identity.chain !== canonicalExitRouteChain(pool.chain) ||
      identity.tokens !== curveTokenSet(pool.underlyingTokens)
    ) {
      continue;
    }
    pool.pool = identity.poolAddress;
    attached++;
  }
  return attached;
}

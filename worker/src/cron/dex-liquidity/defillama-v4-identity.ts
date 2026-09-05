import type { LlamaPool } from "./types";

export const DEFILLAMA_V4_IDENTITIES_URL =
  "https://yields.llama.fi/poolsPro?project=uniswap-v4";

function tokenSet(value: unknown): string | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  if (!value.every((token) => typeof token === "string" && /^0x[0-9a-f]{40}$/i.test(token))) return null;
  const tokens = value.map((token: string) => token.toLowerCase()).sort();
  return tokens[0] !== tokens[1] ? tokens.join(":") : null;
}

/** Enrich identity only: the list endpoint remains the authority for all pool measurements. */
export function attachDefiLlamaV4PoolIdentities(pools: LlamaPool[], payload: unknown): number {
  if (!payload || typeof payload !== "object" || !("data" in payload)) return 0;
  const rows = payload.data;
  if (!Array.isArray(rows) || rows.length > 2_000) return 0;
  const byUuid = new Map<string, { poolId: string; tokens: string } | null>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || typeof row.pool !== "string") continue;
    if (byUuid.has(row.pool)) {
      byUuid.set(row.pool, null);
      continue;
    }
    const tokens = tokenSet(row.underlyingTokens);
    const match = typeof row.pool_old === "string"
      ? /^(0x[0-9a-f]{64})-ethereum-uniswap-v4$/i.exec(row.pool_old)
      : null;
    byUuid.set(row.pool,
      row.project === "uniswap-v4" && row.chain === "Ethereum" && match && tokens
        ? { poolId: match[1]!.toLowerCase(), tokens }
        : null,
    );
  }
  let attached = 0;
  for (const pool of pools) {
    if (pool.project !== "uniswap-v4" || pool.chain.toLowerCase() !== "ethereum") continue;
    const identity = byUuid.get(pool.pool);
    if (!identity || identity.tokens !== tokenSet(pool.underlyingTokens)) continue;
    pool.pool = identity.poolId;
    attached++;
  }
  return attached;
}

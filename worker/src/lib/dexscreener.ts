/**
 * DexScreener token pools API wrapper.
 * Used as a universal fallback for pool discovery on chains not covered
 * by the main CG/GT/Curve/UniV3 pipeline.
 */
import { fetchWithRetry } from "./fetch-retry";
import { USER_AGENT } from "./constants";

const DS_TOKEN_API = "https://api.dexscreener.com/tokens/v1";
const DS_RATE_LIMIT_MS = 1100; // ~60 req/min free tier

/** Map our chain names → DexScreener chain IDs */
export const DS_CHAIN_MAP: Record<string, string> = {
  ethereum: "ethereum",
  base: "base",
  arbitrum: "arbitrum",
  polygon: "polygon",
  bsc: "bsc",
  avalanche: "avalanche",
  optimism: "optimism",
  solana: "solana",
  berachain: "berachain",
  sui: "sui",
  fantom: "fantom",
  celo: "celo",
  gnosis: "gnosis",
  tron: "tron",
  ink: "ink",
  sonic: "sonic",
  mantle: "mantle",
  linea: "linea",
  scroll: "scroll",
  blast: "blast",
  zksync: "zksync",
  mode: "mode",
  sei: "sei",
  manta: "manta",
  monad: "monad",
  plume: "plume",
  hyperevm: "hyperevm",
  bob: "bob",
  unichain: "unichain",
  soneium: "soneium",
  worldchain: "worldchain",
  taiko: "taiko",
};

/** Response shape from GET /tokens/v1/{chainId}/{address} */
export interface DsPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  labels?: string[];
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd: string | null;
  volume: { h24: number; h6: number; h1: number; m5: number } | null;
  liquidity: { usd: number; base: number; quote: number } | null;
  pairCreatedAt: number | null;
}

/**
 * Fetch all pools for a token on a specific chain from DexScreener.
 * Returns an array of pairs, or empty if the request fails.
 */
export async function fetchDsTokenPools(
  chain: string,
  tokenAddress: string,
): Promise<DsPair[]> {
  const dsChain = DS_CHAIN_MAP[chain];
  if (!dsChain) return [];

  const url = `${DS_TOKEN_API}/${dsChain}/${tokenAddress}`;
  const res = await fetchWithRetry(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res?.ok) return [];

  try {
    const data = (await res.json()) as DsPair[] | null;
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** Rate-limit sleep between DexScreener calls */
export function dsRateLimit(): Promise<void> {
  return new Promise((r) => setTimeout(r, DS_RATE_LIMIT_MS));
}

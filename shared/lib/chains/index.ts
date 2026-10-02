import { CHAIN_META, type ChainProviders } from "../../types/chain-identity";


/**
 * Chain resilience tier — measures the chain's own infrastructure quality,
 * decentralization, and censorship resistance.
 *
 * Tier 1: Highly decentralized, battle-tested, censorship-resistant L1s.
 * Tier 2: Established chains with moderate centralization (default for unlisted).
 * Tier 3: Newer/unproven chains, or chains with known centralization or reputation issues.
 */
export type ChainResilienceTier = 1 | 2 | 3;

const CHAIN_RESILIENCE_TIER: Partial<Record<string, ChainResilienceTier>> = {
  // Tier 1 — gold standard for decentralization & censorship resistance
  ethereum: 1,

  // Established non-EVM settlement chain; Scilla deployments use native readers.
  zilliqa: 2,

  // Tier 3 — known issues, high centralization, or unproven security
  pulsechain: 3,
  harmony: 3,       // compromised bridge, degraded security
  bittorrent: 3,    // highly centralized
  songbird: 3,      // canary network
  moonriver: 3,     // canary network
  plasma: 3,        // very new, minimal validation
  tempo: 3,         // new payment-focused L1
  viction: 3,       // low activity, centralized
  codex: 3,         // new payment-focused L1
  pharos: 3,        // new high-performance L1
  edgechain: 3,     // exchange-adjacent financial chain
  robinhood: 3,     // new exchange-adjacent L2 (mainnet 2026-07)
  stable: 3,        // new USDT-focused chain
  bevm: 3,          // newer BTC-aligned L2
  arc: 3,           // new PoA-validator L1 from Circle

  // Everything else defaults to tier 2 via getChainResilienceTier()
};

/** Get the resilience tier for a chain (defaults to 2). */
export function getChainResilienceTier(chainId: string): ChainResilienceTier {
  return CHAIN_RESILIENCE_TIER[chainId] ?? 2;
}


/**
 * Every chain that has a `CHAIN_META` entry, sorted.
 *
 * Membership means "has chain metadata" — not "has provider registration or
 * tracked supply". `aggregateChains` skips any chain whose tracked supply is
 * zero, so these IDs also back static `/chains/<id>/` pages and sitemap entries
 * that can render a no-tracked-supply state.
 */
export function getActiveChainIds(): string[] {
  return Object.keys(CHAIN_META).sort();
}

/* ─── Provider Network Slug Maps ───────────────────────────── */

type ChainProvider = keyof ChainProviders;

function buildProviderChainMap(provider: ChainProvider): Record<string, string> {
  return Object.fromEntries(
    Object.entries(CHAIN_META)
      .filter(([, meta]) => meta.providers?.[provider])
      .map(([chain, meta]) => [chain, meta.providers![provider]!]),
  );
}


function subtractChainMaps(
  baseMap: Record<string, string>,
  excludeMap: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(baseMap).filter(([chain]) => !excludeMap[chain]),
  );
}

/** Our chain name -> CoinGecko onchain network ID. */
export const CG_CHAIN_MAP: Record<string, string> = buildProviderChainMap("coingecko");


/** Our chain name -> DexScreener chain ID. */
export const DS_CHAIN_MAP: Record<string, string> = buildProviderChainMap("dexscreener");

/** Our chain name -> GeckoTerminal network ID. */
export const GT_CHAIN_MAP: Record<string, string> = buildProviderChainMap("geckoTerminal");

/** GeckoTerminal-only canonical chains used as a primary backfill when CG onchain is enabled. */
export const GT_ONLY_CHAIN_MAP: Record<string, string> = subtractChainMaps(GT_CHAIN_MAP, CG_CHAIN_MAP);

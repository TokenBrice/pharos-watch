import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

// Versioning convention (see compareMethodologyVersions in
// @shared/lib/methodology-versions/base): each dotted segment is compared as an
// INTEGER, so the minor segment is an open-ended integer counter within the v6
// bucket, e.g. `6.0` ([6, 0]) < `6.1` ([6, 1]) < `6.11` ([6, 11]). Routine
// liquidity-score changes bump the minor counter and stay in this file; create
// a `v7.ts` only for a genuine major/breaking methodology change. Entries below
// are newest-first by version.
export const LIQUIDITY_SCORE_V6: readonly MethodologyChangelogEntry[] = [
  {
    version: "6.3",
    title: "Curve physical-pool alias normalization",
    date: "2026-09-01",
    effectiveAt: 1788220800,
    summary:
      "Curve registry aliases for one physical pool now collapse by canonical chain and address before coin-set ambiguity is evaluated, allowing the reviewed LUSD/3Crv execution target to enter measurement without weakening collision handling.",
    impact: [
      "When Curve exposes the same pool address through multiple registry views, the latest address-key representation replaces the earlier alias in the fingerprint candidate set instead of being counted as a second physical pool",
      "Distinct pool addresses with the same token-set fingerprint remain ambiguous and fail closed, preserving the address-grade identity requirement",
      "The LUSD/3Crv DeFiLlama UUID row can now join its reviewed physical pool and publish the v6.2 exact get_dy_underlying target; aggregate DEX TVL and Liquidity Score formulas are unchanged",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.2",
    title: "Exact LUSD/3Crv metapool execution",
    date: "2026-09-01",
    effectiveAt: 1788220800,
    summary:
      "The reviewed LUSD/3Crv deployment now uses the existing exact Curve metapool adapter, replacing its unresolved execution gate with pinned on-chain get_dy_underlying measurements.",
    impact: [
      "The producer pins the Ethereum LUSD/3Crv pool, legacy factory registration at pool_list(16), shared metapool implementation, 3pool base relationship, token order, decimals, and runtime code hashes before quoting LUSD to USDC",
      "Fresh repeated measurements can make the pool score-eligible for Safety Score V9 Exit; TVL alone still provides no execution credit, and any identity, base-pool, quote, or freshness failure remains fail-closed",
      "The change adds no new RPC lane or source family and does not alter aggregate DEX TVL or the standalone Liquidity Score formula",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.1",
    title: "Family-scoped authoritative confirmation for classic v2 pools",
    date: "2026-08-21",
    effectiveAt: 1787270400,
    summary:
      "Authoritative staged-pool confirmation now follows the exact protocol family enumerated by each native source, so Slipstream-only inventories no longer veto classic Aerodrome or Velodrome v2 pools outside their coverage.",
    impact: [
      "Aerodrome and Velodrome staged pools identified as Slipstream or concentrated liquidity still require an exact id from the clean protocol-native Slipstream inventory",
      "Classic v2 Aerodrome and Velodrome pools remain eligible through exact-address CoinGecko Onchain, GeckoTerminal, or DexScreener discovery because the native Slipstream fetchers do not enumerate those pools",
      "Full-family direct inventories such as Balancer, Fluid, Raydium, Orca, and Meteora retain exact-id confirmation across every declared chain, while PancakeSwap keeps its existing v3/v4-only confirmation scope",
      "Base Dollar's launch BD/USDC Aerodrome stableswap can therefore contribute its discovered pool TVL, volume, and price instead of being mislabeled unobserved solely because an unrelated Slipstream inventory completed cleanly",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.0",
    title: "Raydium double-count correction and native measured-lane retirement",
    date: "2026-08-20",
    effectiveAt: 1787184000,
    summary:
      "DefiLlama Raydium pools are now classified from their pool metadata, collapsing the DefiLlama/direct-API double count of the same physical Solana CLMM pool, and the never-score-eligible Solana and Tron native measured-execution lanes plus the Fluid measured overlay are retired.",
    impact: [
      "DefiLlama publishes every Raydium pool under a single `raydium-amm` project label, hiding whether a pool is concentrated (CLMM); cross-source deduplication therefore admitted a DefiLlama Raydium CLMM row and the identical directly fetched pool as two pools, counting the same physical liquidity twice and scoring the DefiLlama copy with the wrong standard-AMM venue-quality weight. v6.0 classifies from DefiLlama's `poolMeta`, so the duplicate collapses to the direct-API measurement and surviving DefiLlama CLMM rows receive the correct concentrated-liquidity weight",
      "Reported DEX TVL for Raydium-exposed stablecoins decreases by the previously double-counted amount (typically 2-35% of a coin's measured TVL), and Liquidity Scores move accordingly. Observed movements at the first v6.0 publication ranged from -12 to +9 points: down where duplicate removal dominates, up where the venue-quality correction on surviving concentrated pools dominates. The old numbers overstated liquidity; no on-chain liquidity changed",
      "Because the Selector applies hard liquidity-score floors (50 for trading eligibility, 65 for the 1-hour exit-speed lane), coins near those floors moved in both directions at the first v6.0 publication (2026-08-20 08:16 UTC): USX (51 to 44) and USDS (58 to 46) crossed below the 50 trading floor, while DUSD (50 to 54) and VCHF (52 to 59) rose and stayed eligible; for them the venue-quality correction outweighed the removed duplicate TVL. USDC stays comfortably above the 65 one-hour floor, rising from 68 to 77, because reclassifying roughly $1.9B of surviving concentrated Raydium rows to the correct venue-quality weight outweighs the roughly $330M of removed duplicate TVL",
      "The never-score-eligible Solana and Tron native measured-execution lanes (Raydium CLMM, Orca Whirlpool, SunSwap V2) and the Fluid measured overlay are removed; their pools continue as shaped, capability-appropriate evidence, and Raydium, Orca, and Fluid aggregate TVL contributions are unchanged. Public `topPools` Fluid entries no longer carry `measuredExecution` or `executionCapabilityGate` (both keys remain on active EVM measured profiles), and the unreachable `native-measured-exact` capability entry is removed from the route-source capability matrix",
      "The dead pre-5.9 API fallback that reconstructed `methodologyVersion` from a row's update time is removed; stored versions pass through unchanged with no observable effect",
    ],
    commits: [],
    reconstructed: false,
  },
];

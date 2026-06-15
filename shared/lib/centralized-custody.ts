import type { StablecoinMeta } from "../types";
import { buildReserveSymbolMatcher } from "./reserve-symbol-matchers";

/**
 * Crypto assets with centralized custody (single custodian or consortium).
 * tBTC is excluded — it uses threshold cryptography (decentralized custody).
 */
export const CENTRALIZED_CUSTODY_CRYPTO = new Set([
  "WBTC", "CBBTC", "LBTC", "SOLVBTC", "BTCB", "KBTC", "ZKBTC",
]);

// Pre-compiled patterns sorted longest-first for whole-word matching
const CENTRALIZED_CRYPTO_MATCHERS = [...CENTRALIZED_CUSTODY_CRYPTO]
  .sort((a, b) => b.length - a.length)
  .map((symbol) => buildReserveSymbolMatcher(symbol));

function sliceMatchesCentralizedCrypto(name: string): boolean {
  return CENTRALIZED_CRYPTO_MATCHERS.some((matches) => matches(name));
}

/**
 * Compute the fraction (0-1) of a coin's reserves that are backed by
 * centralized-custody assets, including transitive exposure.
 *
 * Centralized-custody includes:
 * 1. Crypto assets with centralized custody (WBTC, cbBTC, etc.)
 * 2. Stablecoins classified as "centralized" or "centralized-dependent"
 * 3. Transitive: upstream "decentralized" coins' own centralized fraction
 */
type CentralizedCustodyCoin = Pick<StablecoinMeta, "id" | "reserves" | "flags">;

export function computeCentralizedCustodyFraction(
  coinId: string,
  allCoins: ReadonlyArray<CentralizedCustodyCoin>,
  visited: ReadonlySet<string> = new Set(),
  metaById: ReadonlyMap<string, CentralizedCustodyCoin> = new Map(
    allCoins.map((c) => [c.id, c]),
  ),
): number {
  if (visited.has(coinId)) return 0; // cycle guard
  const nextVisited = new Set(visited);
  nextVisited.add(coinId);

  const meta = metaById.get(coinId);
  if (!meta) return 0;

  // Coin without reserves: use governance as proxy
  if (!meta.reserves?.length) {
    const gov = meta.flags.governance;
    return gov === "centralized" || gov === "centralized-dependent" ? 1.0 : 0;
  }

  let centralizedPct = 0;
  const totalPct = meta.reserves.reduce((s, r) => s + r.pct, 0);
  if (totalPct === 0) return 0;

  for (const slice of meta.reserves) {
    // Direct centralized-custody crypto
    if (sliceMatchesCentralizedCrypto(slice.name)) {
      centralizedPct += slice.pct;
      continue;
    }

    // Linked upstream stablecoin
    if (slice.coinId) {
      const upstream = metaById.get(slice.coinId);
      if (!upstream) continue;
      const upGov = upstream.flags.governance;

      if (upGov === "centralized" || upGov === "centralized-dependent") {
        // Fully centralized upstream -> 100% of this slice is centralized
        centralizedPct += slice.pct;
      } else {
        // Decentralized upstream -> recursively compute its centralized fraction
        const upstreamFraction = computeCentralizedCustodyFraction(
          slice.coinId, allCoins, nextVisited, metaById,
        );
        centralizedPct += slice.pct * upstreamFraction;
      }
    }
  }

  return centralizedPct / totalPct;
}

import type { StablecoinMeta } from "../types";

/**
 * Crypto assets with centralized custody (single custodian or consortium).
 * tBTC is excluded — it uses threshold cryptography (decentralized custody).
 */
export const CENTRALIZED_CUSTODY_CRYPTO = new Set([
  "WBTC", "CBBTC", "LBTC", "SOLVBTC", "BTCB", "KBTC", "ZKBTC",
]);

// Pre-compiled patterns sorted longest-first for whole-word matching
const CENTRALIZED_CRYPTO_PATTERNS = [...CENTRALIZED_CUSTODY_CRYPTO]
  .sort((a, b) => b.length - a.length)
  // eslint-disable-next-line security/detect-non-literal-regexp -- patterns are built from curated in-repo ticker constants.
  .map((sym) => new RegExp(`(?:^|[^A-Z0-9])${sym}(?:[^A-Z0-9]|$)`));

function sliceMatchesCentralizedCrypto(name: string): boolean {
  const upper = name.toUpperCase();
  return CENTRALIZED_CRYPTO_PATTERNS.some((re) => re.test(upper));
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
export function computeCentralizedCustodyFraction(
  coinId: string,
  allCoins: ReadonlyArray<Pick<StablecoinMeta, "id" | "reserves" | "flags">>,
  visited: ReadonlySet<string> = new Set(),
): number {
  if (visited.has(coinId)) return 0; // cycle guard
  const nextVisited = new Set(visited);
  nextVisited.add(coinId);

  const meta = allCoins.find((c) => c.id === coinId);
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
      const upstream = allCoins.find((c) => c.id === slice.coinId);
      if (!upstream) continue;
      const upGov = upstream.flags.governance;

      if (upGov === "centralized" || upGov === "centralized-dependent") {
        // Fully centralized upstream -> 100% of this slice is centralized
        centralizedPct += slice.pct;
      } else {
        // Decentralized upstream -> recursively compute its centralized fraction
        const upstreamFraction = computeCentralizedCustodyFraction(
          slice.coinId, allCoins, nextVisited,
        );
        centralizedPct += slice.pct * upstreamFraction;
      }
    }
  }

  return centralizedPct / totalPct;
}

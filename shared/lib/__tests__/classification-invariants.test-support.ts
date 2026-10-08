import type { StablecoinMeta } from "@shared/types";
import { buildReserveSymbolMatcher } from "@shared/lib/reserve-symbol-matchers";

// The retired runtime warning no longer owns this data-only custody invariant.
// tBTC uses threshold cryptography and is intentionally not centralized custody.
const CENTRALIZED_CRYPTO_MATCHERS = [
  "WBTC", "CBBTC", "LBTC", "SOLVBTC", "BTCB", "KBTC", "ZKBTC",
]
  .sort((a, b) => b.length - a.length)
  .map((symbol) => buildReserveSymbolMatcher(symbol));

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

  // Coin without reserves: use governance as proxy.
  if (!meta.reserves?.length) {
    const gov = meta.flags.governance;
    return gov === "centralized" || gov === "centralized-dependent" ? 1.0 : 0;
  }

  let centralizedPct = 0;
  const totalPct = meta.reserves.reduce((s, r) => s + r.pct, 0);
  if (totalPct === 0) return 0;

  for (const slice of meta.reserves) {
    if (CENTRALIZED_CRYPTO_MATCHERS.some((matches) => matches(slice.name))) {
      centralizedPct += slice.pct;
      continue;
    }

    if (slice.coinId) {
      const upstream = metaById.get(slice.coinId);
      if (!upstream) continue;
      const upGov = upstream.flags.governance;

      if (upGov === "centralized" || upGov === "centralized-dependent") {
        centralizedPct += slice.pct;
      } else {
        const upstreamFraction = computeCentralizedCustodyFraction(
          slice.coinId, allCoins, nextVisited, metaById,
        );
        centralizedPct += slice.pct * upstreamFraction;
      }
    }
  }

  return centralizedPct / totalPct;
}

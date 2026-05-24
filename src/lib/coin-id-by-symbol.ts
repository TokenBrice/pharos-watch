import { CLIENT_TRACKED_STABLECOINS } from "@shared/lib/stablecoins/client-registry";

// Reverse index: uppercase symbol → canonical coin id. Only symbols that map
// unambiguously to a single tracked coin are included; ambiguous symbols
// (e.g. USDP → usdp-paxos + usdp-parallel) are dropped so callers fall back
// to a generic affordance rather than render the wrong logo.
const COIN_ID_BY_SYMBOL: ReadonlyMap<string, string> = (() => {
  const collected = new Map<string, string[]>();
  for (const meta of CLIENT_TRACKED_STABLECOINS) {
    const sym = meta.symbol?.toUpperCase();
    if (!sym) continue;
    const list = collected.get(sym) ?? [];
    list.push(meta.id);
    collected.set(sym, list);
  }
  const out = new Map<string, string>();
  for (const [sym, ids] of collected) {
    if (ids.length === 1) out.set(sym, ids[0]);
  }
  return out;
})();

export function coinIdBySymbol(symbol: string | null | undefined): string | null {
  if (!symbol) return null;
  return COIN_ID_BY_SYMBOL.get(symbol.toUpperCase()) ?? null;
}

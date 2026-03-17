import { REGISTRY_BY_ID, REGISTRY_BY_LLAMA_ID } from "@shared/lib/stablecoin-id-registry";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";

const UNIQUE_SYMBOL_TO_ID = new Map<string, string>();
const AMBIGUOUS_SYMBOLS = new Set<string>();

for (const stablecoin of ACTIVE_STABLECOINS) {
  const symbol = stablecoin.symbol.toLowerCase();
  if (UNIQUE_SYMBOL_TO_ID.has(symbol)) {
    UNIQUE_SYMBOL_TO_ID.delete(symbol);
    AMBIGUOUS_SYMBOLS.add(symbol);
    continue;
  }

  if (!AMBIGUOUS_SYMBOLS.has(symbol)) {
    UNIQUE_SYMBOL_TO_ID.set(symbol, stablecoin.id);
  }
}

export function encodeStablecoinUrlToken(canonicalId: string): string {
  return canonicalId;
}

export function decodeStablecoinUrlToken(token: string | null | undefined): string | null {
  const trimmed = token?.trim();
  if (!trimmed) return null;

  if (REGISTRY_BY_ID.has(trimmed)) {
    return trimmed;
  }

  const byLlamaId = REGISTRY_BY_LLAMA_ID.get(trimmed);
  if (byLlamaId) {
    return byLlamaId.id;
  }

  const symbol = trimmed.toLowerCase();
  if (AMBIGUOUS_SYMBOLS.has(symbol)) {
    return null;
  }

  return UNIQUE_SYMBOL_TO_ID.get(symbol) ?? null;
}

export function isAmbiguousStablecoinSymbol(token: string | null | undefined): boolean {
  const trimmed = token?.trim();
  return trimmed ? AMBIGUOUS_SYMBOLS.has(trimmed.toLowerCase()) : false;
}

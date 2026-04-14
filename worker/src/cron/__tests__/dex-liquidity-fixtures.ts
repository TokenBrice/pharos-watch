export function buildChainAddressToId(
  addressToId: Map<string, string>,
  chains: string[],
): Map<string, string> {
  const result = new Map<string, string>();
  for (const chain of chains) {
    for (const [address, stablecoinId] of addressToId) {
      result.set(`${chain.toLowerCase()}:${address.toLowerCase()}`, stablecoinId);
    }
  }
  return result;
}

export function buildSymbolToChainScopedIds(
  symbolToIds: Map<string, string[]>,
  chains: string[],
): Map<string, Map<string, string[]>> {
  const result = new Map<string, Map<string, string[]>>();
  for (const [symbol, ids] of symbolToIds) {
    const scoped = new Map<string, string[]>();
    for (const chain of chains) {
      scoped.set(chain.toLowerCase(), [...ids]);
    }
    result.set(symbol.trim().toUpperCase(), scoped);
  }
  return result;
}


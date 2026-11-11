export interface SymbolLookups {
  symbolToIds: Map<string, string[]>;
  symbolToChainScopedIds: Map<string, Map<string, string[]>>;
  chainAddressToId: Map<string, string>;
  contractMetaByChainAddress: Map<
    string,
    {
      stablecoinId: string;
      symbol: string;
      decimals: number | null;
      source: "contract" | "tradedContract";
    }
  >;
}


// Deterministic unavailable evidence: exercise planning/rejection allocations
// without inventing on-chain observations or entering provider retry loops.
export const offlineTransferMaterialityDependencies = Object.freeze({
  fetchEvmBlockNumber: async () => null,
  fetchEvmBlockHeader: async () => null,
  fetchEvmMulticall3Aggregate3AtBlock: async () => null,
  resolveClosestBlockAtOrBeforeTimestamp: async () => null,
  observeEconomicSolanaMint: async () => null,
  fetchMoveFungibleAssetSupply: async () => null,
  fetchSafetyScoreV9SolanaRpc: async () => null,
});

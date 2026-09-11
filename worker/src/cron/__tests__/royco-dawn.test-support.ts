export function makeMarket(overrides: Record<string, unknown> = {}) {
  return {
    chainId: 1, marketId: "market", name: "Apyx apyUSD", listingType: "verified", status: "normal", tvlUsd: 2_000_000,
    coverage: { currentRatio: 0.12, requiredRatio: 0.1 }, utilization: { currentRatio: 0.4, requiredRatio: 0.9 },
    drawdown: { ratio: 0 }, totalDrawdowns: 0, juniorRedemptionDelay: 0,
    seniorVault: makeVault({ address: "0x1111111111111111111111111111111111111111", apy: 0.05, tvlUsd: 100_000, depositAddress: "0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a", depositSymbol: "apyUSD", shareAddress: "0x1111111111111111111111111111111111111111" }),
    ...overrides,
  };
}

export function makeVault(params: { address: string; apy: number; tvlUsd: number; depositAddress: string; depositSymbol: string; shareAddress: string }) {
  return {
    address: params.address, name: `${params.depositSymbol} vault`, apy: params.apy, tvl: { tokenAmountUsd: params.tvlUsd },
    depositToken: { symbol: params.depositSymbol, chainId: 1, contractAddress: params.depositAddress },
    shareToken: { symbol: `roy${params.depositSymbol}`, chainId: 1, contractAddress: params.shareAddress },
  };
}

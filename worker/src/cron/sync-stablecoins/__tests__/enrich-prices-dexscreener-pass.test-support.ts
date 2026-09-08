export function exactPool(tokenAddress: string, pairAddress: string, priceUsd: string, liquidityUsd = 100_000) {
  return {
    chainId: "base",
    dexId: "uniswap",
    pairAddress,
    baseToken: { address: tokenAddress, name: "Fixture USD", symbol: "FIX" },
    quoteToken: { address: "0xusdc", name: "USD Coin", symbol: "USDC" },
    priceUsd,
    priceNative: null,
    volume: { h24: 10_000, h6: 0, h1: 0, m5: 0 },
    liquidity: { usd: liquidityUsd, base: 50_000, quote: 50_000 },
    pairCreatedAt: null,
  };
}

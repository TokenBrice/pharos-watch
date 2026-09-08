export function makeApiPool(address: string, coins: Array<{ symbol: string; address: unknown }>, usdTotal = 200_000) {
  return {
    address,
    name: coins.map((coin) => coin.symbol).join("/"),
    amplificationCoefficient: "1000",
    coins: coins.map((coin) => ({ ...coin, poolBalance: "100000000000", usdPrice: 1, decimals: "6" })),
    usdTotal,
    isMetaPool: false,
    assetTypeName: "USD",
    totalSupply: 0,
    registryId: "factory-stable-ng",
    isBroken: false,
    virtualPrice: "1",
    usdTotalExcludingBasePool: 0,
    creationTs: 123,
    basePoolAddress: null,
    gaugeCrvApy: null,
  };
}

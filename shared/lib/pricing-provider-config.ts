export const BINANCE_MARKETS: readonly {
  pair: string;
  symbol: string;
  quoteSymbol?: string;
}[] = [
  { pair: "USDTUSD", symbol: "USDT" },
  { pair: "USDCUSD", symbol: "USDC" },
] as const;

export const KRAKEN_MARKETS = [
  { symbol: "DAI", requestPair: "DAIUSD", responseKeys: ["DAIUSD"] },
  { symbol: "EURC", requestPair: "EURCUSD", responseKeys: ["EURCUSD"] },
  { symbol: "PAXG", requestPair: "PAXGUSD", responseKeys: ["PAXGUSD"] },
  { symbol: "PYUSD", requestPair: "PYUSDUSD", responseKeys: ["PYUSDUSD"] },
  { symbol: "TGBP", requestPair: "TGBPUSD", responseKeys: ["TGBPUSD"] },
  { symbol: "USD1", requestPair: "USD1USD", responseKeys: ["USD1USD"] },
  { symbol: "USDC", requestPair: "USDCUSD", responseKeys: ["USDCUSD"] },
  { symbol: "USDS", requestPair: "USDSUSD", responseKeys: ["USDSUSD"] },
  { symbol: "USDT", requestPair: "USDTUSD", responseKeys: ["USDTUSD", "USDTZUSD"] },
] as const;

export const BITSTAMP_MARKETS = [
  { pair: "DAI/USD", symbol: "DAI" },
  { pair: "PYUSD/USD", symbol: "PYUSD" },
  { pair: "USDC/USD", symbol: "USDC" },
  { pair: "USDT/USD", symbol: "USDT" },
] as const;

export const COINBASE_PRODUCTS = [
  { symbol: "USDT", productId: "USDT-USD" },
  { symbol: "PAXG", productId: "PAXG-USD" },
  { symbol: "USDS", productId: "USDS-USD" },
  { symbol: "USD1", productId: "USD1-USD" },
  { symbol: "HONEY", productId: "HONEY-USD" },
] as const;

export const CEX_PROVIDER_AUDIT_CONFIG = {
  binance: { metadataUrl: "https://api.binance.com/api/v3/exchangeInfo" },
  kraken: { metadataUrl: "https://api.kraken.com/0/public/AssetPairs" },
  bitstamp: { metadataUrl: "https://www.bitstamp.net/api/v2/trading-pairs-info/" },
  coinbase: { metadataUrl: "https://api.exchange.coinbase.com/products" },
} as const;

export const REDSTONE_SYMBOL_CONFIG = [
  { stablecoinId: "alusd-alchemix", metaSymbol: "alUSD", apiSymbol: "ALUSD" },
  { stablecoinId: "ausd-agora", metaSymbol: "AUSD", apiSymbol: "aUSD" },
  { stablecoinId: "cetes-etherfuse", metaSymbol: "CETES", apiSymbol: "CETES" },
  { stablecoinId: "dai-makerdao", metaSymbol: "DAI", apiSymbol: "DAI" },
  { stablecoinId: "eurc-circle", metaSymbol: "EURC", apiSymbol: "EUROC" },
  { stablecoinId: "eusd-electronic-usd", metaSymbol: "EUSD", apiSymbol: "eUSD" },
  { stablecoinId: "fdusd-first-digital", metaSymbol: "FDUSD", apiSymbol: "FDUSD" },
  { stablecoinId: "frax-frax", metaSymbol: "FRAX", apiSymbol: "FRAX" },
  { stablecoinId: "frxusd-frax", metaSymbol: "FRXUSD", apiSymbol: "frxUSD" },
  { stablecoinId: "gho-aave", metaSymbol: "GHO", apiSymbol: "GHO" },
  { stablecoinId: "honey-berachain", metaSymbol: "HONEY", apiSymbol: "HONEY" },
  { stablecoinId: "lusd-liquity", metaSymbol: "LUSD", apiSymbol: "LUSD" },
  { stablecoinId: "pyusd-paypal", metaSymbol: "PYUSD", apiSymbol: "PYUSD" },
  { stablecoinId: "usd1-world-liberty-financial", metaSymbol: "USD1", apiSymbol: "USD1" },
  { stablecoinId: "usdc-circle", metaSymbol: "USDC", apiSymbol: "USDC" },
  { stablecoinId: "usdh-native-markets", metaSymbol: "USDH", apiSymbol: "USDH" },
  { stablecoinId: "usdt-tether", metaSymbol: "USDT", apiSymbol: "USDT" },
  { stablecoinId: "usde-ethena", metaSymbol: "USDe", apiSymbol: "USDe" },
  { stablecoinId: "xaut-tether", metaSymbol: "XAUT", apiSymbol: "XAUt" },
  { stablecoinId: "crvusd-curve", metaSymbol: "crvUSD", apiSymbol: "crvUSD" },
  { stablecoinId: "fxusd-f-x-protocol", metaSymbol: "fxUSD", apiSymbol: "fxUSD" },
] as const;

export const REDSTONE_PROVIDER_AUDIT_CONFIG = {
  metadataUrl: "https://api.redstone.finance/prices",
} as const;

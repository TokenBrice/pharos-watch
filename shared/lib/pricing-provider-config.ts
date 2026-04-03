export const BINANCE_MARKETS = [
  { pair: "USDTUSD", symbol: "USDT" },
  { pair: "USDCUSD", symbol: "USDC" },
] as const;

export const KRAKEN_MARKETS = [
  { symbol: "DAI", requestPair: "DAIUSD", responseKeys: ["DAIUSD"] },
  { symbol: "EURC", requestPair: "EURCUSD", responseKeys: ["EURCUSD"] },
  { symbol: "PAXG", requestPair: "PAXGUSD", responseKeys: ["PAXGUSD"] },
  { symbol: "PYUSD", requestPair: "PYUSDUSD", responseKeys: ["PYUSDUSD"] },
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
  { symbol: "DAI", productId: "DAI-USD" },
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
  { metaSymbol: "ALUSD", apiSymbol: "ALUSD" },
  { metaSymbol: "AUSD", apiSymbol: "aUSD" },
  { metaSymbol: "CETES", apiSymbol: "CETES" },
  { metaSymbol: "DAI", apiSymbol: "DAI" },
  { metaSymbol: "EURC", apiSymbol: "EUROC" },
  { metaSymbol: "EUSD", apiSymbol: "eUSD" },
  { metaSymbol: "FDUSD", apiSymbol: "FDUSD" },
  { metaSymbol: "FRAX", apiSymbol: "FRAX" },
  { metaSymbol: "FRXUSD", apiSymbol: "frxUSD" },
  { metaSymbol: "GHO", apiSymbol: "GHO" },
  { metaSymbol: "HONEY", apiSymbol: "HONEY" },
  { metaSymbol: "LUSD", apiSymbol: "LUSD" },
  { metaSymbol: "PYUSD", apiSymbol: "PYUSD" },
  { metaSymbol: "USD1", apiSymbol: "USD1" },
  { metaSymbol: "USDC", apiSymbol: "USDC" },
  { metaSymbol: "USDH", apiSymbol: "USDH" },
  { metaSymbol: "USDT", apiSymbol: "USDT" },
  { metaSymbol: "USDe", apiSymbol: "USDe" },
  { metaSymbol: "XAUT", apiSymbol: "XAUt" },
  { metaSymbol: "crvUSD", apiSymbol: "crvUSD" },
  { metaSymbol: "fxUSD", apiSymbol: "fxUSD" },
] as const;

export const REDSTONE_PROVIDER_AUDIT_CONFIG = {
  metadataUrl: "https://api.redstone.finance/prices",
} as const;

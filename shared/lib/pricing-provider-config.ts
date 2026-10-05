export const BINANCE_MARKETS: readonly {
  pair: string;
  symbol: string;
}[] = [
  { pair: "USDTUSD", symbol: "USDT" },
  { pair: "USDCUSD", symbol: "USDC" },
] as const;

export const KRAKEN_MARKETS = [
  { symbol: "DAI", requestPair: "DAIUSD", responseKeys: ["DAIUSD"] },
  { symbol: "EURC", requestPair: "EURCUSD", responseKeys: ["EURCUSD"] },
  // 2026-09-27: Kraken lists MXNB/USD (response key MXNBUSD) and CoinGecko's
  // `mxnb` ticker set includes this exact market, so the hard-market voice
  // corroborates mxnb-juno instead of leaving it a pool-challenge-downgraded
  // single-source CoinGecko row.
  { symbol: "MXNB", requestPair: "MXNBUSD", responseKeys: ["MXNBUSD"] },
  { symbol: "PAXG", requestPair: "PAXGUSD", responseKeys: ["PAXGUSD"] },
  { symbol: "PYUSD", requestPair: "PYUSDUSD", responseKeys: ["PYUSDUSD"] },
  // 2026-10-05: Kraken's online SOFID/USD market matches SoFiUSD's
  // CoinGecko ticker identity and provides the existing hard-market voice.
  { symbol: "SOFID", requestPair: "SOFIDUSD", responseKeys: ["SOFIDUSD"] },
  { symbol: "TGBP", requestPair: "TGBPUSD", responseKeys: ["TGBPUSD"] },
  { symbol: "USD1", requestPair: "USD1USD", responseKeys: ["USD1USD"] },
  { symbol: "USDC", requestPair: "USDCUSD", responseKeys: ["USDCUSD"] },
  { symbol: "USDS", requestPair: "USDSUSD", responseKeys: ["USDSUSD"] },
  { symbol: "USDT", requestPair: "USDTUSD", responseKeys: ["USDTUSD", "USDTZUSD"] },
] as const;

export const BITSTAMP_MARKETS = [
  { pair: "PYUSD/USD", symbol: "PYUSD" },
  { pair: "USDC/USD", symbol: "USDC" },
  { pair: "USDT/USD", symbol: "USDT" },
] as const;

export const COINBASE_PRODUCTS = [
  { symbol: "USDT", productId: "USDT-USD" },
  { symbol: "PAXG", productId: "PAXG-USD" },
  { symbol: "USDS", productId: "USDS-USD" },
  { symbol: "USD1", productId: "USD1-USD" },
  // Coinbase HONEY-USD is Solana Hivemapper, not Berachain's Bera USD.
  // 2026-09-27: Coinbase lists AUDD on its USDC-quoted FX-stablecoin book
  // (`fx_stablecoin: true`, USDC treated at USD par). Coinbase's AUDD asset
  // pins to the Novatti AUDD Ethereum contract 0x4cce605e..., which matches
  // audd-novatti exactly; CoinGecko's AUDD ticker set lists this market.
  { symbol: "AUDD", productId: "AUDD-USDC" },
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
  // Berachain renamed the same token BUSD; RedStone retains its HONEY feed.
  { stablecoinId: "honey-berachain", metaSymbol: "BUSD", apiSymbol: "HONEY" },
  { stablecoinId: "lusd-liquity", metaSymbol: "LUSD", apiSymbol: "LUSD" },
  { stablecoinId: "pyusd-paypal", metaSymbol: "PYUSD", apiSymbol: "PYUSD" },
  { stablecoinId: "usd1-world-liberty-financial", metaSymbol: "USD1", apiSymbol: "USD1" },
  { stablecoinId: "usdc-circle", metaSymbol: "USDC", apiSymbol: "USDC" },
  { stablecoinId: "usdt-tether", metaSymbol: "USDT", apiSymbol: "USDT" },
  { stablecoinId: "usde-ethena", metaSymbol: "USDe", apiSymbol: "USDe" },
  { stablecoinId: "xaut-tether", metaSymbol: "XAUT", apiSymbol: "XAUt" },
  { stablecoinId: "crvusd-curve", metaSymbol: "crvUSD", apiSymbol: "crvUSD" },
  { stablecoinId: "fxusd-f-x-protocol", metaSymbol: "fxUSD", apiSymbol: "fxUSD" },
] as const;

export const REDSTONE_PROVIDER_AUDIT_CONFIG = {
  metadataUrl: "https://api.redstone.finance/prices",
} as const;

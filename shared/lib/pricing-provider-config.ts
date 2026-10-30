export const BINANCE_MARKETS: readonly {
  pair: string;
  symbol: string;
}[] = [
  { pair: "USDTUSD", symbol: "USDT" },
  { pair: "USDCUSD", symbol: "USDC" },
] as const;

export const KRAKEN_MARKETS = [
  // 2026-10-30: Kraken's online AUDX/USD book is the Aussie Dollar Token; the
  // CoinGecko `aussie-dollar-token` ticker set is exactly this Kraken market.
  { symbol: "AUDX", requestPair: "AUDXUSD", responseKeys: ["AUDXUSD"] },
  // 2026-10-30: Kraken's BRL1/USD book is the BRL1 consortium real; CoinGecko's
  // `brl1` ticker set lists this exact market at Kraken's own 24h volume.
  { symbol: "BRL1", requestPair: "BRL1USD", responseKeys: ["BRL1USD"] },
  // 2026-10-30: Kraken's CASH/USD book is the Solana CASH mint Phantom documents
  // for Kraken deposits; CoinGecko's `cash-4` ticker set includes this exact market.
  { symbol: "CASH", requestPair: "CASHUSD", responseKeys: ["CASHUSD"] },
  { symbol: "DAI", requestPair: "DAIUSD", responseKeys: ["DAIUSD"] },
  { symbol: "EURC", requestPair: "EURCUSD", responseKeys: ["EURCUSD"] },
  // 2026-10-30: Kraken lists Schuman Financial's EUROP; CoinGecko's `schuman-europ`
  // ticker set includes this exact market, and Kraken publishes no contract address.
  { symbol: "EUROP", requestPair: "EUROPUSD", responseKeys: ["EUROPUSD"] },
  // Kraken's FRNT/USD book is the same Wyoming token listed by CoinGecko;
  // its live bid/ask survives quiet trading that leaves CG's last trade stale.
  { symbol: "FRNT", requestPair: "FRNTUSD", responseKeys: ["FRNTUSD"] },
  // 2026-09-27: Kraken lists MXNB/USD (response key MXNBUSD) and CoinGecko's
  // `mxnb` ticker set includes this exact market, so the hard-market voice
  // corroborates mxnb-juno instead of leaving it a pool-challenge-downgraded
  // single-source CoinGecko row.
  { symbol: "MXNB", requestPair: "MXNBUSD", responseKeys: ["MXNBUSD"] },
  { symbol: "PAXG", requestPair: "PAXGUSD", responseKeys: ["PAXGUSD"] },
  { symbol: "PYUSD", requestPair: "PYUSDUSD", responseKeys: ["PYUSDUSD"] },
  // 2026-10-30: Kraken's QCAD/USD book is Stablecorp QCAD; CoinGecko's
  // `stablecorp-qcad` ticker set contains only this exact Kraken market.
  { symbol: "QCAD", requestPair: "QCADUSD", responseKeys: ["QCADUSD"] },
  // 2026-10-05: Kraken's online SOFID/USD market matches SoFiUSD's
  // CoinGecko ticker identity and provides the existing hard-market voice.
  { symbol: "SOFID", requestPair: "SOFIDUSD", responseKeys: ["SOFIDUSD"] },
  { symbol: "TGBP", requestPair: "TGBPUSD", responseKeys: ["TGBPUSD"] },
  { symbol: "USD1", requestPair: "USD1USD", responseKeys: ["USD1USD"] },
  { symbol: "USDC", requestPair: "USDCUSD", responseKeys: ["USDCUSD"] },
  // 2026-10-30: Kraken lists OSL/Anchorage USDGO as USDGO/USD; CoinGecko's `usdgo`
  // ticker set includes this exact market, whose online bid/ask outlives CG's last trade.
  { symbol: "USDGO", requestPair: "USDGOUSD", responseKeys: ["USDGOUSD"] },
  // 2026-10-30: Kraken's USDPT/USD book is Western Union's USDPT; CoinGecko's
  // `usdpt-western-union` ticker set lists this exact market.
  { symbol: "USDPT", requestPair: "USDPTUSD", responseKeys: ["USDPTUSD"] },
  { symbol: "USDS", requestPair: "USDSUSD", responseKeys: ["USDSUSD"] },
  // 2026-10-30: Kraken lists Stable Mint (USDSM) as USDSMUSD; CoinGecko's
  // `stable-mint-usd` ticker set names this market. Very thin flow, standing book.
  { symbol: "USDSM", requestPair: "USDSMUSD", responseKeys: ["USDSMUSD"] },
  // 2026-10-30: Kraken's USDSUI/USD book is Sui Dollar (Bridge); CoinGecko's
  // `usdsui` ticker set pins this exact market. Quoted but barely traded.
  { symbol: "USDSUI", requestPair: "USDSUIUSD", responseKeys: ["USDSUIUSD"] },
  { symbol: "USDT", requestPair: "USDTUSD", responseKeys: ["USDTUSD", "USDTZUSD"] },
  // 2026-10-30: Kraken's online XAUT/USD book is the Tether Gold token in
  // CoinGecko's xaut-tether ticker set, mirroring PAXG's hard-market voice.
  { symbol: "XAUT", requestPair: "XAUTUSD", responseKeys: ["XAUTUSD"] },
  // 2026-10-30: Kraken lists Frankencoin (ZCHF) as ZCHFUSD; CoinGecko's
  // `frankencoin` ticker set contains this exact market. CHF peg, direct USD book.
  { symbol: "ZCHF", requestPair: "ZCHFUSD", responseKeys: ["ZCHFUSD"] },
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
  // 2026-10-30: Coinbase's XSGD-USDC FX-stablecoin book treats USDC at USD par
  // under the AUDD precedent; Coinbase's XSGD asset pins the tracked StraitsX
  // Ethereum contract. Sparse last-trade prints are rejected by the 600 s clock.
  { symbol: "XSGD", productId: "XSGD-USDC" },
] as const;
export const CEX_PROVIDER_AUDIT_CONFIG = {
  binance: { metadataUrl: "https://api.binance.com/api/v3/exchangeInfo" },
  kraken: { metadataUrl: "https://api.kraken.com/0/public/AssetPairs" },
  bitstamp: { metadataUrl: "https://www.bitstamp.net/api/v2/trading-pairs-info/" },
  coinbase: { metadataUrl: "https://api.exchange.coinbase.com/products" },
} as const;

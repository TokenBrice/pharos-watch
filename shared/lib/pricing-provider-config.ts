export const BINANCE_MARKETS: readonly {
  pair: string;
  symbol: string;
}[] = [
  { pair: "USDTUSD", symbol: "USDT" },
  { pair: "USDCUSD", symbol: "USDC" },
] as const;

export interface KrakenMarketConfig {
  readonly symbol: string;
  readonly requestPair: string;
  readonly responseKeys: readonly string[];
  readonly clockedDepth?: true;
  /** Exact tracked stablecoin id when multiple tracked assets share `symbol`. */
  readonly stablecoinId?: string;
}

export const KRAKEN_MARKETS: readonly KrakenMarketConfig[] = [
  // 2026-10-30: Kraken's online AUDX/USD book is the Aussie Dollar Token; the
  // CoinGecko `aussie-dollar-token` ticker set is exactly this Kraken market.
  { symbol: "AUDX", requestPair: "AUDXUSD", responseKeys: ["AUDXUSD"], clockedDepth: true },
  // 2026-10-30: Kraken's BRL1/USD book is the BRL1 consortium real; CoinGecko's
  // `brl1` ticker set lists this exact market at Kraken's own 24h volume.
  { symbol: "BRL1", requestPair: "BRL1USD", responseKeys: ["BRL1USD"], clockedDepth: true },
  // 2026-10-30: Kraken's CASH/USD book is the Solana CASH mint Phantom documents
  // for Kraken deposits; CoinGecko's `cash-4` ticker set includes this exact market.
  { symbol: "CASH", requestPair: "CASHUSD", responseKeys: ["CASHUSD"] },
  { symbol: "DAI", requestPair: "DAIUSD", responseKeys: ["DAIUSD"] },
  { symbol: "EURC", requestPair: "EURCUSD", responseKeys: ["EURCUSD"], clockedDepth: true },
  // 2026-11-24: Kraken lists SG-FORGE EUR CoinVertible as direct-USD EURCV/USD
  // (mirroring EURC/EUROP); CoinGecko's `societe-generale-forge-eurcv` ticker
  // set pins this exact market, and SG-FORGE / Kraken jointly announced the listing.
  { symbol: "EURCV", requestPair: "EURCVUSD", responseKeys: ["EURCVUSD"], clockedDepth: true },
  // 2026-10-30: Kraken lists Schuman Financial's EUROP; CoinGecko's `schuman-europ`
  // ticker set includes this exact market, and Kraken publishes no contract address.
  { symbol: "EUROP", requestPair: "EUROPUSD", responseKeys: ["EUROPUSD"], clockedDepth: true },
  // Kraken's FRNT/USD book is the same Wyoming token listed by CoinGecko;
  // its live bid/ask survives quiet trading that leaves CG's last trade stale.
  { symbol: "FRNT", requestPair: "FRNTUSD", responseKeys: ["FRNTUSD"] },
  // 2026-09-27: Kraken lists MXNB/USD (response key MXNBUSD) and CoinGecko's
  // `mxnb` ticker set includes this exact market, so the hard-market voice
  // corroborates mxnb-juno instead of leaving it a pool-challenge-downgraded
  // single-source CoinGecko row.
  { symbol: "MXNB", requestPair: "MXNBUSD", responseKeys: ["MXNBUSD"], clockedDepth: true },
  // 2026-11-24: Kraken's online OUSD/USD book is Bridge / Open Standard Open USD
  // (`ousd-open-standard`, listed 2026-09-30), NOT Origin Dollar (`ousd-origin-protocol`,
  // which has no Kraken market). CoinGecko's `open-usd` ticker set pins this market;
  // `stablecoinId` scopes the join so both OUSD-symbol coins stay isolated. Tight (~1 bp)
  // market-made book refreshed roughly every 70s, well within Kraken's 600s Depth window.
  { symbol: "OUSD", stablecoinId: "ousd-open-standard", requestPair: "OUSDUSD", responseKeys: ["OUSDUSD"], clockedDepth: true },
  { symbol: "PAXG", requestPair: "PAXGUSD", responseKeys: ["PAXGUSD"], clockedDepth: true },
  { symbol: "PYUSD", requestPair: "PYUSDUSD", responseKeys: ["PYUSDUSD"] },
  // 2026-10-30: Kraken's QCAD/USD book is Stablecorp QCAD; CoinGecko's
  // `stablecorp-qcad` ticker set contains only this exact Kraken market.
  { symbol: "QCAD", requestPair: "QCADUSD", responseKeys: ["QCADUSD"], clockedDepth: true },
  // 2026-10-05: Kraken's online SOFID/USD market matches SoFiUSD's
  // CoinGecko ticker identity and provides the existing hard-market voice.
  { symbol: "SOFID", requestPair: "SOFIDUSD", responseKeys: ["SOFIDUSD"] },
  { symbol: "TGBP", requestPair: "TGBPUSD", responseKeys: ["TGBPUSD"], clockedDepth: true },
  { symbol: "USD1", requestPair: "USD1USD", responseKeys: ["USD1USD"] },
  { symbol: "USDC", requestPair: "USDCUSD", responseKeys: ["USDCUSD"] },
  // 2026-11-24: Kraken's online USDD/USD book is TRON DAO Reserve USDD v2
  // (`usdd-tron-dao-reserve`); CoinGecko's `usdd` ticker set lists this exact
  // market. Its top-of-book levels can sit for hours (a 35-hour-old ask was
  // observed at listing), so it reads clocked Depth: a stale side withholds the
  // quote instead of letting an old book vote as a fresh local-fetch midpoint.
  { symbol: "USDD", requestPair: "USDDUSD", responseKeys: ["USDDUSD"], clockedDepth: true },
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
  { symbol: "XAUT", requestPair: "XAUTUSD", responseKeys: ["XAUTUSD"], clockedDepth: true },
  // 2026-10-30: Kraken lists Frankencoin (ZCHF) as ZCHFUSD; CoinGecko's
  // `frankencoin` ticker set contains this exact market. CHF peg, direct USD book.
  { symbol: "ZCHF", requestPair: "ZCHFUSD", responseKeys: ["ZCHFUSD"], clockedDepth: true },
] as const;

export function krakenMarketMatchesAsset(
  market: KrakenMarketConfig,
  symbol: string | undefined,
  stablecoinId?: string,
): boolean {
  const normalizedSymbol = symbol?.trim().toUpperCase();
  if (!normalizedSymbol || market.symbol !== normalizedSymbol) return false;
  return market.stablecoinId == null || market.stablecoinId === stablecoinId;
}

export function matchesCuratedKrakenAsset(
  symbol: string | undefined,
  stablecoinId?: string,
): boolean {
  return KRAKEN_MARKETS.some((market) => krakenMarketMatchesAsset(market, symbol, stablecoinId));
}

export const BITSTAMP_MARKETS = [
  // 2026-10-30: PYUSD/USD dropped. The book is listed but untraded
  // (volume/open_24 zero) and publishes a placeholder 0.8010/1.5094 quote whose
  // 1.1552 midpoint would become a fresh upstream observation. Re-add only when
  // the Bitstamp ticker shows non-zero 24h volume and a book inside the reviewed
  // price band in the same payload.
  { pair: "USDC/USD", symbol: "USDC" },
  { pair: "USDT/USD", symbol: "USDT" },
] as const;

export const COINBASE_PRODUCTS = [
  { symbol: "USDT", productId: "USDT-USD", quoteAsset: "USD" },
  { symbol: "PAXG", productId: "PAXG-USD", quoteAsset: "USD" },
  { symbol: "USDS", productId: "USDS-USD", quoteAsset: "USD" },
  { symbol: "USD1", productId: "USD1-USD", quoteAsset: "USD" },
  // Coinbase HONEY-USD is Solana Hivemapper, not Berachain's Bera USD.
  // 2026-09-27: Coinbase lists AUDD on its USDC-quoted FX-stablecoin book
  // (`fx_stablecoin: true`). Coinbase's AUDD asset
  // pins to the Novatti AUDD Ethereum contract 0x4cce605e..., which matches
  // audd-novatti exactly; CoinGecko's AUDD ticker set lists this market.
  { symbol: "AUDD", productId: "AUDD-USDC", quoteAsset: "USDC" },
  // 2026-10-30: Coinbase's XSGD asset pins the tracked StraitsX Ethereum contract.
  { symbol: "XSGD", productId: "XSGD-USDC", quoteAsset: "USDC" },
  // 2026-11-23 (#2144 D7): Coinbase lists EURC on its USDC-quoted FX-stablecoin book
  // (`fx_stablecoin: true`); Coinbase's EURC asset pins the Circle Ethereum contract
  // 0x1abaea1f..., matching eurc-circle.
  { symbol: "EURC", productId: "EURC-USDC", quoteAsset: "USDC" },
  // 2026-11-23 (#2144 D7): Coinbase lists TGBP on its USDC-quoted FX-stablecoin book
  // (`fx_stablecoin: true`); Coinbase's TGBP asset pins the Tokenised GBP Base/Ethereum
  // contract 0x27f6c828..., matching tgbp-tokenised.
  { symbol: "TGBP", productId: "TGBP-USDC", quoteAsset: "USDC" },
] as const;

// 2026-10-30 venue inventory identified Kraken USD as the only CoinGecko market for each asset.
export const REVIEWED_COINGECKO_KRAKEN_MIRRORS: ReadonlySet<string> = new Set([
  "audx-aussie-dollar-token",
  "qcad-stablecorp",
]);

export const CEX_PROVIDER_AUDIT_CONFIG = {
  binance: { metadataUrl: "https://api.binance.com/api/v3/exchangeInfo" },
  kraken: { metadataUrl: "https://api.kraken.com/0/public/AssetPairs" },
  bitstamp: { metadataUrl: "https://www.bitstamp.net/api/v2/trading-pairs-info/" },
  coinbase: { metadataUrl: "https://api.exchange.coinbase.com/products" },
} as const;

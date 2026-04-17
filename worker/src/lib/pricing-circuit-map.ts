import { CIRCUIT_SOURCE } from "./constants";

/** Canonical mapping from pricing source keys to their circuit breaker constants.
 *  Synthesized / composite / cached sources map to null. */
export const PRICING_SOURCE_TO_CIRCUIT: Record<string, string | null> = {
  // aggregators
  "coingecko": CIRCUIT_SOURCE.CG_PRICES,
  "coingecko-native-implied": CIRCUIT_SOURCE.CG_PRICES, // shares CG simple-price breaker
  "coingecko-mirror": CIRCUIT_SOURCE.CG_PRICES,
  "defillama": CIRCUIT_SOURCE.DL_STABLECOIN_DETAIL,
  "defillama-list": CIRCUIT_SOURCE.DL_STABLECOINS,
  // dex-search
  "dex-promoted": null, // synthesized aggregate of promoted DEX pool prices
  "fluid-dex": CIRCUIT_SOURCE.FLUID_DEX_API,
  "balancer-dex": CIRCUIT_SOURCE.BALANCER_API,
  "raydium-dex": CIRCUIT_SOURCE.RAYDIUM_API,
  "orca-dex": CIRCUIT_SOURCE.ORCA_API,
  "jupiter": CIRCUIT_SOURCE.JUPITER_PRICES,
  "coinmarketcap": CIRCUIT_SOURCE.CMC_PRICES,
  "dexscreener": CIRCUIT_SOURCE.DEXSCREENER_PRICES,
  // market-feeds
  "cg-ticker": CIRCUIT_SOURCE.CG_TICKER,
  "geckoterminal": CIRCUIT_SOURCE.GECKO_TERMINAL_PROBE,
  "pyth": CIRCUIT_SOURCE.PYTH_PRICES,
  "binance": CIRCUIT_SOURCE.BINANCE_PRICES,
  "kraken": CIRCUIT_SOURCE.KRAKEN_PRICES,
  "bitstamp": CIRCUIT_SOURCE.BITSTAMP_PRICES,
  "coinbase": CIRCUIT_SOURCE.COINBASE_PRICES,
  "redstone": CIRCUIT_SOURCE.REDSTONE_PRICES,
  "curve-onchain": CIRCUIT_SOURCE.CURVE_ONCHAIN,
  "curve-oracle": CIRCUIT_SOURCE.CURVE_ORACLE,
  // special
  "defillama-contract": CIRCUIT_SOURCE.DL_COINS,
  "protocol-redeem": null, // in-process EVM call via shared chain RPC pool
  "pool-tvl-weighted": null, // synthesized post-challenge replacement
  "cached": null, // read from price_cache; no outbound fetch
} as const;

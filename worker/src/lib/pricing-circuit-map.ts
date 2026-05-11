import { CIRCUIT_SOURCE } from "./constants";

export type PricingCircuitEnforcementPath =
  | "direct-provider"
  | "producer-job"
  | "synthesized"
  | "cache";

export interface PricingCircuitMetadata {
  circuit: string | null;
  enforced: boolean;
  enforcementPath: PricingCircuitEnforcementPath;
  notes: string;
}

function direct(circuit: string, notes: string): PricingCircuitMetadata {
  return { circuit, enforced: true, enforcementPath: "direct-provider", notes };
}

function producer(circuit: string, notes: string): PricingCircuitMetadata {
  return { circuit, enforced: true, enforcementPath: "producer-job", notes };
}

function synthesized(notes: string): PricingCircuitMetadata {
  return { circuit: null, enforced: false, enforcementPath: "synthesized", notes };
}

function cache(notes: string): PricingCircuitMetadata {
  return { circuit: null, enforced: false, enforcementPath: "cache", notes };
}

/** Canonical metadata for pricing-source circuit enforcement.
 *  `circuit` names the breaker that directly protects the emitted source only
 *  when `enforced=true`; synthesized/cache rows are explicitly not gated. */
export const PRICING_SOURCE_CIRCUIT_METADATA: Record<string, PricingCircuitMetadata> = {
  // aggregators
  "coingecko": direct(CIRCUIT_SOURCE.CG_PRICES, "CoinGecko simple-price fetch is directly circuit-gated."),
  "coingecko-low-volume": direct(
    CIRCUIT_SOURCE.CG_PRICES,
    "Relaxed-freshness CoinGecko simple-price lane for low-volume CG-only stablecoins; same upstream breaker as `coingecko`.",
  ),
  "coingecko-native-implied": synthesized(
    "Derived from native CoinGecko simple-price quotes plus FX validation references; native quote availability is reported through provider diagnostics rather than the primary CG simple-price breaker.",
  ),
  "coingecko-mirror": direct(
    CIRCUIT_SOURCE.DL_COINS,
    "Emitted for CoinGecko-id mirrors resolved through DefiLlama coins.llama.fi coingecko:{id} rows, not through CoinGecko simple-price.",
  ),
  "defillama": direct(CIRCUIT_SOURCE.DL_STABLECOIN_DETAIL, "DefiLlama stablecoin detail endpoint."),
  "defillama-list": direct(CIRCUIT_SOURCE.DL_STABLECOINS, "DefiLlama stablecoins list endpoint."),
  // dex-search
  "dex-promoted": synthesized("Synthesized from the DEX liquidity producer output; not fetched inline by stablecoins sync."),
  "fluid-dex": producer(CIRCUIT_SOURCE.FLUID_DEX_API, "Protocol DEX producer circuit."),
  "balancer-dex": producer(CIRCUIT_SOURCE.BALANCER_API, "Protocol DEX producer circuit."),
  "raydium-dex": producer(CIRCUIT_SOURCE.RAYDIUM_API, "Protocol DEX producer circuit."),
  "orca-dex": producer(CIRCUIT_SOURCE.ORCA_API, "Protocol DEX producer circuit."),
  "meteora-dex": producer(CIRCUIT_SOURCE.METEORA_API, "Protocol DEX producer circuit."),
  "pancakeswap-dex": producer(CIRCUIT_SOURCE.PANCAKESWAP_API, "Protocol DEX producer circuit."),
  "aerodrome-dex": producer(CIRCUIT_SOURCE.AERODROME_SLIPSTREAM_API, "Protocol DEX producer circuit."),
  "velodrome-dex": producer(CIRCUIT_SOURCE.VELODROME_SLIPSTREAM_API, "Protocol DEX producer circuit."),
  "jupiter": direct(CIRCUIT_SOURCE.JUPITER_PRICES, "Jupiter fallback fetch is directly circuit-gated."),
  "coinmarketcap": direct(CIRCUIT_SOURCE.CMC_PRICES, "CoinMarketCap category fallback fetch is directly circuit-gated."),
  "dexscreener-exact": direct(CIRCUIT_SOURCE.DEXSCREENER_PRICES, "DexScreener exact token-address fallback."),
  "dexscreener-search": direct(CIRCUIT_SOURCE.DEXSCREENER_SEARCH, "DexScreener symbol-search fallback."),
  // market-feeds
  "cg-ticker": direct(CIRCUIT_SOURCE.CG_TICKER, "CoinGecko ticker fetch is directly circuit-gated."),
  "geckoterminal": direct(CIRCUIT_SOURCE.GECKO_TERMINAL_PROBE, "GeckoTerminal probe fetch is directly circuit-gated."),
  "pyth": direct(CIRCUIT_SOURCE.PYTH_PRICES, "Pyth Hermes fetch is directly circuit-gated."),
  "binance": direct(CIRCUIT_SOURCE.BINANCE_PRICES, "Binance ticker fetch is directly circuit-gated."),
  "kraken": direct(CIRCUIT_SOURCE.KRAKEN_PRICES, "Kraken ticker fetch is directly circuit-gated."),
  "bitstamp": direct(CIRCUIT_SOURCE.BITSTAMP_PRICES, "Bitstamp ticker fetch is directly circuit-gated."),
  "coinbase": direct(CIRCUIT_SOURCE.COINBASE_PRICES, "Coinbase ticker fetches are directly circuit-gated."),
  "redstone": direct(CIRCUIT_SOURCE.REDSTONE_PRICES, "RedStone fetch is directly circuit-gated."),
  "curve-onchain": direct(CIRCUIT_SOURCE.CURVE_ONCHAIN, "Curve on-chain quote path is circuit-gated."),
  "curve-oracle": direct(CIRCUIT_SOURCE.CURVE_ORACLE, "Curve oracle quote path is circuit-gated."),
  // special
  "defillama-contract": direct(CIRCUIT_SOURCE.DL_COINS, "DefiLlama coins.llama.fi contract fallback."),
  "protocol-redeem": synthesized("Authoritative protocol override or inherited tracked-base price; no dedicated pricing-source circuit."),
  "pool-tvl-weighted": synthesized("Synthesized post-challenge replacement across retained pool rows."),
  "cached": cache("Read from price_cache; no outbound fetch."),
} as const;

export const PRICING_SOURCE_TO_CIRCUIT: Record<string, string | null> = Object.fromEntries(
  Object.entries(PRICING_SOURCE_CIRCUIT_METADATA).map(([key, metadata]) => [
    key,
    metadata.enforced ? metadata.circuit : null,
  ]),
);

export type CircuitScope = "source-wide" | "asset-scoped" | "optional" | "retired";

/** Scope belongs to the circuit key/family, not to individual provider members. */
export const CIRCUIT_SOURCE_REGISTRY = {
  DL_STABLECOINS: { key: "defillama-stablecoins", scope: "source-wide" },
  DL_STABLECOIN_DETAIL: { key: "defillama-stablecoin-detail", scope: "source-wide" },
  DL_COINS: { key: "defillama-coins", scope: "source-wide" },
  DL_YIELDS: { key: "defillama-yields", scope: "source-wide" },
  DL_PROTOCOLS: { key: "defillama-protocols", scope: "source-wide" },
  CG_PRICES: { key: "coingecko-prices", scope: "source-wide" },
  CG_DETAIL_PLATFORMS: { key: "coingecko-detail-platforms", scope: "source-wide" },
  CG_MCAP: { key: "coingecko-mcap", scope: "source-wide" },
  CG_ONCHAIN: { key: "coingecko-onchain", scope: "source-wide" },
  HORIZON_DISCOVERY: { key: "stellar-horizon-discovery", scope: "source-wide" },
  DEXSCREENER_PRICES: { key: "dexscreener-prices", scope: "source-wide" },
  DEXSCREENER_PRICES_REFRESH: { key: "dexscreener-prices-refresh", scope: "source-wide" },
  DEXSCREENER_LIQUIDITY: { key: "dexscreener-liquidity", scope: "optional" },
  DEXSCREENER_ADDRESS_PRICES: { key: "dexscreener-address-prices", scope: "source-wide" },
  DEXPAPRIKA_PRICES: { key: "dexpaprika-prices", scope: "source-wide" },
  ALCHEMY_PRICES: { key: "alchemy-prices", scope: "source-wide" },
  MORALIS_PRICES: { key: "moralis-prices", scope: "source-wide" },
  BIRDEYE_PRICES: { key: "birdeye-prices", scope: "source-wide" },
  CMC_PRICES: { key: "coinmarketcap-prices", scope: "source-wide" },
  TREASURY_RATES: { key: "treasury-rates", scope: "source-wide" },
  ETHERSCAN: { key: "etherscan", scope: "source-wide" },
  ALCHEMY: { key: "alchemy", scope: "source-wide" },
  DWELLIR_EVM: { key: "dwellir-evm", scope: "optional" },
  TWITTER_API: { key: "twitter-api", scope: "source-wide" },
  TELEGRAM_API: { key: "telegram-api", scope: "source-wide" },
  BINANCE_PRICES: { key: "binance-prices", scope: "source-wide" },
  KRAKEN_PRICES: { key: "kraken-prices", scope: "source-wide" },
  BITSTAMP_PRICES: { key: "bitstamp-prices", scope: "source-wide" },
  COINBASE_PRICES: { key: "coinbase-prices", scope: "source-wide" },
  REDSTONE_PRICES: { key: "redstone-prices", scope: "source-wide" },
  KAVA_PRICEFEED: { key: "kava-pricefeed", scope: "asset-scoped" },
  AZND_CURVE_POOL: { key: "aznd-curve-pool", scope: "asset-scoped" },
  MENTO_FPMM: { key: "mento-fpmm", scope: "asset-scoped" },
  MENTO_BROKER: { key: "mento-broker", scope: "asset-scoped" },
  BD_AERODROME: { key: "bd-aerodrome", scope: "asset-scoped" },
  USDV_JUPITER: { key: "usdv-jupiter", scope: "asset-scoped" },
  SUSD_SOLAYER_NAV: { key: "susd-solayer-nav", scope: "asset-scoped" },
  USDAF_UNISWAP_V4: { key: "usdaf-uniswap-v4", scope: "asset-scoped" },
  USDU_UNISWAP_V3: { key: "usdu-uniswap-v3", scope: "asset-scoped" },
  // Single-asset members share this breaker with multi-asset redemption providers.
  PROTOCOL_REDEEM: { key: "protocol-redeem", scope: "source-wide" },
  CURVE_ONCHAIN: { key: "curve-onchain", scope: "source-wide" },
  CURVE_ORACLE: { key: "curve-oracle", scope: "source-wide" },
  CURVE_LIQUIDITY_API: { key: "curve-liquidity-api", scope: "source-wide" },
  FX_FRANKFURTER: { key: "fx-frankfurter", scope: "source-wide" },
  FX_REALTIME: { key: "fx-realtime", scope: "source-wide" },
  CHAINLINK_FEEDS: { key: "chainlink-feeds", scope: "source-wide" },
  JUPITER_PRICES: { key: "jupiter-prices", scope: "source-wide" },
  GECKO_TERMINAL_PROBE: { key: "geckoterminal-probe", scope: "source-wide" },
  FLUID_DEX_API: { key: "fluid-dex-api", scope: "source-wide" },
  BALANCER_API: { key: "balancer-api", scope: "source-wide" },
  RAYDIUM_API: { key: "raydium-api", scope: "source-wide" },
  ORCA_API: { key: "orca-api", scope: "source-wide" },
  METEORA_API: { key: "meteora-api", scope: "source-wide" },
  PANCAKESWAP_API: { key: "pancakeswap-api", scope: "source-wide" },
  AERODROME_SLIPSTREAM_API: { key: "aerodrome-slipstream-api", scope: "source-wide" },
  VELODROME_SLIPSTREAM_API: { key: "velodrome-slipstream-api", scope: "source-wide" },
  UNISWAP_V3_BSC_SHADOW: { key: "uniswap-v3-bsc-shadow", scope: "source-wide" },
  TRONGRID: { key: "trongrid", scope: "source-wide" },
  ANTHROPIC: { key: "anthropic-api", scope: "source-wide" },
  BLUECHIP: { key: "bluechip-api", scope: "source-wide" },
  CG_TICKER: { key: "coingecko-ticker", scope: "source-wide" },
  VAULTS_FYI: { key: "vaults-fyi", scope: "source-wide" },
  KINESIS_KAU: { key: "kinesis-kau-horizon", scope: "source-wide" },
  KINESIS_KAG: { key: "kinesis-kag-horizon", scope: "source-wide" },
  COINGECKO_CONFIRM: { key: "coingecko-confirm", scope: "source-wide" },
  DEFILLAMA_CONFIRM: { key: "defillama-confirm", scope: "source-wide" },
  DEXSCREENER_SEARCH: { key: "dexscreener-search", scope: "retired" },
  JUSD_CITREA_BRIDGE: { key: "jusd-citrea-bridge", scope: "retired" },
  USX_STABLE_POOLS: { key: "usx-stable-pools", scope: "retired" },
} as const satisfies Record<string, { key: string; scope: CircuitScope }>;

export const CIRCUIT_SOURCE = Object.fromEntries(
  Object.entries(CIRCUIT_SOURCE_REGISTRY)
    .filter(([, entry]) => entry.scope !== "retired")
    .map(([name, entry]) => [name, entry.key]),
) as {
  readonly [K in keyof typeof CIRCUIT_SOURCE_REGISTRY as
    (typeof CIRCUIT_SOURCE_REGISTRY)[K]["scope"] extends "retired" ? never : K]:
      (typeof CIRCUIT_SOURCE_REGISTRY)[K]["key"];
};

const CIRCUIT_SCOPES: Readonly<Record<string, CircuitScope>> = Object.fromEntries(
  Object.values(CIRCUIT_SOURCE_REGISTRY).map(({ key, scope }) => [key, scope]),
);

export function getCircuitScope(key: string): CircuitScope {
  if (key.startsWith("live-reserves:")) return "asset-scoped";
  // Unregistered keys fail conservatively: do not silently hide an outage.
  return Object.prototype.hasOwnProperty.call(CIRCUIT_SCOPES, key) ? CIRCUIT_SCOPES[key] : "source-wide";
}

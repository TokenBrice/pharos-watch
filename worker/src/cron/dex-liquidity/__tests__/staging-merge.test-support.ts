type StagedPoolTestRow = {
  pool_id: string;
  stablecoin_id: string;
  source: "cg_onchain" | "cg_tickers" | "gecko_terminal" | "horizon";
  chain: string;
  protocol: string;
  dex_id: string | null;
  symbol: string;
  tvl_usd: number | null;
  volume_24h: number | null;
  quality_multiplier: number | null;
  pool_type: string | null;
  fee_tier: number | null;
  balance_ratio: number | null;
  is_stable: number | boolean | null;
  base_token: string | null;
  quote_token: string | null;
  quote_symbol: string | null;
  price_usd: number | null;
  locked_liq_pct: number | null;
  raw_json: string | null;
  discovered_at: number;
  refreshed_at: number;
};

export function makeStagedPoolRow(
  overrides: Partial<StagedPoolTestRow> = {},
): StagedPoolTestRow {
  return {
    pool_id: "ethereum:0x0000000000000000000000000000000000000abc",
    stablecoin_id: "usdt-tether",
    source: "gecko_terminal",
    chain: "ethereum",
    protocol: "uniswap-v3",
    dex_id: "uniswap-v3",
    symbol: "USDT/USDC",
    tvl_usd: 100_000,
    volume_24h: 50_000,
    quality_multiplier: 0.85,
    pool_type: "gt-concentrated",
    fee_tier: 5,
    balance_ratio: null,
    is_stable: 1,
    base_token: "0x00000000000000000000000000000000000000b1",
    quote_token: "0x00000000000000000000000000000000000000c2",
    quote_symbol: "USDC",
    price_usd: 1,
    locked_liq_pct: null,
    raw_json: null,
    discovered_at: 1_709_913_600,
    refreshed_at: 1_710_000_000,
    ...overrides,
  };
}

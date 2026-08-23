import type { StagedPoolRow } from "../staging-merge";

export function makeStagedPoolRow(
  overrides: Partial<StagedPoolRow> = {},
): StagedPoolRow {
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

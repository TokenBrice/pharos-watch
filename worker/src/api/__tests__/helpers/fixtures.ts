/**
 * Shared factory functions for test fixtures.
 * Each returns a complete row with sensible defaults; pass `overrides` for specific values.
 */

export function makeAsset(overrides: Partial<{
  id: string; name: string; symbol: string; price: number;
  pegType: string; circulating: Record<string, number>;
  chainCirculating: Record<string, { current: Record<string, number> }>;
}> = {}) {
  return {
    id: overrides.id ?? "1",
    name: overrides.name ?? "Tether",
    symbol: overrides.symbol ?? "USDT",
    price: overrides.price ?? 1.0,
    pegType: overrides.pegType ?? "peggedUSD",
    circulating: overrides.circulating ?? { peggedUSD: 100_000_000 },
    chainCirculating: overrides.chainCirculating ?? {
      Ethereum: { current: { peggedUSD: 50_000_000 } },
    },
  };
}

export function makeBlacklistRow(overrides: Partial<{
  id: string; stablecoin: string; chain_id: string; chain_name: string;
  event_type: string; address: string; amount: number | null;
  tx_hash: string; block_number: number; timestamp: number;
  methodology_version: string | null;
  explorer_tx_url: string; explorer_address_url: string;
}> = {}) {
  return {
    id: overrides.id ?? "bl-1",
    stablecoin: overrides.stablecoin ?? "1",
    chain_id: overrides.chain_id ?? "ethereum",
    chain_name: overrides.chain_name ?? "Ethereum",
    event_type: overrides.event_type ?? "blacklist",
    address: overrides.address ?? "0xabc123",
    amount: overrides.amount ?? 1000,
    tx_hash: overrides.tx_hash ?? "0xtx1",
    block_number: overrides.block_number ?? 19000000,
    timestamp: overrides.timestamp ?? Math.floor(Date.now() / 1000) - 3600,
    methodology_version: overrides.methodology_version ?? "3.1",
    explorer_tx_url: overrides.explorer_tx_url ?? "https://etherscan.io/tx/0xtx1",
    explorer_address_url: overrides.explorer_address_url ?? "https://etherscan.io/address/0xabc123",
  };
}

export function makeDepegRow(overrides: Partial<{
  id: number; stablecoin_id: string; symbol: string; peg_type: string;
  direction: string; peak_deviation_bps: number; started_at: number;
  start_price: number; peak_price: number; peg_reference: number;
  recovery_price: number | null; ended_at: number | null; source: string;
}> = {}) {
  return {
    id: overrides.id ?? 1,
    stablecoin_id: overrides.stablecoin_id ?? "1",
    symbol: overrides.symbol ?? "USDT",
    peg_type: overrides.peg_type ?? "peggedUSD",
    direction: overrides.direction ?? "below",
    peak_deviation_bps: overrides.peak_deviation_bps ?? -200,
    started_at: overrides.started_at ?? Math.floor(Date.now() / 1000) - 7200,
    start_price: overrides.start_price ?? 0.98,
    peak_price: overrides.peak_price ?? 0.97,
    peg_reference: overrides.peg_reference ?? 1.0,
    recovery_price: overrides.recovery_price ?? null,
    ended_at: overrides.ended_at ?? null,
    source: overrides.source ?? "live",
  };
}

export function makeSupplyRow(overrides: Partial<{
  stablecoin_id: string; snapshot_date: number;
  circulating_usd: number; price: number | null;
}> = {}) {
  return {
    stablecoin_id: overrides.stablecoin_id ?? "1",
    snapshot_date: overrides.snapshot_date ?? Math.floor(Date.now() / 1000) - 86400,
    circulating_usd: overrides.circulating_usd ?? 100_000_000,
    price: overrides.price ?? 1.0,
  };
}

export function makeMintBurnRow(overrides: Partial<{
  id: string; stablecoin_id: string; symbol: string; chain_id: string;
  direction: string; amount: number; amount_usd: number;
  price_used: number | null; price_timestamp: number | null; price_source: string | null;
  counterparty: string; tx_hash: string; block_number: number;
  timestamp: number; explorer_tx_url: string;
}> = {}) {
  return {
    id: overrides.id ?? "mb-1",
    stablecoin_id: overrides.stablecoin_id ?? "1",
    symbol: overrides.symbol ?? "USDT",
    chain_id: overrides.chain_id ?? "ethereum",
    direction: overrides.direction ?? "mint",
    amount: overrides.amount ?? 1_000_000,
    amount_usd: overrides.amount_usd ?? 1_000_000,
    price_used: overrides.price_used ?? 1.0,
    price_timestamp: overrides.price_timestamp ?? Math.floor(Date.now() / 1000) - 3600,
    price_source: overrides.price_source ?? "supply-history-daily",
    counterparty: overrides.counterparty ?? "0x000...000",
    tx_hash: overrides.tx_hash ?? "0xtx1",
    block_number: overrides.block_number ?? 19000000,
    timestamp: overrides.timestamp ?? Math.floor(Date.now() / 1000) - 3600,
    explorer_tx_url: overrides.explorer_tx_url ?? "https://etherscan.io/tx/0xtx1",
  };
}

export function makeDexLiquidityRow(overrides: Partial<{
  stablecoin_id: string; total_tvl_usd: number; total_volume_24h_usd: number;
  total_volume_7d_usd: number; pool_count: number; pair_count: number;
  chain_count: number; protocol_tvl_json: string | null; chain_tvl_json: string | null;
  top_pools_json: string | null; liquidity_score: number | null;
  concentration_hhi: number | null; depth_stability: number | null;
  updated_at: number; effective_tvl_usd: number | null;
  avg_pool_stress: number | null; weighted_balance_ratio: number | null;
  organic_fraction: number | null; durability_score: number | null;
  score_components_json: string | null; locked_liquidity_pct: number | null;
  methodology_version: string | null;
}> = {}) {
  return {
    stablecoin_id: overrides.stablecoin_id ?? "1",
    total_tvl_usd: overrides.total_tvl_usd ?? 500_000_000,
    total_volume_24h_usd: overrides.total_volume_24h_usd ?? 10_000_000,
    total_volume_7d_usd: overrides.total_volume_7d_usd ?? 70_000_000,
    pool_count: overrides.pool_count ?? 10,
    pair_count: overrides.pair_count ?? 15,
    chain_count: overrides.chain_count ?? 3,
    protocol_tvl_json: overrides.protocol_tvl_json ?? '{"Uniswap":300000000}',
    chain_tvl_json: overrides.chain_tvl_json ?? '{"Ethereum":400000000}',
    top_pools_json: overrides.top_pools_json ?? "[]",
    liquidity_score: overrides.liquidity_score ?? 85,
    concentration_hhi: overrides.concentration_hhi ?? 0.3,
    depth_stability: overrides.depth_stability ?? 0.9,
    updated_at: overrides.updated_at ?? Math.floor(Date.now() / 1000) - 600,
    effective_tvl_usd: overrides.effective_tvl_usd ?? 450_000_000,
    avg_pool_stress: overrides.avg_pool_stress ?? 0.1,
    weighted_balance_ratio: overrides.weighted_balance_ratio ?? 0.95,
    organic_fraction: overrides.organic_fraction ?? 0.8,
    durability_score: overrides.durability_score ?? 75,
    score_components_json: overrides.score_components_json ?? null,
    locked_liquidity_pct: overrides.locked_liquidity_pct ?? null,
    methodology_version: overrides.methodology_version ?? "3.2",
  };
}

export function makeYieldHistoryRow(overrides: Partial<{
  recorded_at: number; apy: number; apy_base: number | null;
  apy_reward: number | null; exchange_rate: number | null;
  source_tvl_usd: number | null;
}> = {}) {
  return {
    recorded_at: overrides.recorded_at ?? Math.floor(Date.now() / 1000) - 3600,
    apy: overrides.apy ?? 5.2,
    apy_base: overrides.apy_base ?? 4.0,
    apy_reward: overrides.apy_reward ?? 1.2,
    exchange_rate: overrides.exchange_rate ?? 1.05,
    source_tvl_usd: overrides.source_tvl_usd ?? 50_000_000,
  };
}

export function makeDexLiquidityHistoryRow(overrides: Partial<{
  total_tvl_usd: number; total_volume_24h_usd: number;
  liquidity_score: number | null; snapshot_date: number;
  methodology_version: string | null;
}> = {}) {
  return {
    total_tvl_usd: overrides.total_tvl_usd ?? 500_000_000,
    total_volume_24h_usd: overrides.total_volume_24h_usd ?? 10_000_000,
    liquidity_score: overrides.liquidity_score ?? 85,
    snapshot_date: overrides.snapshot_date ?? Math.floor(Date.now() / 1000) - 86400,
    methodology_version: overrides.methodology_version ?? "3.2",
  };
}

export function makeDigestRow(overrides: Partial<{
  digest_text: string; digest_title: string | null;
  generated_at: number; digest_extended: string | null;
  input_data: string | null;
}> = {}) {
  return {
    digest_text: overrides.digest_text ?? "Today's stablecoin market saw moderate activity.",
    digest_title: overrides.digest_title ?? "Market Digest",
    generated_at: overrides.generated_at ?? Math.floor(Date.now() / 1000) - 3600,
    digest_extended: overrides.digest_extended ?? null,
    input_data: overrides.input_data ?? null,
  };
}

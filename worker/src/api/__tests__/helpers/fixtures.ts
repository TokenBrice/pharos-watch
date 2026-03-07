/**
 * Shared factory functions for test fixtures.
 * Each returns a complete row with sensible defaults; pass `overrides` for specific values.
 */

import type { BlacklistStablecoin, StablecoinData } from "@shared/types";

type BlacklistRow = {
  id: string;
  stablecoin: BlacklistStablecoin;
  chain_id: string;
  chain_name: string;
  event_type: "blacklist" | "unblacklist" | "destroy";
  address: string;
  amount: number | null;
  tx_hash: string;
  block_number: number;
  timestamp: number;
  methodology_version: string | null;
  explorer_tx_url: string;
  explorer_address_url: string;
};

type DepegRow = {
  id: number;
  stablecoin_id: string;
  symbol: string;
  peg_type: string;
  direction: "above" | "below";
  peak_deviation_bps: number;
  started_at: number;
  start_price: number;
  peak_price: number | null;
  peg_reference: number;
  recovery_price: number | null;
  ended_at: number | null;
  source: "live" | "backfill";
};

type SupplyRow = {
  stablecoin_id: string;
  snapshot_date: number;
  circulating_usd: number;
  price: number | null;
};

type MintBurnRow = {
  id: string;
  stablecoin_id: string;
  symbol: string;
  chain_id: string;
  direction: "mint" | "burn";
  amount: number;
  amount_usd: number | null;
  price_used: number | null;
  price_timestamp: number | null;
  price_source: string | null;
  burn_type: "effective_burn" | "bridge_burn" | "review_required" | null;
  burn_review_reason: string | null;
  counterparty: string | null;
  tx_hash: string;
  block_number: number;
  timestamp: number;
  explorer_tx_url: string;
};

type DexLiquidityRow = {
  stablecoin_id: string;
  total_tvl_usd: number;
  total_volume_24h_usd: number;
  total_volume_7d_usd: number;
  pool_count: number;
  pair_count: number;
  chain_count: number;
  protocol_tvl_json: string | null;
  chain_tvl_json: string | null;
  top_pools_json: string | null;
  liquidity_score: number | null;
  concentration_hhi: number | null;
  depth_stability: number | null;
  updated_at: number;
  effective_tvl_usd: number | null;
  avg_pool_stress: number | null;
  weighted_balance_ratio: number | null;
  organic_fraction: number | null;
  durability_score: number | null;
  score_components_json: string | null;
  locked_liquidity_pct: number | null;
  methodology_version: string | null;
};

type YieldHistoryRow = {
  stablecoin_id: string;
  recorded_at: number;
  apy: number;
  apy_base: number | null;
  apy_reward: number | null;
  exchange_rate: number | null;
  source_tvl_usd: number | null;
  data_source: string;
};

type DexLiquidityHistoryRow = {
  stablecoin_id: string;
  total_tvl_usd: number;
  total_volume_24h_usd: number;
  liquidity_score: number | null;
  snapshot_date: number;
  methodology_version: string | null;
};

type DigestRow = {
  id: number;
  digest_text: string;
  digest_title: string | null;
  generated_at: number;
  digest_extended: string | null;
  input_data: string | null;
};

export function makeAsset(overrides: Partial<StablecoinData> = {}): StablecoinData {
  const defaults: StablecoinData = {
    id: "usdt-tether",
    name: "Tether",
    symbol: "USDT",
    geckoId: "tether",
    pegType: "peggedUSD",
    pegMechanism: "fiat-backed",
    price: 1,
    priceSource: "defillama",
    priceConfidence: "high",
    supplySource: "defillama",
    circulating: { peggedUSD: 100_000_000 },
    circulatingPrevDay: { peggedUSD: 99_500_000 },
    circulatingPrevWeek: { peggedUSD: 98_500_000 },
    circulatingPrevMonth: { peggedUSD: 97_500_000 },
    chainCirculating: {
      Ethereum: {
        current: 50_000_000,
        circulatingPrevDay: 49_750_000,
        circulatingPrevWeek: 49_250_000,
        circulatingPrevMonth: 48_250_000,
      },
    },
    chains: ["Ethereum"],
  };
  return { ...defaults, ...overrides };
}

export function makeBlacklistRow(overrides: Partial<BlacklistRow> = {}): BlacklistRow {
  const defaults: BlacklistRow = {
    id: "bl-1",
    stablecoin: "USDT",
    chain_id: "ethereum",
    chain_name: "Ethereum",
    event_type: "blacklist",
    address: "0xabc123",
    amount: 1000,
    tx_hash: "0xtx1",
    block_number: 19000000,
    timestamp: Math.floor(Date.now() / 1000) - 3600,
    methodology_version: "3.1",
    explorer_tx_url: "https://etherscan.io/tx/0xtx1",
    explorer_address_url: "https://etherscan.io/address/0xabc123",
  };
  return { ...defaults, ...overrides };
}

export function makeDepegRow(overrides: Partial<DepegRow> = {}): DepegRow {
  const defaults: DepegRow = {
    id: 1,
    stablecoin_id: "usdt-tether",
    symbol: "USDT",
    peg_type: "peggedUSD",
    direction: "below",
    peak_deviation_bps: -200,
    started_at: Math.floor(Date.now() / 1000) - 7200,
    start_price: 0.98,
    peak_price: 0.97,
    peg_reference: 1,
    recovery_price: null,
    ended_at: null,
    source: "live",
  };
  return { ...defaults, ...overrides };
}

export function makeSupplyRow(overrides: Partial<SupplyRow> = {}): SupplyRow {
  const defaults: SupplyRow = {
    stablecoin_id: "usdt-tether",
    snapshot_date: Math.floor(Date.now() / 1000) - 86400,
    circulating_usd: 100_000_000,
    price: 1,
  };
  return { ...defaults, ...overrides };
}

export function makeMintBurnRow(overrides: Partial<MintBurnRow> = {}): MintBurnRow {
  const direction = overrides.direction ?? "mint";
  const defaults: MintBurnRow = {
    id: "mb-1",
    stablecoin_id: "usdt-tether",
    symbol: "USDT",
    chain_id: "ethereum",
    direction,
    amount: 1_000_000,
    amount_usd: 1_000_000,
    price_used: 1,
    price_timestamp: Math.floor(Date.now() / 1000) - 3600,
    price_source: "supply-history-daily",
    burn_type: direction === "burn" ? "effective_burn" : null,
    burn_review_reason: null,
    counterparty: "0x000...000",
    tx_hash: "0xtx1",
    block_number: 19000000,
    timestamp: Math.floor(Date.now() / 1000) - 3600,
    explorer_tx_url: "https://etherscan.io/tx/0xtx1",
  };
  return { ...defaults, ...overrides };
}

export function makeDexLiquidityRow(overrides: Partial<DexLiquidityRow> = {}): DexLiquidityRow {
  const defaults: DexLiquidityRow = {
    stablecoin_id: "usdt-tether",
    total_tvl_usd: 500_000_000,
    total_volume_24h_usd: 10_000_000,
    total_volume_7d_usd: 70_000_000,
    pool_count: 10,
    pair_count: 15,
    chain_count: 3,
    protocol_tvl_json: '{"Uniswap":300000000}',
    chain_tvl_json: '{"Ethereum":400000000}',
    top_pools_json: "[]",
    liquidity_score: 85,
    concentration_hhi: 0.3,
    depth_stability: 0.9,
    updated_at: Math.floor(Date.now() / 1000) - 600,
    effective_tvl_usd: 450_000_000,
    avg_pool_stress: 0.1,
    weighted_balance_ratio: 0.95,
    organic_fraction: 0.8,
    durability_score: 75,
    score_components_json: null,
    locked_liquidity_pct: null,
    methodology_version: "3.2",
  };
  return { ...defaults, ...overrides };
}

export function makeYieldHistoryRow(overrides: Partial<YieldHistoryRow> = {}): YieldHistoryRow {
  const defaults: YieldHistoryRow = {
    stablecoin_id: "usdt-tether",
    recorded_at: Math.floor(Date.now() / 1000) - 3600,
    apy: 5.2,
    apy_base: 4,
    apy_reward: 1.2,
    exchange_rate: 1.05,
    source_tvl_usd: 50_000_000,
    data_source: "defillama",
  };
  return { ...defaults, ...overrides };
}

export function makeDexLiquidityHistoryRow(overrides: Partial<DexLiquidityHistoryRow> = {}): DexLiquidityHistoryRow {
  const defaults: DexLiquidityHistoryRow = {
    stablecoin_id: "usdt-tether",
    total_tvl_usd: 500_000_000,
    total_volume_24h_usd: 10_000_000,
    liquidity_score: 85,
    snapshot_date: Math.floor(Date.now() / 1000) - 86400,
    methodology_version: "3.2",
  };
  return { ...defaults, ...overrides };
}

export function makeDigestRow(overrides: Partial<DigestRow> = {}): DigestRow {
  const defaults: DigestRow = {
    id: 1,
    digest_text: "Today's stablecoin market saw moderate activity.",
    digest_title: "Market Digest",
    generated_at: Math.floor(Date.now() / 1000) - 3600,
    digest_extended: null,
    input_data: null,
  };
  return { ...defaults, ...overrides };
}

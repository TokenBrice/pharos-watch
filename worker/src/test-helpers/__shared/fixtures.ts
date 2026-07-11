/**
 * Shared factory functions for test fixtures.
 * Each returns a complete row with sensible defaults; pass `overrides` for specific values.
 */

import type {
  BlacklistAmountSource,
  BlacklistAmountStatus,
  BlacklistStablecoin,
  StablecoinData,
} from "@shared/types/market";
import type { DexLiquidityRow } from "../../api/dex-liquidity-response";
import type { ApiKeyRow } from "../../lib/api-key-core";
import { mockD1 } from "./mock-d1";

type BlacklistRow = {
  id: string;
  stablecoin: BlacklistStablecoin;
  chain_id: string;
  chain_name: string;
  event_type: "blacklist" | "unblacklist" | "destroy";
  address: string;
  amount: number | null;
  amount_native: number | null;
  amount_usd_at_event: number | null;
  amount_source: BlacklistAmountSource;
  amount_status: BlacklistAmountStatus;
  tx_hash: string;
  block_number: number;
  timestamp: number;
  methodology_version: string | null;
  contract_address: string | null;
  config_key: string | null;
  event_signature: string | null;
  event_topic0: string | null;
  suppression_reason: string | null;
  amount_attempt_count?: number;
  amount_last_attempted_at?: number | null;
  amount_last_error_class?: string | null;
  amount_last_provider?: string | null;
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
  close_reason?: string | null;
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
  flow_type: "standard" | "atomic_roundtrip" | "bridge_transfer";
  counterparty: string | null;
  tx_hash: string;
  block_number: number;
  timestamp: number;
  explorer_tx_url: string;
};

type YieldHistoryRow = {
  stablecoin_id: string;
  source_key: string;
  recorded_at: number;
  is_best: number;
  apy: number;
  apy_base: number | null;
  apy_reward: number | null;
  exchange_rate: number | null;
  source_tvl_usd: number | null;
  data_source: string;
  warning_signals?: string | null;
  yield_source?: string | null;
  yield_type?: string | null;
  pys_at_publish?: number | null;
  safety_at_publish?: number | null;
  variance_at_publish?: number | null;
  pys_inputs_at_publish?: string | null;
};

type DexLiquidityHistoryRow = {
  stablecoin_id: string;
  total_tvl_usd: number;
  total_volume_24h_usd: number;
  liquidity_score: number | null;
  snapshot_date: number;
  coverage_class: string | null;
  coverage_confidence: number | null;
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

type ApiKeyFixtureRow = ApiKeyRow & Record<string, unknown>;
type DexLiquidityFixtureRow = DexLiquidityRow & Record<string, unknown>;

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
    priceUpdatedAt: Math.floor(Date.now() / 1000),
    priceObservedAt: Math.floor(Date.now() / 1000),
    priceObservedAtMode: "upstream",
    priceSyncedAt: Math.floor(Date.now() / 1000),
    consensusSources: [],
    agreeSources: [],
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

export function makeApiKeyRow(overrides: Partial<ApiKeyRow> = {}): ApiKeyFixtureRow {
  const defaults: ApiKeyRow = {
    id: 7,
    key_prefix: "0123456789abcdef",
    secret_hash: "hash",
    name: "Ops",
    owner_email: null,
    tier: "standard",
    traffic_class: "external",
    rate_limit_per_minute: 120,
    is_active: 1,
    expires_at: null,
    created_at: 1,
    updated_at: 1,
    last_used_at: null,
    last_used_route: null,
  };
  return { ...defaults, ...overrides } as ApiKeyFixtureRow;
}

export function makeReportCardsDb(assets: StablecoinData[] = [], nowSec = Math.floor(Date.now() / 1000)) {
  const cacheValue = JSON.stringify({ peggedAssets: assets });
  return mockD1([
    {
      match: "cache",
      rows: [
        { key: "stablecoins", value: cacheValue, updated_at: nowSec },
        { key: "bluechip-ratings", value: "{}", updated_at: nowSec },
      ],
      first: { key: "stablecoins", value: cacheValue, updated_at: nowSec },
    },
    { match: "dex_liquidity", rows: [] },
    { match: "depeg_events", rows: [] },
    { match: "supply_history", rows: [] },
  ]);
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
    amount_native: 1000,
    amount_usd_at_event: 1000,
    amount_source: "historical_balance",
    amount_status: "resolved",
    tx_hash: "0xtx1",
    block_number: 19000000,
    timestamp: Math.floor(Date.now() / 1000) - 3600,
    methodology_version: "3.1",
    contract_address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    config_key: "ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7",
    event_signature: "AddedBlackList(address)",
    event_topic0: "0x42e160154868087d6bfdc0ca23d96a1c1cfa32f1b72ba9ba27b69b98a0d819dc",
    suppression_reason: null,
    amount_attempt_count: 0,
    amount_last_attempted_at: null,
    amount_last_error_class: null,
    amount_last_provider: null,
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
    flow_type: "standard",
    counterparty: "0x000...000",
    tx_hash: "0xtx1",
    block_number: 19000000,
    timestamp: Math.floor(Date.now() / 1000) - 3600,
    explorer_tx_url: "https://etherscan.io/tx/0xtx1",
  };
  return { ...defaults, ...overrides };
}

export function makeDexLiquidityRow(overrides: Partial<DexLiquidityRow> = {}): DexLiquidityFixtureRow {
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
    coverage_class: "primary",
    coverage_confidence: 1,
    source_mix_json: '{"dl":{"poolCount":10,"tvlUsd":500000000}}',
    balance_measured_tvl_usd: 500_000_000,
    organic_measured_tvl_usd: 500_000_000,
    methodology_version: "3.2",
  };
  return { ...defaults, ...overrides } as DexLiquidityFixtureRow;
}

export function makeYieldHistoryRow(overrides: Partial<YieldHistoryRow> = {}): YieldHistoryRow {
  const defaults: YieldHistoryRow = {
    stablecoin_id: "usdt-tether",
    source_key: "aave-v3:usdt",
    recorded_at: Math.floor(Date.now() / 1000) - 3600,
    is_best: 1,
    apy: 5.2,
    apy_base: 4,
    apy_reward: 1.2,
    exchange_rate: 1.05,
    source_tvl_usd: 50_000_000,
    data_source: "defillama",
    warning_signals: "[]",
    yield_source: "Aave v3",
    yield_type: "lending-opportunity",
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
    coverage_class: "primary",
    coverage_confidence: 1,
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

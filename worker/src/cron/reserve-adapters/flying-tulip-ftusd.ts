import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonWithRetry,
  normalizeSlices,
  parseTimestampLikeToUnixSeconds,
  requireJsonInput,
} from "./helpers";

interface FlyingTulipCollateral {
  address?: string;
  symbol?: string;
  tvlAmountUsd?: number;
}

interface FlyingTulipStrategy {
  tokens?: {
    deposit?: string;
    borrow?: string[];
    staking?: string[];
  };
  leverage?: { value?: string };
  healthFactor?: { value?: string };
  currentBorrows?: { amountUsd?: string };
}

interface FlyingTulipChain {
  chainId?: number;
  chainName?: string;
  tvlUsd?: number;
  metrics?: { totalSupplyUsd?: number };
  collaterals?: FlyingTulipCollateral[];
  strategies?: FlyingTulipStrategy[];
}

interface FlyingTulipPayload {
  success?: boolean;
  lastUpdated?: string;
  chains?: FlyingTulipChain[];
}

const EXPECTED_CHAINS = new Map([
  [1, {
    name: "Ethereum",
    collaterals: new Map([
      ["USDC", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
      ["USDT", "0xdac17f958d2ee523a2206206994597c13d831ec7"],
    ]),
    borrow: "WETH",
    stake: "wstETH",
  }],
  [146, {
    name: "Sonic",
    collaterals: new Map([
      ["USDC", "0x29219dd400f2bf60e5a23d13be72b486d4038894"],
      ["USSD", "0x000000000eccff26b795f73fb0a70d48da657fef"],
    ]),
    borrow: "wS",
    stake: "stS",
  }],
] as const);

const SLICE_META: Record<string, Pick<ReserveSlice, "name" | "risk" | "coinId" | "depType">> = {
  USDC: {
    name: "USDC strategy wrappers (Ethereum and Sonic)",
    risk: "medium",
    coinId: "usdc-circle",
    depType: "collateral",
  },
  USDT: {
    name: "USDT strategy wrapper (Ethereum)",
    risk: "medium",
    coinId: "usdt-tether",
    depType: "collateral",
  },
  USSD: {
    name: "USSD strategy wrapper (Sonic)",
    risk: "medium",
    coinId: "ussd-sonic-labs",
    depType: "collateral",
  },
};

function requirePositiveFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`flying-tulip-ftusd ${label} must be a positive finite number`);
  }
  return value;
}

function parseDisplayNumber(value: string | undefined, label: string): number {
  const parsed = Number(value?.replace(/[$,x]/g, ""));
  return requirePositiveFinite(parsed, label);
}

export function adaptFlyingTulipFtUsd(payload: FlyingTulipPayload): AdapterResult {
  if (payload.success !== true) {
    throw new Error("flying-tulip-ftusd API did not return success=true");
  }
  const sourceTimestamp = parseTimestampLikeToUnixSeconds(payload.lastUpdated);
  if (sourceTimestamp == null) {
    throw new Error("flying-tulip-ftusd lastUpdated is missing or invalid");
  }

  const chains = payload.chains ?? [];
  if (chains.length !== EXPECTED_CHAINS.size) {
    throw new Error(`flying-tulip-ftusd expected ${EXPECTED_CHAINS.size} chains, received ${chains.length}`);
  }

  const collateralUsd = new Map<string, number>();
  const diagnostics: Array<Record<string, unknown>> = [];
  let totalReserveUsd = 0;
  let supplyUsd = 0;

  for (const [chainId, expected] of EXPECTED_CHAINS) {
    const chain = chains.find((candidate) => candidate.chainId === chainId);
    if (!chain || chain.chainName !== expected.name) {
      throw new Error(`flying-tulip-ftusd missing expected ${expected.name} chain payload`);
    }
    const chainTvlUsd = requirePositiveFinite(chain.tvlUsd, `${expected.name} tvlUsd`);
    const chainSupplyUsd = requirePositiveFinite(chain.metrics?.totalSupplyUsd, `${expected.name} totalSupplyUsd`);
    totalReserveUsd += chainTvlUsd;
    supplyUsd += chainSupplyUsd;

    const collaterals = chain.collaterals ?? [];
    if (collaterals.length !== expected.collaterals.size) {
      throw new Error(`flying-tulip-ftusd ${expected.name} collateral set changed`);
    }
    for (const [symbol, expectedAddress] of expected.collaterals) {
      const collateral = collaterals.find((candidate) => candidate.symbol === symbol);
      if (!collateral || collateral.address?.toLowerCase() !== expectedAddress) {
        throw new Error(`flying-tulip-ftusd ${expected.name} ${symbol} address changed or disappeared`);
      }
      const value = requirePositiveFinite(collateral.tvlAmountUsd, `${expected.name} ${symbol} tvlAmountUsd`);
      collateralUsd.set(symbol, (collateralUsd.get(symbol) ?? 0) + value);
    }

    const strategy = (chain.strategies ?? []).find((candidate) =>
      candidate.tokens?.borrow?.includes(expected.borrow) && candidate.tokens?.staking?.includes(expected.stake)
    );
    if (!strategy) {
      throw new Error(`flying-tulip-ftusd ${expected.name} borrow/stake strategy disappeared`);
    }
    diagnostics.push({
      chainId,
      chainName: expected.name,
      deposit: strategy.tokens?.deposit,
      borrow: expected.borrow,
      stake: expected.stake,
      leverage: parseDisplayNumber(strategy.leverage?.value, `${expected.name} leverage`),
      healthFactor: parseDisplayNumber(strategy.healthFactor?.value, `${expected.name} health factor`),
      borrowUsd: parseDisplayNumber(strategy.currentBorrows?.amountUsd, `${expected.name} borrow USD`),
      supplyUsd: chainSupplyUsd,
      tvlUsd: chainTvlUsd,
    });
  }

  const classifiedCollateralUsd = [...collateralUsd.values()].reduce((sum, value) => sum + value, 0);
  if (Math.abs(classifiedCollateralUsd - totalReserveUsd) / totalReserveUsd > 0.001) {
    throw new Error("flying-tulip-ftusd collateral rows do not reconcile to cross-chain TVL");
  }

  return {
    slices: normalizeSlices([...collateralUsd.entries()].map(([symbol, value]) => ({
      ...SLICE_META[symbol],
      pct: (value / classifiedCollateralUsd) * 100,
    }))),
    metadata: {
      sourceTimestamp,
      freshnessMode: "verified",
      totalReserveUsd,
      supplyUsd,
      collateralizationRatio: totalReserveUsd / supplyUsd,
      unknownExposurePct: 0,
      details: {
        sourceOperator: "Flying Tulip",
        assurance: "issuer-operated telemetry; no independent attestation",
        strategies: diagnostics,
      },
    },
  };
}

export async function fetchFlyingTulipFtUsdReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, "flying-tulip-ftusd");
  const payload = await fetchJsonWithRetry<FlyingTulipPayload>(input.url, signal, 10_000, ctx);
  return adaptFlyingTulipFtUsd(payload);
}

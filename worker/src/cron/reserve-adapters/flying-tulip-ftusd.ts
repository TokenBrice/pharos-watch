import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonWithRetry,
  normalizeSlices,
  parseTimestampLikeToUnixSeconds,
  requireJsonInput,
  sameRunRenderClockFreshnessMetadata,
} from "./helpers";
import { reserveDegradedWarning, reserveInfoWarning } from "./warnings";

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

type ExpectedChainProfile = {
  name: string;
  collaterals: ReadonlyMap<string, string>;
  /** Borrow-and-stake carry leg (validated and surfaced as diagnostics). A chain
   *  may launch lend-only wrappers before its leverage profile is reviewed, in which
   *  case neither field is set and no strategy pin applies. */
  borrow?: string;
  stake?: string;
};

const EXPECTED_CHAINS: ReadonlyMap<number, ExpectedChainProfile> = new Map([
  [1, {
    name: "Ethereum",
    collaterals: new Map([
      ["USDC", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
      ["USDT", "0xdac17f958d2ee523a2206206994597c13d831ec7"],
      ["USDe", "0x4c9edd5852cd905f086c759e8383e09bff1e68b3"],
      ["crvUSD", "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e"],
      ["USDG", "0xe343167631d89b6ffc58b88d6b7fb0228795491d"],
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
  [56, {
    name: "BNB Smart Chain",
    collaterals: new Map([
      ["USDC", "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d"],
      ["USDT", "0x55d398326f99059ff775485246999027b3197955"],
      ["FDUSD", "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409"],
    ]),
    borrow: "WBNB",
    stake: "asBNB",
  }],
]);

const SLICE_META: Record<string, Pick<ReserveSlice, "name" | "risk" | "coinId" | "depType">> = {
  USDC: {
    name: "USDC strategy wrappers (Ethereum, Sonic, and BNB Smart Chain)",
    risk: "medium",
    coinId: "usdc-circle",
    depType: "collateral",
  },
  USDT: {
    name: "USDT strategy wrappers (Ethereum and BNB Smart Chain)",
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
  FDUSD: {
    name: "FDUSD strategy wrapper (BNB Smart Chain)",
    risk: "medium",
    coinId: "fdusd-first-digital",
    depType: "collateral",
  },
  USDe: {
    name: "USDe strategy wrapper (Ethereum)",
    risk: "medium",
    coinId: "usde-ethena",
    depType: "collateral",
  },
  crvUSD: {
    name: "crvUSD strategy wrapper (Ethereum)",
    risk: "medium",
    coinId: "crvusd-curve",
    depType: "collateral",
  },
  USDG: {
    name: "USDG strategy wrapper (Ethereum)",
    risk: "medium",
    coinId: "usdg-paxos",
    depType: "collateral",
  },
};

function requirePositiveFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`flying-tulip-ftusd ${label} must be a positive finite number`);
  }
  return value;
}

function requireNonNegativeFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`flying-tulip-ftusd ${label} must be a non-negative finite number`);
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

  const payloadChains = payload.chains ?? [];
  // A chain that ships with zero TVL and zero supply (e.g. a chain ahead of its
  // launch) is an inactive placeholder carrying no reserve yet.
  const chainIsActive = (chain: FlyingTulipChain) =>
    chain.tvlUsd !== 0 || chain.metrics?.totalSupplyUsd !== 0;

  const collateralUsd = new Map<string, number>();
  const unreviewedCollateralUsd = new Map<string, { name: string; value: number }>();
  const diagnostics: Array<Record<string, unknown>> = [];
  const warnings: LiveReserveWarning[] = [];
  let totalReserveUsd = 0;
  let supplyUsd = 0;

  // Every reviewed chain must be present. Present collateral rows retain exact
  // identity pins, but zero-capital slots may be added or omitted.
  for (const [chainId, expected] of EXPECTED_CHAINS) {
    const chain = payloadChains.find((candidate) => candidate.chainId === chainId);
    if (!chain) {
      throw new Error(`flying-tulip-ftusd missing expected ${expected.name} chain payload`);
    }
    if (!chainIsActive(chain)) continue;

    if (chain.chainName !== expected.name) {
      throw new Error(`flying-tulip-ftusd missing expected ${expected.name} chain payload`);
    }
    const chainTvlUsd = requirePositiveFinite(chain.tvlUsd, `${expected.name} tvlUsd`);
    const chainSupplyUsd = requirePositiveFinite(chain.metrics?.totalSupplyUsd, `${expected.name} totalSupplyUsd`);
    totalReserveUsd += chainTvlUsd;
    supplyUsd += chainSupplyUsd;

    const seenCollaterals = new Set<string>();
    for (const collateral of chain.collaterals ?? []) {
      const symbol = collateral.symbol;
      const address = collateral.address?.toLowerCase();
      const value = requireNonNegativeFinite(collateral.tvlAmountUsd, `${expected.name} ${symbol} tvlAmountUsd`);
      if (!symbol || !address || !/^0x[0-9a-f]{40}$/.test(address)) {
        throw new Error(`flying-tulip-ftusd ${expected.name} collateral identity is missing or invalid`);
      }
      if (seenCollaterals.has(address)) {
        throw new Error(`flying-tulip-ftusd ${expected.name} duplicate collateral address`);
      }
      seenCollaterals.add(address);
      const expectedAddress = expected.collaterals.get(symbol);
      if (expectedAddress && address !== expectedAddress) {
        throw new Error(`flying-tulip-ftusd ${expected.name} ${symbol} address changed or disappeared`);
      }
      if (value === 0) continue;
      if (expectedAddress) {
        collateralUsd.set(symbol, (collateralUsd.get(symbol) ?? 0) + value);
      } else {
        const sourceKey = `flying-tulip-ftusd:unreviewed:${chainId}:${address}`;
        unreviewedCollateralUsd.set(sourceKey, { name: `Unreviewed ${symbol} collateral (${expected.name})`, value });
        warnings.push(reserveInfoWarning(
          "flying-tulip-ftusd-unreviewed-collateral",
          `Unreviewed positive collateral retained without a dependency link: ${expected.name} ${symbol} ${address}`,
        ));
      }
    }

    // Only chains with a reviewed borrow-and-stake profile pin a strategy and emit
    // carry diagnostics; BNB Smart Chain launched 2026-09-24 carrying WBNB/asBNB.
    if (!expected.borrow || !expected.stake) continue;
    const borrow = expected.borrow;
    const stake = expected.stake;
    const strategy = (chain.strategies ?? []).find((candidate) =>
      candidate.tokens?.borrow?.includes(borrow) && candidate.tokens?.staking?.includes(stake)
    );
    if (!strategy) {
      throw new Error(`flying-tulip-ftusd ${expected.name} borrow/stake strategy disappeared`);
    }
    diagnostics.push({
      chainId,
      chainName: expected.name,
      deposit: strategy.tokens?.deposit,
      borrow,
      stake,
      leverage: parseDisplayNumber(strategy.leverage?.value, `${expected.name} leverage`),
      healthFactor: parseDisplayNumber(strategy.healthFactor?.value, `${expected.name} health factor`),
      borrowUsd: parseDisplayNumber(strategy.currentBorrows?.amountUsd, `${expected.name} borrow USD`),
      supplyUsd: chainSupplyUsd,
      tvlUsd: chainTvlUsd,
    });
  }

  // An active chain outside the reviewed set means Flying Tulip deployed somewhere we
  // have not reviewed. Surface it as a degraded warning (snapshot stored, scoring
  // blocked) rather than throwing, so a new deployment never flips the coin to error.
  for (const chain of payloadChains) {
    if (chain.chainId !== undefined && EXPECTED_CHAINS.has(chain.chainId)) continue;
    if (!chainIsActive(chain)) continue;
    const label = chain.chainName ? `${chain.chainName} (chain ${chain.chainId})` : `chain ${chain.chainId}`;
    warnings.push(
      reserveDegradedWarning(
        "unexpected-chain",
        `flying-tulip-ftusd payload carries an active chain outside the reviewed set: ${label}`,
      ),
    );
  }

  const unknownCollateralUsd = [...unreviewedCollateralUsd.values()].reduce((sum, row) => sum + row.value, 0);
  const classifiedCollateralUsd = [...collateralUsd.values()].reduce((sum, value) => sum + value, 0) + unknownCollateralUsd;
  requirePositiveFinite(classifiedCollateralUsd, "total collateral USD");
  if (Math.abs(classifiedCollateralUsd - totalReserveUsd) / totalReserveUsd > 0.001) {
    throw new Error("flying-tulip-ftusd collateral rows do not reconcile to cross-chain TVL");
  }

  // `lastUpdated` is the API's own render/response clock (it tracks request
  // time), so the verified timestamp is stamped with that basis explicitly.
  const freshness = sameRunRenderClockFreshnessMetadata(sourceTimestamp);

  return {
    slices: normalizeSlices([
      ...[...collateralUsd.entries()].map(([symbol, value]) => ({
        ...SLICE_META[symbol],
        sourceKey: `flying-tulip-ftusd:collateral:${symbol.toLowerCase()}`,
        pct: (value / classifiedCollateralUsd) * 100,
      })),
      ...[...unreviewedCollateralUsd.entries()].map(([sourceKey, row]) => ({
        sourceKey,
        name: row.name,
        risk: "high" as const,
        pct: (row.value / classifiedCollateralUsd) * 100,
      })),
    ], null),
    warnings,
    metadata: {
      ...freshness,
      totalReserveUsd,
      supplyUsd,
      collateralizationRatio: totalReserveUsd / supplyUsd,
      unknownExposurePct: (unknownCollateralUsd / classifiedCollateralUsd) * 100,
      details: {
        ...freshness.details,
        sourceOperator: "Flying Tulip",
        assurance: "first-party index of publicly verifiable on-chain reserve state",
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

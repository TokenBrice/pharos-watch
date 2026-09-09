import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem/utils";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { getPublicRpcUrl, getSecondaryFallbackRpcUrl } from "../../lib/public-rpc-registry";
import { throwIfAborted } from "../../lib/abort";
import { executeEvmObservationPlan, pinnedBlockPlan, rawObservation } from "./evm-observation-plan";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchDefiLlamaPrices,
  fetchOnchainMulticall3,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  reserveDegradedWarning,
  reserveInfoWarning,
  slicesFromValues,
  valueUsdFromBigIntPrice,
} from "./helpers";
import type { OnchainMulticall3Call } from "./helpers";
import { validateDecimals, worseRisk } from "./slice-math";

const ADAPTER_KEY = "money-llamma";

// defi.money is a Curve crvUSD fork: the main controller enumerates LLAMMA
// MarketOperator contracts, each holding collateral in Curve-style bands
// (bands_x = MONEY from soft liquidations, bands_y = collateral, both scaled
// to 18 decimals) against MONEY debt. Same address on all three chains.
const MONEY_CONTROLLER = "0x1337F001E280420EcCe9E7B934Fa07D67fdb62CD";
const MONEY_TOKEN = "0x69420f9E38a4e60a62224C489be4BF7a94402496";
const CHAIN_LEGS = ["arbitrum", "base", "optimism"] as const;
const MONEY_MAX_MARKETS_PER_CHAIN = 256;
const MONEY_MAX_BANDS_PER_MARKET = 2_048;
const LLAMMA_MULTICALL_BATCH_SIZE = 500;
const MONEY_PAR_DEVIATION_INFO_PCT = 1;

const MONEY_CONTROLLER_ABI = parseAbi([
  "function get_market_count() view returns (uint256)",
  "function get_all_markets() view returns (address[])",
]);
const MONEY_MARKET_OPERATOR_ABI = parseAbi([
  "function COLLATERAL_TOKEN() view returns (address)",
  "function AMM() view returns (address)",
  "function total_debt() view returns (uint256)",
]);
const MONEY_LLAMMA_ABI = parseAbi([
  "function min_band() view returns (int256)",
  "function max_band() view returns (int256)",
  "function bands_x(int256) view returns (uint256)",
  "function bands_y(int256) view returns (uint256)",
]);
const MONEY_ERC20_METADATA_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);

// Reviewed slice identities. WBTC/WETH/wstETH join the canonical reserve
// taxonomy; every other accepted collateral is measured and priced but grouped
// under a single reviewed "other" bucket (ARB, GMX, LINK, PENDLE, OP, …). The
// grouped keys match the reviewed sidecar rows.
function classifyCollateral(symbol: string): { name: string; sourceKey: string; risk: ReserveSlice["risk"] } {
  const upper = symbol.toUpperCase();
  if (upper === "WBTC") {
    return { name: "Custodied BTC (WBTC)", sourceKey: `${ADAPTER_KEY}:wbtc`, risk: getCanonicalReserveAssetRisk("WBTC") ?? "medium" };
  }
  if (upper === "WETH" || upper === "ETH") {
    return { name: "ETH", sourceKey: `${ADAPTER_KEY}:weth`, risk: getCanonicalReserveAssetRisk("ETH") ?? "very-low" };
  }
  if (upper === "WSTETH") {
    return { name: "wstETH", sourceKey: `${ADAPTER_KEY}:wsteth`, risk: getCanonicalReserveAssetRisk("WSTETH") ?? "low" };
  }
  return {
    name: `Other LLAMMA collateral (${upper})`,
    sourceKey: `${ADAPTER_KEY}:other-${upper.toLowerCase()}`,
    risk: "high",
  };
}

interface ChainLeg {
  chain: (typeof CHAIN_LEGS)[number];
  rpcUrl?: string;
  fallbackRpcUrl?: string;
}

const CHAIN_LEG_PLANS: readonly ChainLeg[] = CHAIN_LEGS.map((chain) => ({
  chain,
  rpcUrl: getPublicRpcUrl(chain),
  fallbackRpcUrl: getSecondaryFallbackRpcUrl(chain),
}));

interface MarketDescriptor {
  marketId: number;
  operator: string;
  collateralAddress: string;
  ammAddress: string;
  symbol: string;
  decimals: number;
  debtTokens: number;
  minBand: number;
  maxBand: number;
}

interface MarketExposure extends MarketDescriptor {
  collateralUsd: number;
  softLiquidatedMoneyTokens: number;
  bandCount: number;
}

interface ChainCensus {
  chain: (typeof CHAIN_LEGS)[number];
  block: { number: number; timestamp: number };
  markets: MarketExposure[];
  supplyTokens: number;
}

interface PricedMarketInput {
  descriptor: Omit<MarketDescriptor, "collateralUsd" | "softLiquidatedMoneyTokens" | "bandCount">;
  bandsY: bigint;
  bandsX: bigint;
}

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

function safeInt256ToNumber(value: bigint, label: string): number {
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    throw new Error(`${ADAPTER_KEY}: ${label} out of safe integer range: ${value.toString()}`);
  }
  return asNumber;
}

async function fetchChainMulticall(
  chain: (typeof CHAIN_LEGS)[number],
  calls: readonly OnchainMulticall3Call[],
  label: string,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
  leg: ChainLeg,
): Promise<Map<string, `0x${string}`>> {
  if (calls.length === 0) return new Map();
  const snapshot = await executeEvmObservationPlan({
    adapterKey: `${ADAPTER_KEY} ${label} on ${chain}`,
    fields: calls.map((entry) =>
      rawObservation({ label: entry.label, contract: entry.contract, data: entry.data, allowFailure: entry.allowFailure }),
    ),
    read: (planCalls) =>
      fetchOnchainMulticall3({
        calls: planCalls,
        chain,
        signal,
        ctx,
        rpcUrl: leg.rpcUrl,
        fallbackRpcUrl: leg.fallbackRpcUrl,
        timeoutMs: 20_000,
        multicallBatchSize: LLAMMA_MULTICALL_BATCH_SIZE,
      }),
  });
  return new Map(snapshot.rawByLabel);
}

function requireResult(results: ReadonlyMap<string, `0x${string}`>, label: string, context: string): `0x${string}` {
  const data = results.get(label);
  if (!data) {
    throw new Error(`${ADAPTER_KEY}: ${context} multicall missing result: ${label}`);
  }
  return data;
}

async function fetchChainCensus(
  leg: ChainLeg,
  signal: AbortSignal,
  warnings: LiveReserveWarning[],
  ctx?: AdapterContext,
): Promise<ChainCensus> {
  const { chain } = leg;

  // Controller market enumeration + MONEY supply, one pinned batch.
  const head = await fetchChainMulticall(
    chain,
    [
      { label: "market_count", contract: MONEY_CONTROLLER, data: encodeFunctionData({ abi: MONEY_CONTROLLER_ABI, functionName: "get_market_count" }) },
      { label: "all_markets", contract: MONEY_CONTROLLER, data: encodeFunctionData({ abi: MONEY_CONTROLLER_ABI, functionName: "get_all_markets" }) },
      { label: "money_supply", contract: MONEY_TOKEN, data: encodeFunctionData({ abi: MONEY_ERC20_METADATA_ABI, functionName: "totalSupply" }) },
    ],
    "head",
    signal,
    ctx,
    leg,
  );

  const marketCountRaw = decodeFunctionResult({
    abi: MONEY_CONTROLLER_ABI,
    functionName: "get_market_count",
    data: requireResult(head, "market_count", "head"),
  }) as bigint;
  const marketCount = safeInt256ToNumber(marketCountRaw, "get_market_count");
  if (marketCount < 0 || marketCount > MONEY_MAX_MARKETS_PER_CHAIN) {
    throw new Error(`${ADAPTER_KEY}: ${chain} market count invalid: ${marketCountRaw}`);
  }
  const operators = decodeFunctionResult({
    abi: MONEY_CONTROLLER_ABI,
    functionName: "get_all_markets",
    data: requireResult(head, "all_markets", "head"),
  }) as readonly string[];
  if (operators.length !== marketCount) {
    throw new Error(`${ADAPTER_KEY}: ${chain} get_all_markets returned ${operators.length} entries for count ${marketCount}`);
  }
  const supplyTokens = Number(decodeFunctionResult({
    abi: MONEY_ERC20_METADATA_ABI,
    functionName: "totalSupply",
    data: requireResult(head, "money_supply", "head"),
  }) as bigint) / 1e18;
  if (!Number.isFinite(supplyTokens)) {
    throw new Error(`${ADAPTER_KEY}: ${chain} MONEY supply overflows the number range`);
  }

  // Per-market operator linkage and debt.
  const operatorResults = await fetchChainMulticall(
    chain,
    operators.flatMap((operator, marketId): OnchainMulticall3Call[] => [
      { label: `${marketId}:collateral`, contract: operator, data: encodeFunctionData({ abi: MONEY_MARKET_OPERATOR_ABI, functionName: "COLLATERAL_TOKEN" }) },
      { label: `${marketId}:amm`, contract: operator, data: encodeFunctionData({ abi: MONEY_MARKET_OPERATOR_ABI, functionName: "AMM" }) },
      { label: `${marketId}:debt`, contract: operator, data: encodeFunctionData({ abi: MONEY_MARKET_OPERATOR_ABI, functionName: "total_debt" }) },
    ]),
    "operators",
    signal,
    ctx,
    leg,
  );

  const descriptors = operators.map((operator, marketId): MarketDescriptor => {
    throwIfAborted(signal);
    const collateralAddress = normalizeAddress(
      decodeFunctionResult({
        abi: MONEY_MARKET_OPERATOR_ABI,
        functionName: "COLLATERAL_TOKEN",
        data: requireResult(operatorResults, `${marketId}:collateral`, "operators"),
      }) as string,
    );
    const ammAddress = normalizeAddress(
      decodeFunctionResult({
        abi: MONEY_MARKET_OPERATOR_ABI,
        functionName: "AMM",
        data: requireResult(operatorResults, `${marketId}:amm`, "operators"),
      }) as string,
    );
    const debtRaw = decodeFunctionResult({
      abi: MONEY_MARKET_OPERATOR_ABI,
      functionName: "total_debt",
      data: requireResult(operatorResults, `${marketId}:debt`, "operators"),
    }) as bigint;
    const debtTokens = Number(debtRaw) / 1e18;
    if (!Number.isFinite(debtTokens)) {
      throw new Error(`${ADAPTER_KEY}: ${chain} market ${marketId} debt overflows the number range`);
    }
    return { marketId, operator: normalizeAddress(operator), collateralAddress, ammAddress, symbol: "", decimals: 18, debtTokens, minBand: 0, maxBand: 0 };
  });

  // Collateral identity + band span.
  const metadataResults = await fetchChainMulticall(
    chain,
    descriptors.flatMap((market): OnchainMulticall3Call[] => [
      { label: `${market.marketId}:symbol`, contract: market.collateralAddress, data: encodeFunctionData({ abi: MONEY_ERC20_METADATA_ABI, functionName: "symbol" }) },
      { label: `${market.marketId}:decimals`, contract: market.collateralAddress, data: encodeFunctionData({ abi: MONEY_ERC20_METADATA_ABI, functionName: "decimals" }) },
      { label: `${market.marketId}:min_band`, contract: market.ammAddress, data: encodeFunctionData({ abi: MONEY_LLAMMA_ABI, functionName: "min_band" }) },
      { label: `${market.marketId}:max_band`, contract: market.ammAddress, data: encodeFunctionData({ abi: MONEY_LLAMMA_ABI, functionName: "max_band" }) },
    ]),
    "metadata",
    signal,
    ctx,
    leg,
  );

  for (const market of descriptors) {
    throwIfAborted(signal);
    const symbolRaw = decodeFunctionResult({
      abi: MONEY_ERC20_METADATA_ABI,
      functionName: "symbol",
      data: requireResult(metadataResults, `${market.marketId}:symbol`, "metadata"),
    });
    if (typeof symbolRaw !== "string" || symbolRaw.length === 0) {
      throw new Error(`${ADAPTER_KEY}: ${chain} collateral symbol unreadable for market ${market.marketId}`);
    }
    market.symbol = symbolRaw;
    market.decimals = validateDecimals(
      decodeFunctionResult({
        abi: MONEY_ERC20_METADATA_ABI,
        functionName: "decimals",
        data: requireResult(metadataResults, `${market.marketId}:decimals`, "metadata"),
      }),
      `${ADAPTER_KEY} ${chain} decimals for market ${market.marketId}`,
    );
    market.minBand = safeInt256ToNumber(
      decodeFunctionResult({
        abi: MONEY_LLAMMA_ABI,
        functionName: "min_band",
        data: requireResult(metadataResults, `${market.marketId}:min_band`, "metadata"),
      }) as bigint,
      `market ${market.marketId} min_band`,
    );
    market.maxBand = safeInt256ToNumber(
      decodeFunctionResult({
        abi: MONEY_LLAMMA_ABI,
        functionName: "max_band",
        data: requireResult(metadataResults, `${market.marketId}:max_band`, "metadata"),
      }) as bigint,
      `market ${market.marketId} max_band`,
    );
    const bandCount = market.maxBand - market.minBand + 1;
    if (bandCount < 1 || bandCount > MONEY_MAX_BANDS_PER_MARKET) {
      throw new Error(`${ADAPTER_KEY}: ${chain} band span invalid for market ${market.marketId}: ${market.minBand}..${market.maxBand}`);
    }
  }

  // Band balances (collateral y + soft-liquidated MONEY x).
  const bandCalls: OnchainMulticall3Call[] = [];
  for (const market of descriptors) {
    for (let band = market.minBand; band <= market.maxBand; band += 1) {
      bandCalls.push({
        label: `${market.marketId}:y:${band}`,
        contract: market.ammAddress,
        data: encodeFunctionData({ abi: MONEY_LLAMMA_ABI, functionName: "bands_y", args: [BigInt(band)] }),
      });
      bandCalls.push({
        label: `${market.marketId}:x:${band}`,
        contract: market.ammAddress,
        data: encodeFunctionData({ abi: MONEY_LLAMMA_ABI, functionName: "bands_x", args: [BigInt(band)] }),
      });
    }
  }
  const bandResults = await fetchChainMulticall(chain, bandCalls, "bands", signal, ctx, leg);

  const rawByMarket = new Map<number, PricedMarketInput>();
  for (const [label, returnData] of bandResults) {
    const [marketPart, axis] = label.split(":");
    const marketId = Number(marketPart);
    const entry = rawByMarket.get(marketId) ?? { descriptor: descriptors[marketId], bandsY: 0n, bandsX: 0n };
    if (axis === "y") {
      entry.bandsY += decodeFunctionResult({
        abi: MONEY_LLAMMA_ABI,
        functionName: "bands_y",
        data: returnData,
      }) as bigint;
    } else if (axis === "x") {
      entry.bandsX += decodeFunctionResult({
        abi: MONEY_LLAMMA_ABI,
        functionName: "bands_x",
        data: returnData,
      }) as bigint;
    }
    rawByMarket.set(marketId, entry);
  }

  // Price every collateral token that holds bands (plus MONEY, fetched by the
  // caller after all chains are censused). Missing price fails closed below.
  const active = [...rawByMarket.values()].filter((entry) => entry.bandsY > 0n || entry.bandsX > 0n || entry.descriptor.debtTokens > 0);
  if (active.length === 0) {
    return { chain, block: { number: 0, timestamp: 0 }, markets: [], supplyTokens };
  }
  const priceMap = await fetchDefiLlamaPrices(
    active.map((entry) => ({
      key: entry.descriptor.collateralAddress,
      chain,
      address: entry.descriptor.collateralAddress,
    })),
    signal,
    ctx,
    warnings,
  );

  const markets: MarketExposure[] = active.map((entry) => {
    const price = priceMap.get(entry.descriptor.collateralAddress);
    if (price == null) {
      throw new Error(`${ADAPTER_KEY}: missing DefiLlama price for ${chain} market ${entry.descriptor.marketId} (${entry.descriptor.symbol})`);
    }
    return {
      ...entry.descriptor,
      // LLAMMA bands_y/bands_x are normalized to 18 decimals by the AMM.
      collateralUsd: valueUsdFromBigIntPrice(entry.bandsY, 18, price),
      softLiquidatedMoneyTokens: Number(entry.bandsX) / 1e18,
      bandCount: entry.descriptor.maxBand - entry.descriptor.minBand + 1,
    };
  });

  return { chain, block: { number: 0, timestamp: 0 }, markets, supplyTokens };
}

export function adaptMoneyCensuses(
  censuses: readonly ChainCensus[],
  extraWarnings: readonly LiveReserveWarning[] = [],
  liabilityValuation: "market" | "par" = "market",
): AdapterResult {
  const warnings: LiveReserveWarning[] = [...extraWarnings];

  const buckets = new Map<string, { name: string; usd: number; risk: ReserveSlice["risk"] }>();
  let totalCollateralUsd = 0;
  let totalDebtTokens = 0;
  let softLiquidatedMoneyTokens = 0;
  let bandReadCount = 0;
  let marketCount = 0;

  for (const census of censuses) {
    for (const market of census.markets) {
      marketCount += 1;
      bandReadCount += market.bandCount;
      totalCollateralUsd += market.collateralUsd;
      totalDebtTokens += market.debtTokens;
      softLiquidatedMoneyTokens += market.softLiquidatedMoneyTokens;
      const classified = classifyCollateral(market.symbol);
      const existing = buckets.get(classified.sourceKey);
      if (existing) {
        existing.usd += market.collateralUsd;
        existing.risk = worseRisk(existing.risk, classified.risk);
      } else {
        buckets.set(classified.sourceKey, { name: classified.name, usd: market.collateralUsd, risk: classified.risk });
      }
    }
  }

  if (totalCollateralUsd <= 0) {
    throw new Error(`${ADAPTER_KEY}: no priced LLAMMA collateral could be measured across ${censuses.length} chains`);
  }

  const slices = slicesFromValues(
    [...buckets.entries()].map(([sourceKey, bucket]) => ({
      sourceKey,
      name: bucket.name,
      value: bucket.usd,
      risk: bucket.risk,
    })),
  );

  const supplyTokens = censuses.reduce((sum, census) => sum + census.supplyTokens, 0);

  const details = {
    proofKind: "defi-money-llamma-onchain-census",
    liabilityValuation,
    chains: censuses.map((census) => ({
      chain: census.chain,
      blockNumber: census.block.number,
      blockTimestamp: census.block.timestamp,
      marketCount: census.markets.length,
    })),
    controller: MONEY_CONTROLLER,
    softLiquidatedMoneyTokens,
    bandReadCount,
  };

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata(details),
      totalReserveUsd: totalCollateralUsd,
      totalLiabilitiesUsd: totalDebtTokens,
      totalLiabilitiesTokens: totalDebtTokens,
      supplyTokens,
      marketCount,
      ...(totalDebtTokens > 0 ? { collateralizationRatio: totalCollateralUsd / totalDebtTokens } : {}),
    },
  };
}

export async function fetchMoneyReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  requireOnchainInput(config.inputs.primary, ADAPTER_KEY);

  const censuses: ChainCensus[] = [];
  const warnings: LiveReserveWarning[] = [];
  const chainBlocks: Array<{ chain: string; number: number; timestamp: number }> = [];

  for (const leg of CHAIN_LEG_PLANS) {
    throwIfAborted(signal);
    const plan = await pinnedBlockPlan({
      chain: leg.chain,
      signal,
      ctx,
      rpcUrl: leg.rpcUrl,
      fallbackRpcUrl: leg.fallbackRpcUrl,
    });
    const census = await fetchChainCensus(leg, signal, warnings, plan.ctx);
    census.block = { number: plan.observedBlock.number, timestamp: plan.observedBlock.timestamp };
    censuses.push(census);
    chainBlocks.push({ chain: leg.chain, number: plan.observedBlock.number, timestamp: plan.observedBlock.timestamp });
  }

  // Collateral always prices via DefiLlama and fails closed. The MONEY debt
  // liability is market-valued when DefiLlama quotes MONEY; with no quote it
  // falls back to par (debt is denominated in MONEY, so par is the neutral
  // unit of account) instead of failing the whole census.
  const moneyPriceMap = await fetchDefiLlamaPrices(
    CHAIN_LEGS.map((chain) => ({ key: `money:${chain}`, chain, address: MONEY_TOKEN })),
    signal,
    ctx,
    warnings,
  );
  const moneyPrice = moneyPriceMap.get(MONEY_TOKEN) ?? moneyPriceMap.get(`money:${CHAIN_LEGS[0]}`);
  const marketPrice = moneyPrice != null && Number.isFinite(moneyPrice) && moneyPrice > 0 ? moneyPrice : null;
  const liabilityPrice = marketPrice ?? 1;
  const liabilityValuation: "market" | "par" = marketPrice == null ? "par" : "market";

  const totalDebtTokens = censuses.reduce((sum, census) => sum + census.markets.reduce((acc, m) => acc + m.debtTokens, 0), 0);
  const totalCollateralUsd = censuses.reduce((sum, census) => sum + census.markets.reduce((acc, m) => acc + m.collateralUsd, 0), 0);

  const result = adaptMoneyCensuses(censuses, warnings, liabilityValuation);
  const primaryBlock = chainBlocks.find((block) => block.chain === "arbitrum") ?? chainBlocks[0];

  const finalWarnings: LiveReserveWarning[] = [...(result.warnings ?? [])];
  if (marketPrice != null && Math.abs(marketPrice - 1) > MONEY_PAR_DEVIATION_INFO_PCT / 100) {
    finalWarnings.push(
      reserveInfoWarning(
        "money-off-par",
        `${ADAPTER_KEY}: MONEY market price ${marketPrice.toFixed(6)} deviates from par; liabilities are market-valued`,
      ),
    );
  }
  if (liabilityValuation === "par") {
    finalWarnings.push(
      reserveInfoWarning(
        "liability-valued-at-par",
        `${ADAPTER_KEY}: no DefiLlama market price for MONEY token ${MONEY_TOKEN}; liabilities valued at par`,
      ),
    );
  }
  if (totalDebtTokens > 0 && totalCollateralUsd / (totalDebtTokens * liabilityPrice) < 1) {
    finalWarnings.push(
      reserveDegradedWarning(
        "reserve-undercollateralized",
        `${ADAPTER_KEY}: LLAMMA collateral covers ${((totalCollateralUsd / (totalDebtTokens * liabilityPrice)) * 100).toFixed(2)}% of ${
          liabilityValuation === "par" ? "par-valued" : "market-valued"
        } MONEY debt`,
      ),
    );
  }

  return {
    slices: result.slices,
    ...(finalWarnings.length > 0 ? { warnings: finalWarnings } : {}),
    metadata: {
      ...result.metadata,
      ...(marketPrice != null ? { moneyPriceUsd: marketPrice } : {}),
      totalLiabilitiesUsd: totalDebtTokens * liabilityPrice,
      supplyUsd: (result.metadata?.supplyTokens ?? 0) * liabilityPrice,
      ...(primaryBlock ? { observedBlock: { chain: primaryBlock.chain, number: primaryBlock.number, timestamp: primaryBlock.timestamp } } : {}),
      allChainBlocks: chainBlocks,
    },
  };
}

import { decodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, type ParseAbi } from "viem/utils";
import {
  addressObservation,
  boolObservation,
  customObservation,
  executeEvmObservationPlan,
  pinnedBlockPlan,
  uint256Observation,
} from "./evm-observation-plan";
import type { LiveReserveInput } from "@shared/types/live-reserves";
import type { LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import {
  decodeMentoPoolExchange,
  mentoSpreadToFeeBps,
  MENTO_BIPOOL_MANAGER_ADDRESS,
  MENTO_GET_EXCHANGE_IDS_SELECTOR,
  MENTO_GET_POOL_EXCHANGE_SELECTOR,
  MENTO_POOL_SPREAD_FIXIDITY_SCALE,
  type MentoPoolExchange,
} from "@shared/lib/mento-contracts";
import type { AdapterContext, AdapterResult } from "./types";
import { decodeBytes32ArrayWord, decodeUint256Word } from "./abi-decode";
import {
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  fetchErc20TotalSupply,
  fetchOnchainMulticall3,
  fetchOnchainRateBps,
  fetchOnchainRawCall,
  fetchOnchainUint256,
} from "./helpers";
import { throwIfAborted } from "../../lib/abort";
import { getCachedRequest } from "./request";

// --- Redemption telemetry ---------------------------------------------------
//
// Independent per-coin on-chain reads on Celo (chain id 42220), run after the
// analytics-API reserve composition. Three shapes, matching how each Mento
// family member actually redeems:
//   - broker-pool: coin trades against a stable/USDm counter asset in a Mento
//     V2 Broker/BiPoolManager pool (cUSD/USDm, cEUR/EURm, and the 8 local-FX
//     stables).
//   - liquity-v2-cr: a mento-protocol/bold (Liquity v2 fork) CDP branch
//     (GBPm).
//   - fpmm-pools: one or more Mento V3 FPMM pools with configured token identities.
// Any read failure fails closed: no redemption telemetry is emitted for that
// coin (a degraded warning is added instead) and the reserve composition
// computed upstream is returned unaffected.

type EvmOnchainInput = Extract<LiveReserveInput, { kind: "onchain-evm" }>;

const CELO_CHAIN = "celo";
const CELO_ONCHAIN_INPUT: EvmOnchainInput = { kind: "onchain-evm", chain: CELO_CHAIN, rpcMode: "public-rpc" };

const MENTO_BROKER_POOL_MAX_EXCHANGE_IDS = 64;
const MENTO_BROKER = "0x777a8255ca72412f0d706dc03c9d1987306b4cad";
const BROKER_LIMIT_CONFIG = parseAbiParameters("uint32,uint32,int48,int48,int48,uint8");
const BROKER_LIMIT_STATE = parseAbiParameters("uint32,uint32,int48,int48,int48");
type BrokerLimitConfig = readonly [number, number, number, number, number, number];
type BrokerLimitState = readonly [number, number, number, number, number];

function brokerCall(signature: string, args: readonly unknown[] = []): `0x${string}` {
  return encodeFunctionData({
    abi: parseAbi([signature]) as ParseAbi<readonly string[]>,
    functionName: signature.match(/function (\w+)/)![1],
    args,
  });
}

function brokerLimitHeadroom(
  config: BrokerLimitConfig,
  state: BrokerLimitState,
  now: number,
  direction: 1n | -1n,
  decimals: number,
): bigint | null {
  const flags = config[5];
  if (flags > 7 || ((flags & 2) !== 0 && (flags & 1) === 0)) {
    throw new Error("mento broker-pool: invalid trading-limit flags");
  }
  let headroom: bigint | null = null;
  for (const [flag, limit, flow, updated, timestep] of [
    [1, config[2], state[2], state[0], config[0]],
    [2, config[3], state[3], state[1], config[1]],
    [4, config[4], state[4], 0, 0],
  ] as const) {
    if ((flags & flag) === 0) continue;
    if (limit <= 0 || (flag !== 4 && timestep <= 0)) throw new Error("mento broker-pool: invalid trading limit");
    const effectiveFlow = flag !== 4 && now > updated + timestep ? 0n : BigInt(flow);
    const remaining = BigInt(limit) - direction * effectiveFlow;
    const arithmeticRemaining = ((1n << 47n) - 1n) - direction * effectiveFlow;
    const flowBounded = remaining < arithmeticRemaining ? remaining : arithmeticRemaining;
    const bounded = flowBounded < (1n << 47n) - 1n ? flowBounded : (1n << 47n) - 1n;
    const raw = (bounded > 0n ? bounded : 0n) * 10n ** BigInt(decimals);
    headroom = headroom == null || raw < headroom ? raw : headroom;
  }
  return headroom;
}

function decodeBrokerLimitConfig(raw: `0x${string}`) {
  if (!/^0x[0-9a-fA-F]{384}$/.test(raw)) throw new Error("malformed Broker limit config");
  return decodeAbiParameters(BROKER_LIMIT_CONFIG, raw);
}

function decodeBrokerLimitState(raw: `0x${string}`) {
  if (!/^0x[0-9a-fA-F]{320}$/.test(raw)) throw new Error("malformed Broker limit state");
  return decodeAbiParameters(BROKER_LIMIT_STATE, raw);
}

async function observeBrokerCapacity(
  exchangeId: `0x${string}`,
  pool: MentoPoolExchange,
  self: string,
  output: string,
  options: MentoPoolCallOptions,
): Promise<{ capacityUsd: number; closedReason?: string }> {
  if (BigInt(pool.pricingModule) === 0n || BigInt(pool.config.referenceRateFeedID) === 0n
    || pool.config.referenceRateResetFrequency <= 0n || pool.config.minimumReports <= 0n) {
    throw new Error("mento broker-pool: invalid pricing/oracle configuration");
  }
  const read = (calls: Parameters<typeof fetchOnchainMulticall3>[0]["calls"]) =>
    fetchOnchainMulticall3({ ...options, calls });
  const pointers = await executeEvmObservationPlan({
    adapterKey: "mento broker-pool",
    fields: [
      addressObservation({ label: "managerBroker", contract: MENTO_BIPOOL_MANAGER_ADDRESS, data: brokerCall("function broker() view returns(address)") }),
      addressObservation({ label: "reserve", contract: MENTO_BROKER, data: brokerCall("function exchangeReserve(address) view returns(address)", [MENTO_BIPOOL_MANAGER_ADDRESS]) }),
      addressObservation({ label: "oracle", contract: MENTO_BIPOOL_MANAGER_ADDRESS, data: brokerCall("function sortedOracles() view returns(address)") }),
      addressObservation({ label: "breaker", contract: MENTO_BIPOOL_MANAGER_ADDRESS, data: brokerCall("function breakerBox() view returns(address)") }),
      boolObservation({ label: "provider", contract: MENTO_BROKER, data: brokerCall("function isExchangeProvider(address) view returns(bool)", [MENTO_BIPOOL_MANAGER_ADDRESS]) }),
      uint256Observation({ label: "inputDecimals", contract: self, data: "0x313ce567" }),
      uint256Observation({ label: "outputDecimals", contract: output, data: "0x313ce567" }),
      addressObservation({ label: "inputBroker", contract: self, data: brokerCall("function broker() view returns(address)") }),
    ],
    read,
  });
  const { reserve, oracle, breaker, provider, managerBroker, inputBroker } = pointers.values;
  const inputDecimals = Number(pointers.values.inputDecimals);
  const outputDecimals = Number(pointers.values.outputDecimals);
  if (managerBroker !== MENTO_BROKER || inputBroker !== MENTO_BROKER
    || BigInt(reserve) === 0n || BigInt(oracle) === 0n || BigInt(breaker) === 0n
    || inputDecimals > 36 || outputDecimals > 36) {
    throw new Error("mento broker-pool: execution identity mismatch");
  }
  const limitId = (token: string) => `0x${(BigInt(exchangeId) ^ BigInt(token)).toString(16).padStart(64, "0")}`;
  const feed = pool.config.referenceRateFeedID;
  const guards = await executeEvmObservationPlan({
    adapterKey: "mento broker-pool",
    fields: [
      uint256Observation({ label: "mode", contract: breaker, data: brokerCall("function getRateFeedTradingMode(address) view returns(uint8)", [feed]) }),
      uint256Observation({ label: "oracleTime", contract: oracle, data: brokerCall("function medianTimestamp(address) view returns(uint256)", [feed]) }),
      uint256Observation({ label: "oracleCount", contract: oracle, data: brokerCall("function numRates(address) view returns(uint256)", [feed]) }),
      customObservation({ label: "expired", contract: oracle, data: brokerCall("function isOldestReportExpired(address) view returns(bool,address)", [feed]),
        decode: (raw) => decodeAbiParameters(parseAbiParameters("bool,address"), raw)[0] }),
      boolObservation({ label: "inputStable", contract: reserve, data: brokerCall("function isStableAsset(address) view returns(bool)", [self]) }),
      boolObservation({ label: "outputStable", contract: reserve, data: brokerCall("function isStableAsset(address) view returns(bool)", [output]) }),
      boolObservation({ label: "outputCollateral", contract: reserve, data: brokerCall("function isCollateralAsset(address) view returns(bool)", [output]) }),
      customObservation({ label: "inputConfig", contract: MENTO_BROKER, data: brokerCall("function tradingLimitsConfig(bytes32) view returns(uint32,uint32,int48,int48,int48,uint8)", [limitId(self)]), decode: decodeBrokerLimitConfig }),
      customObservation({ label: "outputConfig", contract: MENTO_BROKER, data: brokerCall("function tradingLimitsConfig(bytes32) view returns(uint32,uint32,int48,int48,int48,uint8)", [limitId(output)]), decode: decodeBrokerLimitConfig }),
      customObservation({ label: "inputState", contract: MENTO_BROKER, data: brokerCall("function tradingLimitsState(bytes32) view returns(uint32,uint32,int48,int48,int48)", [limitId(self)]), decode: decodeBrokerLimitState }),
      customObservation({ label: "outputState", contract: MENTO_BROKER, data: brokerCall("function tradingLimitsState(bytes32) view returns(uint32,uint32,int48,int48,int48)", [limitId(output)]), decode: decodeBrokerLimitState }),
    ],
    read,
  });
  const g = guards.values;
  if (!g.inputStable || (!g.outputStable && !g.outputCollateral)) throw new Error("mento broker-pool: unsupported transfer class");
  const permissions = await executeEvmObservationPlan({
    adapterKey: "mento broker-pool",
    fields: [
      boolObservation({ label: "allowed", contract: g.outputStable ? output : reserve,
        data: brokerCall(g.outputStable ? "function isMinter(address) view returns(bool)" : "function isExchangeSpender(address) view returns(bool)", [MENTO_BROKER]) }),
      ...(g.outputCollateral ? [uint256Observation({ label: "inventory", contract: output, data: brokerCall("function balanceOf(address) view returns(uint256)", [reserve]) })] : []),
    ],
    read,
  });
  if (!provider || !permissions.values.allowed || g.mode !== 0n) {
    return { capacityUsd: 0, closedReason: "Broker provider, transfer permission or breaker closes execution" };
  }
  if (g.expired || g.oracleCount < pool.config.minimumReports
    || g.oracleTime > BigInt(options.observedBlock.timestamp)
    || g.oracleTime <= BigInt(options.observedBlock.timestamp) - pool.config.referenceRateResetFrequency) {
    return { capacityUsd: 0, closedReason: "Broker reference rate is not executable" };
  }
  let inputBound = brokerLimitHeadroom(g.inputConfig, g.inputState, options.observedBlock.timestamp, 1n, inputDecimals);
  let outputBound = brokerLimitHeadroom(g.outputConfig, g.outputState, options.observedBlock.timestamp, -1n, outputDecimals);
  if (g.outputCollateral) {
    const inventory = permissions.values.inventory;
    if (inventory == null) throw new Error("mento broker-pool: missing spendable output");
    outputBound = outputBound == null || inventory < outputBound ? inventory : outputBound;
  }
  // A virtual bucket is not a spendable cap, especially for mintable USDm.
  if (inputBound == null && outputBound == null) throw new Error("mento broker-pool: no finite executable bound");
  if (inputBound === 0n || outputBound === 0n) {
    return { capacityUsd: 0, closedReason: "Broker trading headroom or spendable output is exhausted" };
  }
  const quote = async (method: "getAmountIn" | "getAmountOut", amount: bigint) => {
    const result = await fetchOnchainUint256({
      ...options, contract: MENTO_BROKER,
      data: brokerCall(`function ${method}(address,bytes32,address,address,uint256) view returns(uint256)`,
        [MENTO_BIPOOL_MANAGER_ADDRESS, exchangeId, self, output, amount]),
    });
    if (result == null) throw new Error("mento broker-pool: execution quote unavailable");
    return result;
  };
  if (outputBound != null) {
    const quotedInput = await quote("getAmountIn", outputBound);
    inputBound = inputBound == null || quotedInput < inputBound ? quotedInput : inputBound;
  }
  if (inputBound == null || inputBound <= 0n) throw new Error("mento broker-pool: nonpositive bounded quote input");
  const amountOut = await quote("getAmountOut", inputBound);
  if (outputBound != null && amountOut > outputBound) throw new Error("mento broker-pool: quote exceeds execution headroom");
  return { capacityUsd: decimalNumberFromBigInt(amountOut, outputDecimals) };
}

// mento-protocol/bold (GBPm) is a Liquity v2 fork sharing the ActivePool debt
// and redemption-rate selectors already verified in liquity-v2-branches.ts.
const LIQUITY_V2_DEBT_SELECTOR = "0x45507998"; // getBoldDebt()
// The Mento fork's TroveManager has no hasBeenShutDown(); it exposes
// shutdownTime() (0 = live, nonzero = branch shut down) - verified on-chain
// against 0xb38aEf2b... on 2026-07-09 (hasBeenShutDown reverts there).
const LIQUITY_V2_SHUTDOWN_SELECTOR = "0x58569081"; // shutdownTime()
const LIQUITY_V2_REDEMPTION_RATE_SELECTOR = "0xc52861f2"; // getRedemptionRateWithDecay()

// The Mento V3 FPMM pool charges `lpFee + protocolFee`, both stored directly in
// basis points on the pool's own BASIS_POINTS_DENOMINATOR = 10_000 scale and
// applied symmetrically in getAmountOut() for either swap direction. Verified
// against the FPMM implementation behind the JPYm/CHFm proxies on 2026-08-12.
const FPMM_LP_FEE_SELECTOR = "0x704ce43e"; // lpFee()
const FPMM_PROTOCOL_FEE_SELECTOR = "0xb0e21e8a"; // protocolFee()
const FPMM_RESERVES_ABI = [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }] as const;
const FPMM_TRADING_LIMITS_ABI = [
  { type: "int120" }, { type: "int120" }, { type: "uint8" },
  { type: "uint32" }, { type: "uint32" }, { type: "int96" }, { type: "int96" },
] as const;

function decodeFpmmReserves(raw: `0x${string}`) {
  if (!/^0x[0-9a-fA-F]{192}$/.test(raw)) throw new Error("malformed reserves");
  return decodeAbiParameters(FPMM_RESERVES_ABI, raw);
}

function decodeFpmmTradingLimits(raw: `0x${string}`) {
  if (!/^0x[0-9a-fA-F]{448}$/.test(raw)) throw new Error("malformed trading limits");
  return decodeAbiParameters(FPMM_TRADING_LIMITS_ABI, raw);
}

interface MentoPoolCallOptions {
  signal: AbortSignal;
  ctx: AdapterContext | undefined;
  rpcUrl: string | undefined;
  fallbackRpcUrl: string | undefined;
  rpcMode: EvmOnchainInput["rpcMode"];
  chain: string;
  observedBlock: NonNullable<AdapterContext["observedBlock"]>;
}

type MentoParams = LiveReserveAdapterParamsByKey["mento"];
type MentoRedemptionParams = NonNullable<MentoParams["redemption"]>;
type MentoBrokerPoolParams = Extract<MentoRedemptionParams, { kind: "broker-pool" }>;
type MentoLiquityV2CrParams = Extract<MentoRedemptionParams, { kind: "liquity-v2-cr" }>;

function mentoPoolCacheKey(
  params: MentoBrokerPoolParams,
  callOptions: MentoPoolCallOptions,
  resource: string,
): string {
  return [
    "mento-bipool:v2",
    params.rpcUrl ?? "",
    params.fallbackRpcUrl ?? "",
    callOptions.observedBlock.chain,
    callOptions.observedBlock.number,
    callOptions.observedBlock.timestamp,
    resource,
  ].join(":");
}

function loadCachedMentoPoolRead<T>(
  cacheKey: string,
  callOptions: MentoPoolCallOptions,
  load: () => Promise<T>,
  cacheBytes: number,
): Promise<T> {
  return getCachedRequest(cacheKey, async () => ({
    value: await load(),
    cacheBytes: cacheBytes + 128 + 2 * cacheKey.length,
    basis: "declared-estimate",
  }), callOptions.ctx);
}

function loadMentoExchangeIds(
  params: MentoBrokerPoolParams,
  callOptions: MentoPoolCallOptions,
): Promise<`0x${string}`[]> {
  return loadCachedMentoPoolRead(
    mentoPoolCacheKey(params, callOptions, "exchange-ids"),
    callOptions,
    async () => {
      const exchangeIdsRaw = await fetchOnchainRawCall({
        ...callOptions,
        contract: MENTO_BIPOOL_MANAGER_ADDRESS,
        data: MENTO_GET_EXCHANGE_IDS_SELECTOR,
      });
      const exchangeIds = decodeBytes32ArrayWord(exchangeIdsRaw, {
        maxItems: MENTO_BROKER_POOL_MAX_EXCHANGE_IDS,
      });
      if (!exchangeIds || exchangeIds.length === 0) {
        throw new Error("mento broker-pool: could not enumerate BiPoolManager exchange ids");
      }
      return exchangeIds;
    },
    // Bounded 64-ID array: UTF-16 strings, element slots, and array bookkeeping.
    512 + MENTO_BROKER_POOL_MAX_EXCHANGE_IDS * (128 + 2 * 66),
  );
}

function loadMentoPoolExchange(
  params: MentoBrokerPoolParams,
  exchangeId: `0x${string}`,
  callOptions: MentoPoolCallOptions,
): Promise<MentoPoolExchange | null> {
  return loadCachedMentoPoolRead(
    mentoPoolCacheKey(params, callOptions, `exchange:${exchangeId}`),
    callOptions,
    async () => decodePoolExchange(await fetchOnchainRawCall({
      ...callOptions,
      contract: MENTO_BIPOOL_MANAGER_ADDRESS,
      data: `${MENTO_GET_POOL_EXCHANGE_SELECTOR}${exchangeId.slice(2)}`,
    })),
    // Fixed nested ABI record: three addresses, one bytes32 and seven uint256s.
    2_048,
  );
}

function decodePoolExchange(raw: string | null): MentoPoolExchange | null {
  if (typeof raw !== "string" || !raw.startsWith("0x")) return null;
  try {
    return decodeMentoPoolExchange(raw as `0x${string}`);
  } catch {
    return null;
  }
}

async function fetchMentoBrokerPoolRedemption(
  params: MentoBrokerPoolParams,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
): Promise<NonNullable<AdapterResult["metadata"]>> {
  const plan = await pinnedBlockPlan({ chain: CELO_CHAIN, signal, ctx, rpcUrl: params.rpcUrl, fallbackRpcUrl: params.fallbackRpcUrl });
  const callOptions = {
    signal,
    ctx: plan.ctx,
    observedBlock: plan.observedBlock,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    rpcMode: CELO_ONCHAIN_INPUT.rpcMode,
    chain: CELO_ONCHAIN_INPUT.chain,
  };

  const exchangeIds = await loadMentoExchangeIds(params, callOptions);
  const poolExchanges: Array<{ exchangeId: `0x${string}`; pool: MentoPoolExchange }> = [];
  const matchedPoolIndexes = new Set<number>();
  for (const exchangeId of exchangeIds) {
    throwIfAborted(signal);
    const poolExchange = await loadMentoPoolExchange(params, exchangeId, callOptions);
    if (!poolExchange) continue;

    let matchedExchange = false;
    for (const [index, poolConfig] of params.pools.entries()) {
      if (matchedPoolIndexes.has(index)) continue;
      const selfAddress = poolConfig.selfTokenAddress.toLowerCase();
      const counterAddress = poolConfig.counterAsset.address.toLowerCase();
      const asset0 = poolExchange.asset0.toLowerCase();
      const asset1 = poolExchange.asset1.toLowerCase();
      if (
        (asset0 === selfAddress && asset1 === counterAddress) ||
        (asset0 === counterAddress && asset1 === selfAddress)
      ) {
        matchedPoolIndexes.add(index);
        matchedExchange = true;
      }
    }
    if (matchedExchange) poolExchanges.push({ exchangeId, pool: poolExchange });
    if (matchedPoolIndexes.size === params.pools.length) break;
  }

  let capacityUsd = 0;
  let maxFeeBps: number | null = null;
  let closedReason: string | undefined;
  for (const poolConfig of params.pools) {
    const selfAddress = poolConfig.selfTokenAddress.toLowerCase();
    const counterAddress = poolConfig.counterAsset.address.toLowerCase();
    const match = poolExchanges.find(({ pool }) => {
      const asset0 = pool.asset0.toLowerCase();
      const asset1 = pool.asset1.toLowerCase();
      return (
        (asset0 === selfAddress && asset1 === counterAddress) ||
        (asset0 === counterAddress && asset1 === selfAddress)
      );
    });
    if (!match) {
      throw new Error(
        `mento broker-pool: no matching BiPoolManager exchange for ${poolConfig.selfTokenAddress}/${poolConfig.counterAsset.address}`,
      );
    }
    if (match.pool.config.spread >= MENTO_POOL_SPREAD_FIXIDITY_SCALE) {
      throw new Error("mento broker-pool: invalid spread");
    }
    const observation = await observeBrokerCapacity(match.exchangeId, match.pool, selfAddress, counterAddress, callOptions);
    capacityUsd += observation.capacityUsd;
    closedReason ??= observation.closedReason;
    const feeBps = mentoSpreadToFeeBps(match.pool.config.spread);
    maxFeeBps = maxFeeBps == null ? feeBps : Math.max(maxFeeBps, feeBps);
  }

  if (!Number.isFinite(capacityUsd) || capacityUsd < 0) {
    throw new Error("mento broker-pool: invalid counter-asset capacity");
  }

  return buildRedemptionSnapshotMetadata({
    capacityUsd,
    capacityKind: "live-direct-bounded",
    freshnessKind: "same-run-onchain",
    blockNumber: plan.observedBlock.number,
    sourceTimestamp: plan.observedBlock.timestamp,
    routeStatus: closedReason ? "degraded" : "open",
    ...(closedReason ? { routeStatusReason: closedReason } : {}),
    routeStatusSource: "onchain",
    routeObserved: true,
    holderEligibility: "any-holder",
    settlementDelaySec: 0,
    feeBps: maxFeeBps,
    ...(params.sourceUrls ? { sourceUrls: params.sourceUrls } : {}),
  });
}

async function fetchMentoLiquityV2CrRedemption(
  params: MentoLiquityV2CrParams,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
): Promise<NonNullable<AdapterResult["metadata"]>> {
  const plan = await pinnedBlockPlan({ chain: CELO_CHAIN, signal, ctx, rpcUrl: params.rpcUrl, fallbackRpcUrl: params.fallbackRpcUrl });
  const callOptions = {
    signal,
    ctx: plan.ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    rpcMode: CELO_ONCHAIN_INPUT.rpcMode,
    chain: CELO_ONCHAIN_INPUT.chain,
  };

  const [debtRaw, shutDownRaw, feeBps, totalSupplyRaw] = await Promise.all([
    fetchOnchainUint256({ ...callOptions, contract: params.activePoolAddress, data: LIQUITY_V2_DEBT_SELECTOR }),
    fetchOnchainRawCall({ ...callOptions, contract: params.troveManagerAddress, data: LIQUITY_V2_SHUTDOWN_SELECTOR }),
    fetchOnchainRateBps(
      CELO_ONCHAIN_INPUT,
      { contract: params.collateralRegistryAddress, selector: LIQUITY_V2_REDEMPTION_RATE_SELECTOR, decimals: 18 },
      signal,
      plan.ctx,
      params.rpcUrl,
      params.fallbackRpcUrl,
    ),
    fetchErc20TotalSupply(CELO_ONCHAIN_INPUT, params.tokenAddress, signal, plan.ctx, params.rpcUrl, params.fallbackRpcUrl),
  ]);

  if (debtRaw == null || totalSupplyRaw == null || totalSupplyRaw <= 0n) {
    throw new Error("mento liquity-v2-cr: could not read ActivePool debt or token total supply");
  }

  // Unknown shutdown state is missing evidence, never an open branch or a zero.
  const shutdownTime = decodeUint256Word(shutDownRaw);
  if (shutdownTime == null) {
    throw new Error("mento liquity-v2-cr: could not read shutdown guard");
  }
  const routeStatus = shutdownTime > 0n ? "degraded" : "open";
  const capacityRatioOfSupply = shutdownTime > 0n ? 0 : Math.min(
    1,
    decimalNumberFromBigInt(debtRaw, 18) / decimalNumberFromBigInt(totalSupplyRaw, 18),
  );

  return buildRedemptionSnapshotMetadata({
    capacityRatioOfSupply,
    capacityKind: "live-direct-bounded",
    freshnessKind: "same-run-onchain",
    blockNumber: plan.observedBlock.number,
    sourceTimestamp: plan.observedBlock.timestamp,
    routeStatus,
    routeStatusSource: "onchain",
    routeObserved: true,
    holderEligibility: "any-holder",
    settlementDelaySec: 0,
    feeBps,
    ...(params.sourceUrls ? { sourceUrls: params.sourceUrls } : {}),
  });
}


// Pool token identities and native units are checked live against config.
// Conservatively keep the full inventory unrated if a trading limit binds;
// we do not infer executable capacity from an oracle quote alone.
async function fetchMentoFpmmPoolsRedemption(
  params: Extract<MentoRedemptionParams, { kind: "fpmm-pools" }>,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
): Promise<NonNullable<AdapterResult["metadata"]>> {
  const self = params.selfTokenAddress.toLowerCase();
  if (new Set(params.pools.map((pool) => pool.poolAddress.toLowerCase())).size !== params.pools.length) {
    throw new Error("mento fpmm-pools: duplicate pool");
  }
  const plan = await pinnedBlockPlan({ chain: CELO_CHAIN, signal, ctx });
  const word = (address: string) => address.toLowerCase().slice(2).padStart(64, "0");
  const quoteData = (amount: bigint) => `0xf140a35a${amount.toString(16).padStart(64, "0")}${word(self)}`;
  let capacityUsd = 0;
  let maxFeeBps = 0;
  // Sequential pools share one pinned block and the adapter's connection budget.
  for (const pool of params.pools) {
    const output = pool.counterAsset.address.toLowerCase();
    const outputDecimals = pool.counterAsset.decimals;
    if (output === self) throw new Error("mento fpmm-pools: token identity mismatch");
    const observation = await executeEvmObservationPlan({
      adapterKey: "mento fpmm-pools",
      fields: [
        addressObservation({ label: "token0", contract: pool.poolAddress, data: "0x0dfe1681" }),
        addressObservation({ label: "token1", contract: pool.poolAddress, data: "0xd21220a7" }),
        customObservation({ label: "reserves", contract: pool.poolAddress, data: "0x0902f1ac", decode: decodeFpmmReserves }),
        uint256Observation({ label: "balance", contract: output, data: `0x70a08231${word(pool.poolAddress)}` }),
        uint256Observation({ label: "inputBalance", contract: self, data: `0x70a08231${word(pool.poolAddress)}` }),
        uint256Observation({ label: "decimals", contract: output, data: "0x313ce567" }),
        uint256Observation({ label: "inputDecimals", contract: self, data: "0x313ce567" }),
        uint256Observation({ label: "lp", contract: pool.poolAddress, data: FPMM_LP_FEE_SELECTOR }),
        uint256Observation({ label: "protocol", contract: pool.poolAddress, data: FPMM_PROTOCOL_FEE_SELECTOR }),
        customObservation({ label: "inputLimits", contract: pool.poolAddress, data: `0x6391f7db${word(self)}`, decode: decodeFpmmTradingLimits }),
        customObservation({ label: "outputLimits", contract: pool.poolAddress, data: `0x6391f7db${word(output)}`, decode: decodeFpmmTradingLimits }),
        uint256Observation({ label: "unitQuote", contract: pool.poolAddress, data: quoteData(10n ** BigInt(params.selfDecimals + 6)) }),
      ],
      read: async (calls) => {
        const rows = await fetchOnchainMulticall3({ chain: CELO_CHAIN, signal, ctx: plan.ctx, calls });
        // getAmountOut's oracle check rejects routine weekend/holiday closure.
        // Preserve that measured rejection instead of reusing inventory.
        const quoteFailure = rows?.find((row) => row.label === "unitQuote" && !row.success);
        if (quoteFailure?.returnData.toLowerCase() === "0xa407143a") {
          throw new Error("mento fpmm-pools: fx-market-closed");
        }
        return rows;
      },
    });
    const { token0, token1, reserves, balance, inputBalance, decimals, inputDecimals, unitQuote, lp, protocol } = observation.values;
    if (!((token0 === self && token1 === output) || (token0 === output && token1 === self))
      || decimals !== BigInt(outputDecimals) || inputDecimals !== BigInt(params.selfDecimals)) {
      throw new Error("mento fpmm-pools: token identity mismatch");
    }
    const reserve = reserves[token0 === output ? 0 : 1];
    const inputReserve = reserves[token0 === self ? 0 : 1];
    // swap rejects either empty reserve, including its zero-output input side.
    if (inputReserve <= 0n) throw new Error("mento fpmm-pools: empty input reserve");
    if (balance !== reserve || inputBalance !== inputReserve) {
      throw new Error("mento fpmm-pools: unsynchronized balances and reserves");
    }
    const inventoryBound = reserve > 0n ? reserve - 1n : 0n;
    const fee = lp + protocol;
    if (unitQuote <= 0n || fee > 200n) throw new Error("mento fpmm-pools: invalid quote or fee");
    // Empty verified output inventory is measured zero, not a failed quote.
    // A positive inventory still requires a positive probe input and readable
    // executable quote; rounding the input to zero is not an observation.
    const amountIn = (inventoryBound * 10n ** BigInt(params.selfDecimals + 6)) / unitQuote;
    if (inventoryBound > 0n && amountIn <= 0n) throw new Error("mento fpmm-pools: bounded quote failed");
    const amountOut = inventoryBound === 0n ? 0n : await fetchOnchainUint256({
      chain: CELO_CHAIN, signal, ctx: plan.ctx, contract: pool.poolAddress, data: quoteData(amountIn),
    });
    if (amountOut == null || amountOut < 0n || amountOut > inventoryBound) {
      throw new Error("mento fpmm-pools: bounded quote failed");
    }
    for (const [label, amount, decimals] of [
      ["inputLimits", amountIn, params.selfDecimals],
      ["outputLimits", amountOut, outputDecimals],
    ] as const) {
      const limits = observation.values[label];
      if (limits[2] !== decimals) throw new Error("mento fpmm-pools: trading-limit decimals mismatch");
      const scaled = (amount * 10n ** 15n + 10n ** BigInt(decimals) - 1n) / 10n ** BigInt(decimals);
      for (const index of [0, 1] as const) {
        const limit = limits[index];
        const flow = limits[index + 5] as bigint;
        // Ignore potential resets and fee deductions: both only add headroom.
        if (limit < 0n || (limit > 0n && scaled > limit - (flow < 0n ? -flow : flow))) {
          throw new Error("mento fpmm-pools: inventory exceeds conservative trading-limit headroom");
        }
      }
    }
    capacityUsd += decimalNumberFromBigInt(amountOut, outputDecimals);
    maxFeeBps = Math.max(maxFeeBps, Number(fee));
  }
  return buildRedemptionSnapshotMetadata({
    capacityUsd, capacityKind: "live-direct-bounded", freshnessKind: "same-run-onchain",
    blockNumber: plan.observedBlock.number, sourceTimestamp: plan.observedBlock.timestamp,
    routeStatus: "open", routeStatusSource: "onchain", holderEligibility: "any-holder",
    routeObserved: true,
    settlementDelaySec: 0, feeBps: maxFeeBps,
    ...(params.sourceUrls ? { sourceUrls: params.sourceUrls } : {}),
  });
}

export function fetchMentoRedemptionMetadata(
  redemption: MentoRedemptionParams,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
): Promise<NonNullable<AdapterResult["metadata"]>> {
  switch (redemption.kind) {
    case "broker-pool":
      return fetchMentoBrokerPoolRedemption(redemption, signal, ctx);
    case "liquity-v2-cr":
      return fetchMentoLiquityV2CrRedemption(redemption, signal, ctx);
    case "fpmm-pools":
      return fetchMentoFpmmPoolsRedemption(redemption, signal, ctx);
  }
}

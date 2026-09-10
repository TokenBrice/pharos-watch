import type { LiveReserveInput } from "@shared/types/live-reserves";
import type { LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import {
  decodeMentoPoolExchange,
  MENTO_BIPOOL_MANAGER_ADDRESS,
  MENTO_GET_EXCHANGE_IDS_SELECTOR,
  MENTO_GET_POOL_EXCHANGE_SELECTOR,
  MENTO_POOL_SPREAD_FIXIDITY_SCALE,
  type MentoPoolExchange,
} from "@shared/lib/mento-contracts";
import type { AdapterContext, AdapterResult } from "./types";
import { decodeBytes32ArrayWord } from "./abi-decode";
import {
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  fetchErc20Balance,
  fetchErc20TotalSupply,
  fetchOnchainRateBps,
  fetchOnchainRawCall,
  fetchOnchainUint256,
} from "./helpers";
import { throwIfAborted } from "../../lib/abort";

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
//   - fpmm-pool: a Mento V3 FPMM pool that redeems into USDm (JPYm, CHFm).
// Any read failure fails closed: no redemption telemetry is emitted for that
// coin (a degraded warning is added instead) and the reserve composition
// computed upstream is returned unaffected.

type EvmOnchainInput = Extract<LiveReserveInput, { kind: "onchain-evm" }>;

const CELO_CHAIN = "celo";
const CELO_ONCHAIN_INPUT: EvmOnchainInput = { kind: "onchain-evm", chain: CELO_CHAIN, rpcMode: "public-rpc" };

const MENTO_BROKER_POOL_MAX_EXCHANGE_IDS = 64;

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

interface MentoPoolCallOptions {
  signal: AbortSignal;
  ctx: AdapterContext | undefined;
  rpcUrl: string | undefined;
  fallbackRpcUrl: string | undefined;
  rpcMode: EvmOnchainInput["rpcMode"];
  chain: string;
}

type MentoParams = LiveReserveAdapterParamsByKey["mento"];
type MentoRedemptionParams = NonNullable<MentoParams["redemption"]>;
type MentoBrokerPoolParams = Extract<MentoRedemptionParams, { kind: "broker-pool" }>;
type MentoLiquityV2CrParams = Extract<MentoRedemptionParams, { kind: "liquity-v2-cr" }>;
type MentoFpmmPoolParams = Extract<MentoRedemptionParams, { kind: "fpmm-pool" }>;

function mentoPoolCacheKey(params: MentoBrokerPoolParams, resource: string): string {
  return [
    "mento-bipool:v2",
    params.rpcUrl ?? "",
    params.fallbackRpcUrl ?? "",
    resource,
  ].join(":");
}

function loadCachedMentoPoolRead<T>(
  cacheKey: string,
  callOptions: MentoPoolCallOptions,
  load: () => Promise<T>,
): Promise<T> {
  const cache = callOptions.ctx?.requestCache;
  const cached = cache?.get(cacheKey) as Promise<T> | undefined;
  if (cached) return cached;

  const request: Promise<T> = load().catch((error) => {
    // Each coin has its own redemption deadline. Do not let one coin's abort
    // leave a rejected promise that poisons every later Mento coin in the run.
    if (callOptions.signal.aborted && cache?.get(cacheKey) === request) {
      cache.delete(cacheKey);
    }
    throw error;
  });
  cache?.set(cacheKey, request);
  return request;
}

function loadMentoExchangeIds(
  params: MentoBrokerPoolParams,
  callOptions: MentoPoolCallOptions,
): Promise<`0x${string}`[]> {
  return loadCachedMentoPoolRead(
    mentoPoolCacheKey(params, "exchange-ids"),
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
  );
}

function loadMentoPoolExchange(
  params: MentoBrokerPoolParams,
  exchangeId: `0x${string}`,
  callOptions: MentoPoolCallOptions,
): Promise<MentoPoolExchange | null> {
  return loadCachedMentoPoolRead(
    mentoPoolCacheKey(params, `exchange:${exchangeId}`),
    callOptions,
    async () => decodePoolExchange(await fetchOnchainRawCall({
      ...callOptions,
      contract: MENTO_BIPOOL_MANAGER_ADDRESS,
      data: `${MENTO_GET_POOL_EXCHANGE_SELECTOR}${exchangeId.slice(2)}`,
    })),
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
  const callOptions = {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    rpcMode: CELO_ONCHAIN_INPUT.rpcMode,
    chain: CELO_ONCHAIN_INPUT.chain,
  };

  const exchangeIds = await loadMentoExchangeIds(params, callOptions);
  const poolExchanges: MentoPoolExchange[] = [];
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
    if (matchedExchange) poolExchanges.push(poolExchange);
    if (matchedPoolIndexes.size === params.pools.length) break;
  }

  let capacityUsd = 0;
  let maxFeeBps: number | null = null;
  for (const poolConfig of params.pools) {
    const selfAddress = poolConfig.selfTokenAddress.toLowerCase();
    const counterAddress = poolConfig.counterAsset.address.toLowerCase();
    const match = poolExchanges.find((pool) => {
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
    // BiPoolManager tracks virtual bucket depths at 18-decimal precision
    // regardless of the counter asset's native token decimals (e.g.
    // USDC/USDT); the counter bucket is the sellable redemption capacity,
    // valued 1:1 USD since every configured counter asset is USD- or
    // USDm-pegged.
    const counterBucketRaw = match.asset0.toLowerCase() === counterAddress ? match.bucket0 : match.bucket1;
    capacityUsd += decimalNumberFromBigInt(counterBucketRaw, 18);
    const feeBps = Number((match.config.spread * 10_000n) / MENTO_POOL_SPREAD_FIXIDITY_SCALE);
    maxFeeBps = maxFeeBps == null ? feeBps : Math.max(maxFeeBps, feeBps);
  }

  if (capacityUsd <= 0) {
    throw new Error("mento broker-pool: matched pools returned zero counter-asset capacity");
  }

  return buildRedemptionSnapshotMetadata({
    capacityUsd,
    capacityKind: "live-direct-bounded",
    freshnessKind: "same-run-onchain",
    routeStatus: "open",
    routeStatusSource: "onchain",
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
  const callOptions = {
    signal,
    ctx,
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
      ctx,
      params.rpcUrl,
      params.fallbackRpcUrl,
    ),
    fetchErc20TotalSupply(CELO_ONCHAIN_INPUT, params.tokenAddress, signal, ctx, params.rpcUrl, params.fallbackRpcUrl),
  ]);

  if (debtRaw == null || totalSupplyRaw == null || totalSupplyRaw <= 0n) {
    throw new Error("mento liquity-v2-cr: could not read ActivePool debt or token total supply");
  }

  // shutdownTime() returns a uint256 timestamp: 0 while the branch is live,
  // nonzero once shut down. A null read keeps the honest "unknown" status.
  const shutdownTime = shutDownRaw != null && /^0x[0-9a-fA-F]{64}$/.test(shutDownRaw) ? BigInt(shutDownRaw) : null;
  const routeStatus = shutdownTime == null ? "unknown" : shutdownTime > 0n ? "degraded" : "open";
  const capacityRatioOfSupply = Math.min(
    1,
    decimalNumberFromBigInt(debtRaw, 18) / decimalNumberFromBigInt(totalSupplyRaw, 18),
  );

  return buildRedemptionSnapshotMetadata({
    capacityRatioOfSupply,
    capacityKind: "live-direct-bounded",
    freshnessKind: "same-run-onchain",
    routeStatus,
    routeStatusSource: "onchain",
    holderEligibility: "any-holder",
    settlementDelaySec: 0,
    feeBps,
    ...(params.sourceUrls ? { sourceUrls: params.sourceUrls } : {}),
  });
}

async function fetchMentoFpmmPoolRedemption(
  params: MentoFpmmPoolParams,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
): Promise<NonNullable<AdapterResult["metadata"]>> {
  const callOptions = {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    rpcMode: CELO_ONCHAIN_INPUT.rpcMode,
    chain: CELO_ONCHAIN_INPUT.chain,
  };

  const [balanceRaw, lpFeeRaw, protocolFeeRaw] = await Promise.all([
    fetchErc20Balance(
      CELO_ONCHAIN_INPUT,
      params.usdmTokenAddress,
      params.poolAddress,
      signal,
      ctx,
      params.rpcUrl,
      params.fallbackRpcUrl,
    ),
    fetchOnchainUint256({ ...callOptions, contract: params.poolAddress, data: FPMM_LP_FEE_SELECTOR }),
    fetchOnchainUint256({ ...callOptions, contract: params.poolAddress, data: FPMM_PROTOCOL_FEE_SELECTOR }),
  ]);
  if (balanceRaw == null) {
    throw new Error("mento fpmm-pool: could not read USDm pool balance");
  }
  const capacityUsd = decimalNumberFromBigInt(balanceRaw, 18);
  if (capacityUsd <= 0) {
    throw new Error("mento fpmm-pool: USDm pool balance returned zero capacity");
  }

  // A missing fee leg keeps the capacity but emits no bound, so a partial read
  // can never understate the swap cost.
  const feeBps = lpFeeRaw != null && protocolFeeRaw != null ? Number(lpFeeRaw + protocolFeeRaw) : null;

  return buildRedemptionSnapshotMetadata({
    capacityUsd,
    capacityKind: "live-direct-bounded",
    freshnessKind: "same-run-onchain",
    routeStatus: "open",
    routeStatusSource: "onchain",
    holderEligibility: "any-holder",
    settlementDelaySec: 0,
    feeBps,
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
    case "fpmm-pool":
      return fetchMentoFpmmPoolRedemption(redemption, signal, ctx);
  }
}

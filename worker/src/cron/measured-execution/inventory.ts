import { canonicalExitRouteAssetKey, canonicalExitRouteChain } from "@shared/lib/exit-route-identity";
import {
  DEX_MEASURED_MAX_FAVORABLE_OUTPUT_RATIO,
  DEX_MEASURED_TARGET_SCHEMA_VERSION,
  buildDexMeasuredExecutionTargetId,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import type { PriceValidationReferences } from "../../lib/price-validation";
import type { DexApiPool } from "../../lib/dex-api-types";
import { getTokenReferenceUsdPrice } from "../../lib/dex-api-token-pricing";
// Alias the canonical key builder locally instead of importing token-resolution's
// wrapper: that import closed a module cycle (dex-liquidity/types -> inventory ->
// token-resolution -> types) flagged by check:shared-cycles.
const buildChainAddressKey = canonicalExitRouteAssetKey;

export type { UniV3ExecutionCandidate } from "./candidate-types";
import type { UniV3ExecutionCandidate } from "./candidate-types";

function canonicalEvmAddress(value: string): `0x${string}` | null {
  const normalized = value.trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(normalized) ? (normalized as `0x${string}`) : null;
}

export function parseUniV3FeePips(poolMeta: string | null | undefined): number | null {
  if (!poolMeta) return null;
  const percentMarker = poolMeta.indexOf("%");
  if (percentMarker < 0 || percentMarker !== poolMeta.lastIndexOf("%")) return null;
  const prefix = poolMeta.slice(0, percentMarker).trimEnd();
  let numberStart = prefix.length;
  while (numberStart > 0) {
    const char = prefix[numberStart - 1]!;
    if ((char >= "0" && char <= "9") || char === ".") numberStart--;
    else break;
  }
  const rawPercent = prefix.slice(numberStart);
  if (
    rawPercent.length === 0 ||
    rawPercent.startsWith(".") ||
    rawPercent.endsWith(".") ||
    rawPercent.split(".").length > 2
  )
    return null;
  const percent = Number(rawPercent);
  const feePips = Math.round(percent * 10_000);
  return Number.isInteger(feePips) && feePips > 0 && feePips <= 1_000_000 ? feePips : null;
}

export function buildUniV3ExecutionCandidateKey(
  chain: string,
  tokenAddresses: readonly string[] | null | undefined,
  feePips: number | null,
): string | null {
  if (feePips == null || !tokenAddresses || tokenAddresses.length !== 2) return null;
  const addresses = tokenAddresses.map(canonicalEvmAddress);
  if (addresses.some((address) => address == null)) return null;
  return `${canonicalExitRouteChain(chain)}|${(addresses as string[]).sort().join("|")}|${feePips}`;
}

export function buildMeasuredPoolDirectionKey(stablecoinId: string, poolId: string): string {
  return `${stablecoinId.trim().toLowerCase()}|${poolId.trim().toLowerCase()}`;
}

function hasCoherentPancakeSpotPrice(
  pool: DexApiPool,
  inputIndex: number,
  inputReferencePriceUsd: number,
  outputReferencePriceUsd: number,
): boolean {
  if (pool.price == null || !Number.isFinite(pool.price) || pool.price <= 0) return false;
  const outputPerInput = inputIndex === 0 ? pool.price : 1 / pool.price;
  const outputValueRatio = (outputPerInput * outputReferencePriceUsd) / inputReferencePriceUsd;
  return Number.isFinite(outputValueRatio) && outputValueRatio <= DEX_MEASURED_MAX_FAVORABLE_OUTPUT_RATIO;
}

export function buildPancakeMeasuredExecutionTargets(input: {
  pools: readonly DexApiPool[];
  chainAddressToId: Map<string, string>;
  symbolToChainScopedIds: Map<string, Map<string, string[]>>;
  validationReferences?: PriceValidationReferences;
  stablecoinPriceById?: Map<string, number>;
  capturedAt: number;
}): Map<string, DexMeasuredExecutionTarget> {
  const targets = new Map<string, DexMeasuredExecutionTarget>();
  for (const pool of input.pools) {
    if (pool.source !== "pancakeswap" || pool.tokens.length !== 2) continue;
    const poolAddress = canonicalEvmAddress(pool.poolAddress);
    const tokenAddresses = pool.tokens.map((token) => canonicalEvmAddress(token.address));
    const feePips = pool.feeRate == null ? null : Math.round(pool.feeRate * 1_000_000);
    if (
      !poolAddress ||
      tokenAddresses.some((address) => address == null) ||
      feePips == null ||
      !Number.isInteger(feePips) ||
      feePips <= 0 ||
      feePips > 1_000_000 ||
      !Number.isFinite(pool.tvlUsd) ||
      pool.tvlUsd <= 0
    )
      continue;
    const canonicalTokens = tokenAddresses as [`0x${string}`, `0x${string}`];
    const poolId = canonicalExitRouteAssetKey(pool.chain, poolAddress);
    for (let inputIndex = 0; inputIndex < 2; inputIndex += 1) {
      const tokenIn = pool.tokens[inputIndex]!;
      const stablecoinId = input.chainAddressToId.get(buildChainAddressKey(pool.chain, tokenIn.address));
      if (!stablecoinId) continue;
      const outputIndex = inputIndex === 0 ? 1 : 0;
      const tokenOut = pool.tokens[outputIndex]!;
      const inputPrice = getTokenReferenceUsdPrice(
        tokenIn,
        pool.chain,
        input.chainAddressToId,
        input.symbolToChainScopedIds,
        input.validationReferences,
        input.stablecoinPriceById,
      );
      const outputPrice = getTokenReferenceUsdPrice(
        tokenOut,
        pool.chain,
        input.chainAddressToId,
        input.symbolToChainScopedIds,
        input.validationReferences,
        input.stablecoinPriceById,
      );
      if (inputPrice == null || outputPrice == null || inputPrice <= 0 || outputPrice <= 0) continue;
      if (!hasCoherentPancakeSpotPrice(pool, inputIndex, inputPrice, outputPrice)) continue;
      const outputStablecoinId = input.chainAddressToId.get(buildChainAddressKey(pool.chain, tokenOut.address));
      if (outputStablecoinId === stablecoinId) continue;
      const adapterProfileId = "pancakeswap-v3-quoter-v2";
      const targetId = buildDexMeasuredExecutionTargetId({
        adapterProfileId,
        stablecoinId,
        chain: canonicalExitRouteChain(pool.chain),
        protocol: "pancakeswap",
        poolId,
        tokenInAddress: canonicalTokens[inputIndex]!,
        tokenOutAddress: canonicalTokens[outputIndex]!,
        poolTokenAddresses: canonicalTokens,
        feePips,
      });
      const target: DexMeasuredExecutionTarget = {
        schemaVersion: DEX_MEASURED_TARGET_SCHEMA_VERSION,
        targetId,
        stablecoinId,
        adapterProfileId,
        protocol: "pancakeswap",
        chain: canonicalExitRouteChain(pool.chain),
        poolId,
        poolTokenAddresses: canonicalTokens,
        tokenIn: {
          address: canonicalTokens[inputIndex]!,
          symbol: tokenIn.symbol.trim(),
          decimals: tokenIn.decimals,
          referencePriceUsd: inputPrice,
          trackedAssetId: stablecoinId,
        },
        tokenOut: {
          address: canonicalTokens[outputIndex]!,
          symbol: tokenOut.symbol.trim(),
          decimals: tokenOut.decimals,
          referencePriceUsd: outputPrice,
          ...(outputStablecoinId ? { trackedAssetId: outputStablecoinId } : {}),
        },
        feePips,
        retainedTvlUsd: pool.tvlUsd,
        retainedPoolPriceUsd: inputPrice,
        capturedAt: input.capturedAt,
      };
      targets.set(buildMeasuredPoolDirectionKey(stablecoinId, poolId), target);
    }
  }
  return targets;
}

export function buildFluidMeasuredExecutionTargets(input: {
  pools: readonly DexApiPool[];
  chainAddressToId: Map<string, string>;
  symbolToChainScopedIds: Map<string, Map<string, string[]>>;
  validationReferences?: PriceValidationReferences;
  stablecoinPriceById?: Map<string, number>;
  capturedAt: number;
}): Map<string, DexMeasuredExecutionTarget> {
  const targets = new Map<string, DexMeasuredExecutionTarget>();
  for (const pool of input.pools) {
    if (pool.source !== "fluid" || pool.tokens.length !== 2) continue;
    const poolAddress = canonicalEvmAddress(pool.poolAddress);
    const tokenAddresses = pool.tokens.map((token) => canonicalEvmAddress(token.address));
    if (
      !poolAddress ||
      tokenAddresses.some((address) => address == null) ||
      !Number.isFinite(pool.tvlUsd) ||
      pool.tvlUsd <= 0
    )
      continue;
    const canonicalTokens = tokenAddresses as [`0x${string}`, `0x${string}`];
    if (canonicalTokens[0] === canonicalTokens[1]) continue;
    const chain = canonicalExitRouteChain(pool.chain);
    const poolId = canonicalExitRouteAssetKey(chain, poolAddress);

    for (let inputIndex = 0; inputIndex < 2; inputIndex += 1) {
      const tokenIn = pool.tokens[inputIndex]!;
      const stablecoinId = input.chainAddressToId.get(buildChainAddressKey(chain, tokenIn.address));
      if (!stablecoinId) continue;
      const outputIndex = inputIndex === 0 ? 1 : 0;
      const tokenOut = pool.tokens[outputIndex]!;
      if (
        !tokenIn.symbol.trim() ||
        !tokenOut.symbol.trim() ||
        !Number.isInteger(tokenIn.decimals) ||
        tokenIn.decimals < 0 ||
        !Number.isInteger(tokenOut.decimals) ||
        tokenOut.decimals < 0
      )
        continue;
      const inputPrice = getTokenReferenceUsdPrice(
        tokenIn,
        chain,
        input.chainAddressToId,
        input.symbolToChainScopedIds,
        input.validationReferences,
        input.stablecoinPriceById,
      );
      const outputPrice = getTokenReferenceUsdPrice(
        tokenOut,
        chain,
        input.chainAddressToId,
        input.symbolToChainScopedIds,
        input.validationReferences,
        input.stablecoinPriceById,
      );
      if (inputPrice == null || outputPrice == null || inputPrice <= 0 || outputPrice <= 0) continue;
      const outputStablecoinId = input.chainAddressToId.get(buildChainAddressKey(chain, tokenOut.address));
      if (outputStablecoinId === stablecoinId) continue;
      const adapterProfileId = "fluid-resolver-measured";
      const targetId = buildDexMeasuredExecutionTargetId({
        adapterProfileId,
        stablecoinId,
        chain,
        protocol: "fluid",
        poolId,
        tokenInAddress: canonicalTokens[inputIndex]!,
        tokenOutAddress: canonicalTokens[outputIndex]!,
        poolTokenAddresses: canonicalTokens,
      });
      const target: DexMeasuredExecutionTarget = {
        schemaVersion: DEX_MEASURED_TARGET_SCHEMA_VERSION,
        targetId,
        stablecoinId,
        adapterProfileId,
        protocol: "fluid",
        chain,
        poolId,
        poolTokenAddresses: canonicalTokens,
        tokenIn: {
          address: canonicalTokens[inputIndex]!,
          symbol: tokenIn.symbol.trim(),
          decimals: tokenIn.decimals,
          referencePriceUsd: inputPrice,
          trackedAssetId: stablecoinId,
        },
        tokenOut: {
          address: canonicalTokens[outputIndex]!,
          symbol: tokenOut.symbol.trim(),
          decimals: tokenOut.decimals,
          referencePriceUsd: outputPrice,
          ...(outputStablecoinId ? { trackedAssetId: outputStablecoinId } : {}),
        },
        retainedTvlUsd: pool.tvlUsd,
        retainedPoolPriceUsd: inputPrice,
        capturedAt: input.capturedAt,
      };
      targets.set(buildMeasuredPoolDirectionKey(stablecoinId, poolId), target);
    }
  }
  return targets;
}

export function buildUniV3MeasuredExecutionTarget(input: {
  stablecoinId: string;
  candidate: UniV3ExecutionCandidate;
  stablecoinPriceById: Map<string, number> | undefined;
  chainAddressToId: Map<string, string>;
  symbolToChainScopedIds?: Map<string, Map<string, string[]>>;
  validationReferences?: PriceValidationReferences;
  retainedTvlUsd: number;
  capturedAt: number;
}): DexMeasuredExecutionTarget | null {
  const candidate = input.candidate;
  const tokenAddresses = candidate.tokens.map((token) => canonicalEvmAddress(token.address));
  const poolAddress = canonicalEvmAddress(candidate.poolAddress);
  if (!poolAddress || tokenAddresses.some((address) => address == null)) return null;
  const canonicalTokens = tokenAddresses as [`0x${string}`, `0x${string}`];
  const inputIndex = candidate.tokens.findIndex(
    (token) => input.chainAddressToId.get(buildChainAddressKey(candidate.chain, token.address)) === input.stablecoinId,
  );
  if (
    inputIndex < 0 ||
    candidate.tokens.filter(
      (token) =>
        input.chainAddressToId.get(buildChainAddressKey(candidate.chain, token.address)) === input.stablecoinId,
    ).length !== 1
  )
    return null;
  const outputIndex = inputIndex === 0 ? 1 : 0;
  const tokenIn = candidate.tokens[inputIndex]!;
  const tokenOut = candidate.tokens[outputIndex]!;
  const symbolToChainScopedIds = input.symbolToChainScopedIds ?? new Map();
  const inputPrice = getTokenReferenceUsdPrice(
    tokenIn,
    candidate.chain,
    input.chainAddressToId,
    symbolToChainScopedIds,
    input.validationReferences,
    input.stablecoinPriceById,
  );
  if (inputPrice == null || !Number.isFinite(inputPrice) || inputPrice <= 0) return null;
  const outputStablecoinId = input.chainAddressToId.get(buildChainAddressKey(candidate.chain, tokenOut.address));
  const outputPrice = getTokenReferenceUsdPrice(
    tokenOut,
    candidate.chain,
    input.chainAddressToId,
    symbolToChainScopedIds,
    input.validationReferences,
    input.stablecoinPriceById,
  );
  if (outputPrice == null || !Number.isFinite(outputPrice) || outputPrice <= 0) return null;
  const chain = canonicalExitRouteChain(candidate.chain);
  const poolId = canonicalExitRouteAssetKey(chain, poolAddress);
  const adapterProfileId = "uniswap-v3-quoter-v2";
  const targetId = buildDexMeasuredExecutionTargetId({
    adapterProfileId,
    stablecoinId: input.stablecoinId,
    chain,
    protocol: "uniswap-v3",
    poolId,
    tokenInAddress: canonicalTokens[inputIndex]!,
    tokenOutAddress: canonicalTokens[outputIndex]!,
    poolTokenAddresses: canonicalTokens,
    feePips: candidate.feePips,
  });
  return {
    schemaVersion: DEX_MEASURED_TARGET_SCHEMA_VERSION,
    targetId,
    stablecoinId: input.stablecoinId,
    adapterProfileId,
    protocol: "uniswap-v3",
    chain,
    poolId,
    poolTokenAddresses: canonicalTokens,
    tokenIn: {
      address: canonicalTokens[inputIndex]!,
      symbol: tokenIn.symbol.trim(),
      decimals: tokenIn.decimals,
      referencePriceUsd: inputPrice,
      trackedAssetId: input.stablecoinId,
    },
    tokenOut: {
      address: canonicalTokens[outputIndex]!,
      symbol: tokenOut.symbol.trim(),
      decimals: tokenOut.decimals,
      referencePriceUsd: outputPrice,
      ...(outputStablecoinId ? { trackedAssetId: outputStablecoinId } : {}),
    },
    feePips: candidate.feePips,
    retainedTvlUsd: input.retainedTvlUsd,
    retainedPoolPriceUsd: inputPrice,
    capturedAt: input.capturedAt,
  };
}

import type { DexExecutionTargetFactoryInput, DexExecutionTargetFactoryOutput } from "../execution-target-registry";
import { buildEvmV2ExecutionCandidate } from "../constant-product-v2";
import {
  buildDexMeasuredExecutionTargetId,
  DEX_MEASURED_TARGET_SCHEMA_VERSION,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import { canonicalExitRouteAssetKey } from "@shared/lib/exit-route-identity";

const EVM_V2_PROFILE_ID = "evm-v2-constant-product-v1";

/**
 * Primary pool processing intentionally has no contract-metadata map. The
 * direct-API target context adds it structurally; without it this leaf must
 * stay empty rather than guessing token decimals or output identity.
 */
type EvmV2ContextMetadata = {
  contractMetaByChainAddress?: Map<
    string,
    {
      stablecoinId: string;
      symbol: string;
      decimals: number | null;
      source: "contract" | "tradedContract";
    }
  >;
};

function parsePoolSymbols(symbol: string): string[] | undefined {
  const symbols = symbol
    .split("/")
    .map((value) => value.trim())
    .filter(Boolean);

  return symbols.length === 2 ? symbols : undefined;
}

function readStablecoinPrice(
  input: DexExecutionTargetFactoryInput,
  stablecoinId: string,
): number | null {
  const price = input.context.stablecoinPriceById?.get(stablecoinId);
  return typeof price === "number" && Number.isFinite(price) && price > 0
    ? price
    : null;
}

function readTokenMetadata(
  input: DexExecutionTargetFactoryInput,
  chain: string,
  address: string,
) {
  const assetKey = canonicalExitRouteAssetKey(chain, address);
  const stablecoinId = input.context.chainAddressToId.get(assetKey);
  const metadata = (input.context as typeof input.context & EvmV2ContextMetadata)
    .contractMetaByChainAddress?.get(assetKey);
  const decimals = metadata?.decimals;
  const metadataStablecoinId = metadata?.stablecoinId.trim();

  if (
    !metadata ||
    decimals == null ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 36 ||
    !metadataStablecoinId ||
    (stablecoinId != null && stablecoinId !== metadataStablecoinId)
  ) {
    return null;
  }

  return {
    decimals,
    stablecoinId: stablecoinId ?? metadataStablecoinId,
    symbol: metadata.symbol?.trim() || address,
  };
}

function buildTarget(
  input: DexExecutionTargetFactoryInput,
): DexMeasuredExecutionTarget | null {
  const { context, identity, enrichment, stablecoinId } = input;
  const tokenAddresses = identity.pool.underlyingTokens;
  const chain = identity.chainNorm;

  if (!tokenAddresses || tokenAddresses.length !== 2) {
    return null;
  }

  const candidate = buildEvmV2ExecutionCandidate({
    chain: identity.chainNorm,
    protocol: identity.pool.project,
    poolType: enrichment.resolvedPoolType,
    poolAddress: identity.pool.pool,
    tokenAddresses,
    tokenSymbols: parsePoolSymbols(identity.pool.symbol),
    confirmedStable: context.aerodromeIsStable?.get(
      canonicalExitRouteAssetKey(identity.chainNorm, identity.pool.pool),
    ),
  });

  if (!candidate) {
    return null;
  }

  const tokenMetadata = candidate.tokenAddresses.map((address) =>
    readTokenMetadata(input, chain, address),
  );

  if (tokenMetadata.some((metadata) => metadata === null)) {
    return null;
  }

  const trackedIndexes = candidate.tokenAddresses.flatMap((_, index) =>
    tokenMetadata[index]?.stablecoinId === stablecoinId ? [index] : [],
  );

  if (trackedIndexes.length !== 1) {
    return null;
  }

  const tokenInIndex = trackedIndexes[0];
  const tokenOutIndex = tokenInIndex === 0 ? 1 : 0;
  const tokenIn = tokenMetadata[tokenInIndex];
  const tokenOut = tokenMetadata[tokenOutIndex];

  if (!tokenIn || !tokenOut || !tokenOut.stablecoinId) {
    return null;
  }

  const tokenInPrice = readStablecoinPrice(input, stablecoinId);
  const tokenOutPrice = readStablecoinPrice(input, tokenOut.stablecoinId);
  const retainedTvlUsd = enrichment.rawContribTvl;

  if (
    tokenInPrice === null ||
    tokenOutPrice === null ||
    typeof retainedTvlUsd !== "number" ||
    !Number.isFinite(retainedTvlUsd) ||
    retainedTvlUsd <= 0 ||
    context.measuredTargetCapturedAt == null
  ) {
    return null;
  }

  const feePips =
    candidate.source === "uniswap-v2"
      ? 3_000
      : candidate.source === "pancakeswap-v2"
        ? 2_500
        : undefined;
  const poolId = canonicalExitRouteAssetKey(
    chain,
    candidate.poolAddress,
  );
  const protocol = identity.pool.project.trim().toLowerCase();

  return {
    schemaVersion: DEX_MEASURED_TARGET_SCHEMA_VERSION,
    targetId: buildDexMeasuredExecutionTargetId({
      adapterProfileId: EVM_V2_PROFILE_ID,
      stablecoinId,
      protocol,
      chain,
      poolId,
      tokenInAddress: candidate.tokenAddresses[tokenInIndex],
      tokenOutAddress: candidate.tokenAddresses[tokenOutIndex],
      poolTokenAddresses: candidate.tokenAddresses,
      feePips,
    }),
    stablecoinId,
    adapterProfileId: EVM_V2_PROFILE_ID,
    protocol,
    chain,
    poolId,
    tokenIn: {
      address: candidate.tokenAddresses[tokenInIndex],
      symbol: tokenIn.symbol,
      decimals: tokenIn.decimals,
      referencePriceUsd: tokenInPrice,
      trackedAssetId: stablecoinId,
    },
    tokenOut: {
      address: candidate.tokenAddresses[tokenOutIndex],
      symbol: tokenOut.symbol,
      decimals: tokenOut.decimals,
      referencePriceUsd: tokenOutPrice,
      trackedAssetId: tokenOut.stablecoinId,
    },
    feePips,
    retainedTvlUsd,
    retainedPoolPriceUsd: tokenInPrice,
    capturedAt: context.measuredTargetCapturedAt,
    poolTokenAddresses: candidate.tokenAddresses,
  };
}

export function buildEvmV2RegisteredExecutionTarget(
  input: DexExecutionTargetFactoryInput,
): DexExecutionTargetFactoryOutput | null {
  const target = buildTarget(input);

  return target
    ? { measuredExecutionTarget: target, executionCapabilityGate: undefined }
    : null;
}

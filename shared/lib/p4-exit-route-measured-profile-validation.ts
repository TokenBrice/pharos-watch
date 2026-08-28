import { validateExitRouteCapacityCurve } from "./exit-route-capacity-point";
import {
  canonicalExitRouteAssetKey,
  canonicalExitRouteChain,
  canonicalExitRouteScopedKey,
} from "./exit-route-identity";
import {
  type DexMeasuredExecutionPublicProfile,
  DexMeasuredExecutionPublicProfileSchema,
  getDexMeasuredExecutionFreshnessMaxSec,
} from "../types/measured-execution";
import {
  CURVE_STABLESWAP_DEPLOYMENT,
  CURVE_STABLESWAP_NG_DEPLOYMENTS,
  CURVE_STABLESWAP_NG_FACTORY_DEPLOYMENT,
  UNISWAP_V4_DEPLOYMENT,
} from "./measured-execution-deployment-policies";
import {
  CURVE_STABLESWAP_ADAPTER_PROFILE_ID,
  CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID,
  isQuoterV2MeasuredExecutionAdapter,
  isUniswapV4MeasuredExecutionAdapter,
  normalizedKey,
  observationHistoryForProfile,
  type P4DexRoutePoolInput,
  type P4MeasuredExecutionPublicProfile,
} from "./p4-exit-route-capability-policy";

const CURVE_3POOL_ADDRESS = CURVE_STABLESWAP_DEPLOYMENT.poolAddress;
const CURVE_MAIN_REGISTRY_ADDRESS = CURVE_STABLESWAP_DEPLOYMENT.registryAddress;
const CURVE_MAIN_REGISTRY_CODE_HASH = CURVE_STABLESWAP_DEPLOYMENT.registryCodeHash;
const CURVE_3POOL_LP_TOKEN = CURVE_STABLESWAP_DEPLOYMENT.lpTokenAddress;
const CURVE_3POOL_TOKEN_ADDRESSES = CURVE_STABLESWAP_DEPLOYMENT.poolTokens.map((token) => token.address);

interface CurveStableSwapNgReviewedPolicy {
  chain: "ethereum";
  stablecoinId: string;
  poolAddress: string;
  poolCodeHash: string;
  poolTokenAddresses: readonly string[];
  tokenInAddress: string;
  tokenOutAddress: string;
  factoryAddress: string;
  factoryCodeHash: string;
  factoryPoolIndex: number;
}

const CURVE_STABLESWAP_NG_REVIEWED_POLICIES: readonly CurveStableSwapNgReviewedPolicy[] =
  CURVE_STABLESWAP_NG_DEPLOYMENTS.map((deployment) => ({
    chain: deployment.chain,
    stablecoinId: deployment.stablecoinId,
    poolAddress: deployment.poolAddress,
    poolCodeHash: deployment.poolCodeHash,
    poolTokenAddresses: deployment.poolTokens.map((token) => token.address),
    tokenInAddress: deployment.poolTokens[deployment.inputIndex].address,
    tokenOutAddress: deployment.poolTokens[deployment.outputIndex].address,
    factoryAddress: CURVE_STABLESWAP_NG_FACTORY_DEPLOYMENT.address,
    factoryCodeHash: CURVE_STABLESWAP_NG_FACTORY_DEPLOYMENT.codeHash,
    factoryPoolIndex: deployment.factoryPoolIndex,
  }));

export function reviewedCurveStableSwapNgPolicyForProfile(
  profile: P4MeasuredExecutionPublicProfile,
): CurveStableSwapNgReviewedPolicy | null {
  if (profile.adapterProfileId !== CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID) return null;
  const chain = canonicalExitRouteChain(profile.chain);
  const endpoint = "executionEndpoint" in profile ? profile.executionEndpoint.address : "";
  return CURVE_STABLESWAP_NG_REVIEWED_POLICIES.find(
    (policy) =>
      policy.chain === chain &&
      endpoint === policy.poolAddress &&
      canonicalExitRouteScopedKey(profile.chain, profile.poolId) ===
        canonicalExitRouteScopedKey(policy.chain, policy.poolAddress),
  ) ?? null;
}

export function validateMeasuredExecutionProfile(
  profile: P4MeasuredExecutionPublicProfile,
  context: { pool: P4DexRoutePoolInput; stablecoinId: string; observedAt: number },
): string[] {
  const issues: string[] = [];
  const schemaValid = DexMeasuredExecutionPublicProfileSchema.safeParse(profile).success;
  if (!schemaValid) issues.push("invalid-profile-schema");
  if (
    !isQuoterV2MeasuredExecutionAdapter(profile.adapterProfileId) &&
    !isUniswapV4MeasuredExecutionAdapter(profile.adapterProfileId) &&
    profile.adapterProfileId !== "curve-cryptoswap-get-dy-v1" &&
    profile.adapterProfileId !== CURVE_STABLESWAP_ADAPTER_PROFILE_ID &&
    profile.adapterProfileId !== CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID
  ) {
    issues.push("adapter-not-score-eligible");
  }
  const projectKey = normalizedKey(context.pool.project);
  const profileProtocolKey = normalizedKey(profile.protocol);
  const protocolMatches =
    profile.adapterProfileId === "aerodrome-slipstream-quoter-v2"
      ? profileProtocolKey === "aerodrome-slipstream" &&
        (projectKey === "aerodrome" || projectKey === "aerodrome-slipstream")
      : profileProtocolKey === projectKey;
  if (
    canonicalExitRouteChain(profile.chain) !== canonicalExitRouteChain(context.pool.chain) ||
    !protocolMatches
  ) issues.push("pool-identity-mismatch");
  const measuredPhysicalPoolId = context.pool.extra?.measuredExecutionPhysicalPoolId;
  if (
    !measuredPhysicalPoolId ||
    canonicalExitRouteScopedKey(profile.chain, profile.poolId) !==
      canonicalExitRouteScopedKey(context.pool.chain, measuredPhysicalPoolId)
  )
    issues.push("retained-physical-pool-mismatch");
  if (profile.tokenIn.trackedAssetId !== context.stablecoinId) issues.push("tracked-input-mismatch");
  if (profile.tokenOut.trackedAssetId === context.stablecoinId) issues.push("self-output-asset");
  if (isUniswapV4MeasuredExecutionAdapter(profile.adapterProfileId)) {
    const evmProfile = profile as DexMeasuredExecutionPublicProfile;
    const provenance = evmProfile.uniswapV4PoolProvenance;
    if (
      canonicalExitRouteChain(evmProfile.chain) !== "ethereum" ||
      evmProfile.protocol !== "uniswap-v4" ||
      evmProfile.hookAddress !== UNISWAP_V4_DEPLOYMENT.hookFreeAddress ||
      evmProfile.tickSpacing == null ||
      evmProfile.feePips == null ||
      evmProfile.poolTokenAddresses?.length !== 2 ||
      !evmProfile.poolTokenAddresses.includes(evmProfile.tokenIn.address) ||
      !evmProfile.poolTokenAddresses.includes(evmProfile.tokenOut.address) ||
      evmProfile.tokenIn.address === evmProfile.tokenOut.address ||
      provenance == null ||
      evmProfile.poolId !== canonicalExitRouteAssetKey("ethereum", provenance.poolId) ||
      provenance.blockNumber !== evmProfile.blockNumber ||
      provenance.poolManagerAddress !== UNISWAP_V4_DEPLOYMENT.poolManagerAddress ||
      provenance.poolManagerCodeHash !== UNISWAP_V4_DEPLOYMENT.poolManagerCodeHash ||
      provenance.stateViewAddress !== UNISWAP_V4_DEPLOYMENT.stateViewAddress ||
      provenance.stateViewCodeHash !== UNISWAP_V4_DEPLOYMENT.stateViewCodeHash ||
      evmProfile.executionEndpoint.address !== UNISWAP_V4_DEPLOYMENT.quoterAddress ||
      evmProfile.executionEndpoint.codeHash !== UNISWAP_V4_DEPLOYMENT.quoterCodeHash
    ) issues.push("invalid-uniswap-v4-identity");
  } else if (profile.adapterProfileId === CURVE_STABLESWAP_ADAPTER_PROFILE_ID) {
    const evmProfile = profile as DexMeasuredExecutionPublicProfile;
    if (
      evmProfile.chain !== "ethereum" ||
      evmProfile.poolId !== canonicalExitRouteAssetKey("ethereum", CURVE_3POOL_ADDRESS) ||
      evmProfile.executionEndpoint.address !== CURVE_STABLESWAP_DEPLOYMENT.poolAddress ||
      evmProfile.executionEndpoint.codeHash !== CURVE_STABLESWAP_DEPLOYMENT.poolCodeHash ||
      evmProfile.poolTokenAddresses?.length !== CURVE_3POOL_TOKEN_ADDRESSES.length ||
      evmProfile.poolTokenAddresses.some((address, index) => address !== CURVE_3POOL_TOKEN_ADDRESSES[index])
    ) issues.push("invalid-curve-stableswap-identity");
    const provenance = evmProfile.registryProvenance;
    if (
      provenance == null ||
      provenance.registryAddress !== CURVE_MAIN_REGISTRY_ADDRESS ||
      provenance.registryCodeHash !== CURVE_MAIN_REGISTRY_CODE_HASH ||
      provenance.registeredPoolAddress !== CURVE_3POOL_ADDRESS ||
      provenance.lpTokenAddress !== CURVE_3POOL_LP_TOKEN ||
      provenance.poolTokenAddresses.length !== CURVE_3POOL_TOKEN_ADDRESSES.length ||
      provenance.poolTokenAddresses.some((address, index) => address !== CURVE_3POOL_TOKEN_ADDRESSES[index])
    ) issues.push("physical-pool-provenance-mismatch");
  } else if (profile.adapterProfileId === CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID) {
    const evmProfile = profile as DexMeasuredExecutionPublicProfile;
    const policy = reviewedCurveStableSwapNgPolicyForProfile(evmProfile);
    if (
      !policy ||
      evmProfile.chain !== policy.chain ||
      evmProfile.poolId !== canonicalExitRouteAssetKey(policy.chain, policy.poolAddress) ||
      evmProfile.executionEndpoint.address !== policy.poolAddress ||
      evmProfile.executionEndpoint.codeHash !== policy.poolCodeHash ||
      evmProfile.poolTokenAddresses?.length !== policy.poolTokenAddresses.length ||
      evmProfile.poolTokenAddresses.some(
        (address, index) => address !== policy.poolTokenAddresses[index],
      ) ||
      evmProfile.tokenIn.address !== policy.tokenInAddress ||
      evmProfile.tokenOut.address !== policy.tokenOutAddress ||
      evmProfile.tokenIn.trackedAssetId !== policy.stablecoinId
    ) issues.push("invalid-curve-stableswap-ng-identity");
    const provenance = evmProfile.stableSwapNgFactoryProvenance;
    if (
      !policy ||
      provenance == null ||
      provenance.blockNumber !== evmProfile.blockNumber ||
      !/^0x[0-9a-f]{64}$/.test(provenance.blockHash) ||
      provenance.blockCommitment !== "finalized" ||
      provenance.factoryAddress !== policy.factoryAddress ||
      provenance.factoryCodeHash !== policy.factoryCodeHash ||
      provenance.poolIndex !== policy.factoryPoolIndex ||
      provenance.registeredPoolAddress !== policy.poolAddress ||
      provenance.poolTokenAddresses.length !== policy.poolTokenAddresses.length ||
      provenance.poolTokenAddresses.some(
        (address, index) => address !== policy.poolTokenAddresses[index],
      )
    ) issues.push("physical-pool-provenance-mismatch");
  } else {
    const evmProfile = profile as DexMeasuredExecutionPublicProfile;
    if (evmProfile.poolTokenAddresses?.length !== 2) issues.push("invalid-cl-token-count");
    if (
      evmProfile.poolProvenance == null ||
      canonicalExitRouteAssetKey(evmProfile.chain, evmProfile.poolProvenance.resolvedPoolAddress) !==
        evmProfile.poolId
    ) issues.push("physical-pool-provenance-mismatch");
  }
  if (
    context.observedAt - profile.quotedAt >
    getDexMeasuredExecutionFreshnessMaxSec(profile.adapterProfileId)
  ) issues.push("stale-profile");
  if (profile.quotedAt > context.observedAt + 60) issues.push("future-profile");
  if (
    !Number.isFinite(profile.retainedTvlUsdAtQuote) ||
    Math.abs(profile.retainedTvlUsdAtQuote / context.pool.tvlUsd - 1) > 0.2
  )
    issues.push("retained-tvl-mismatch");
  if (profile.capacityCurve.some((point) => point.executableUsd > context.pool.tvlUsd * 1.5 + 0.01)) {
    issues.push("capacity-above-retained-tvl-bound");
  }
  if (profile.marginalOutputRatio < 0.98 && profile.capacityCurve.some((point) => point.executableUsd > 0)) {
    issues.push("marginal-failure-with-positive-capacity");
  }
  issues.push(...validateExitRouteCapacityCurve(profile.capacityCurve));
  const history = observationHistoryForProfile(profile);
  if (history) {
    const currentByPoint = new Map(
      profile.capacityCurve.map((point) => [`${point.requestedNotionalUsd}:${point.maxCostBps}`, point] as const),
    );
    if (history.observationWindowEndedAt < profile.quotedAt) issues.push("history-before-selected-quote");
    if (history.observationWindowEndedAt > context.observedAt + 60) issues.push("future-history");
    for (const point of history.conservativeCapacityCurve) {
      const current = currentByPoint.get(`${point.requestedNotionalUsd}:${point.maxCostBps}`);
      if (!current || point.executableUsd > current.executableUsd + 0.01) {
        issues.push("invalid-conservative-history");
        break;
      }
    }
    issues.push(
      ...validateExitRouteCapacityCurve(history.conservativeCapacityCurve).map(
        (issue) => `invalid-conservative-history:${issue}`,
      ),
    );
  }
  return [...new Set(issues)];
}

export function isCompleteCurveStableSwapDirectionPacket(
  profiles: readonly P4MeasuredExecutionPublicProfile[],
): boolean {
  if (profiles.length !== 2) return false;
  const inputAddress = profiles[0]?.tokenIn.address;
  if (!inputAddress || !CURVE_3POOL_TOKEN_ADDRESSES.includes(inputAddress as typeof CURVE_3POOL_TOKEN_ADDRESSES[number])) {
    return false;
  }
  const expectedOutputs = CURVE_3POOL_TOKEN_ADDRESSES.filter((address) => address !== inputAddress).sort();
  const actualOutputs = profiles.map((profile) => profile.tokenOut.address).sort();
  return (
    new Set(profiles.map((profile) => profile.tokenIn.address)).size === 1 &&
    actualOutputs.length === expectedOutputs.length &&
    actualOutputs.every((address, index) => address === expectedOutputs[index])
  );
}

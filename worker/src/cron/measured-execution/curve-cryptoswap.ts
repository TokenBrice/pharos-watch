import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, keccak256, parseAbi } from "viem/utils";

import {
  buildDexMeasuredExecutionTargetId,
  type DexMeasuredExecutionProfile,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { throwIfAborted } from "../../lib/abort";
import {
  fetchEvmCallHexAtBlock,
  fetchEvmCodeAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  type EvmMulticall3Call,
  type EvmMulticall3Result,
} from "../../lib/evm-rpc";
import {
  DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
  type DexMeasuredExecutionAdapter,
  type DexMeasuredExecutionBudgetStopReason,
  type DexMeasuredExecutionRpcBudget,
  type DexMeasuredRawQuotePoint,
} from "./profiles";
import { executeAdaptiveMulticall } from "./adaptive-multicall";
import { forEachWithConcurrency } from "./concurrency";
import { usdToRawAmount } from "./fixed-point";
import { decodeCurveMeasuredRawQuotePoint } from "./curve-quote-point";

const CURVE_CRYPTOSWAP_ABI = parseAbi(["function get_dy(uint256 i,uint256 j,uint256 dx) view returns (uint256)"]);
const CURVE_CRYPTOSWAP_DEPENDENCY_ABI = parseAbi([
  "function coins(uint256) view returns (address)",
  "function factory() view returns (address)",
  "function MATH() view returns (address)",
  "function is_killed() view returns (bool)",
  "function views_implementation() view returns (address)",
]);
const CURVE_MULTICALL_BATCH_SIZE = 8;
const CURVE_MULTICALL_GAS = "0x1c9c380";
const EVM_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const CODE_HASH_PATTERN = /^0x[0-9a-f]{64}$/;

export const CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID = "curve-cryptoswap-get-dy-v1" as const;

export type CurveCryptoSwapGeneration = "legacy-cryptoswap" | "twocrypto-ng" | "tricrypto-ng" | "special-tridbr";

/**
 * How a policy proves it is quoting the pool it claims.
 *
 * - `pinned-pool-code` pins that individual pool's runtime code hash and every
 *   dependency address/hash by hand.
 * - `reviewed-deployment-family` pins the deployment family instead (factory,
 *   factory-selected views implementation, immutable math contract). Curve NG
 *   bakes constructor immutables into each pool's runtime code, so pool code
 *   hashes are per-pool and cannot be pre-pinned without a production capture;
 *   the family triple is what actually proves the generation, which is the
 *   graduation bar the shadow census was waiting on.
 */
export type CurveCryptoSwapIdentityAnchor = "pinned-pool-code" | "reviewed-deployment-family";

export interface CurveCryptoSwapPoolPolicy {
  chain: "ethereum" | "arbitrum" | "base" | "polygon";
  poolAddress: `0x${string}`;
  generation: CurveCryptoSwapGeneration;
  mode: "shadow" | "active";
  identityAnchor: CurveCryptoSwapIdentityAnchor;
  scoreEligible: boolean;
  expectedPoolCodeHash?: `0x${string}`;
  expectedFactoryAddress?: `0x${string}`;
  expectedFactoryCodeHash?: `0x${string}`;
  expectedViewsAddress?: `0x${string}`;
  expectedViewsCodeHash?: `0x${string}`;
  expectedMathAddress?: `0x${string}`;
  expectedMathCodeHash?: `0x${string}`;
  transferSemanticsReviewed: boolean;
}

const ETHEREUM_TWOCRYPTO_FACTORY = "0x98ee851a00abee0d95d08cf4ca2bdce32aeaaf7f";
const ETHEREUM_TWOCRYPTO_FACTORY_CODE_HASH = "0xbb7ab663bc3ea17b6e97e4fa41bc7b5912b49e8835cce4d9643b86ac5b29b986";
const ETHEREUM_TWOCRYPTO_VIEWS = "0x07cdebf81977e111b08c126defa07818d0045b80";
const ETHEREUM_TWOCRYPTO_VIEWS_CODE_HASH = "0x150bdfd73c90c22774ddcbf6672214afc6e2587afa27fb145576138382de7d9c";
const ETHEREUM_TWOCRYPTO_MATH_A = "0xbfddf58cb6ef84e115ff47c10e49a80b2653ea13";
const ETHEREUM_TWOCRYPTO_MATH_A_CODE_HASH = "0x8d9625bc2747c3d3471e2cd9dd3a3dd3855271b6a4c711b6b7c2e576163211f2";
const ETHEREUM_TWOCRYPTO_MATH_B = "0x79839c2d74531a8222c0f555865aac1834e82e51";
const ETHEREUM_TWOCRYPTO_MATH_B_CODE_HASH = "0xe97fd5e910f41e3c85fd62c320b19b05e505422366e8c2cad63af015338b38d7";
const ETHEREUM_TWOCRYPTO_MATH_C = "0x2005995a71243be9fb995dab4742327dc76564df";
const ETHEREUM_TWOCRYPTO_MATH_C_CODE_HASH = "0xbc931b24ccca3aae2cd24bf83022386ae21d4c96af2f7c7f57a91c743b8352e3";
const ETHEREUM_TWOCRYPTO_MATH_D = "0x1fd8af16dc4bebd950521308d55d0543b6cdf4a1";
const ETHEREUM_TWOCRYPTO_MATH_D_CODE_HASH = "0x70d105ee0e9b857244d87521bbcef34cfb4cbd600592af61bbc7c76180648d61";

export interface CurveCryptoSwapReviewedDeploymentFamily {
  chain: CurveCryptoSwapPoolPolicy["chain"];
  generation: CurveCryptoSwapGeneration;
  factoryAddress: `0x${string}`;
  factoryCodeHash: `0x${string}`;
  viewsAddress: `0x${string}`;
  viewsCodeHash: `0x${string}`;
  /** Every reviewed immutable math deployment the factory has selected. */
  mathDeployments: readonly { address: `0x${string}`; codeHash: `0x${string}` }[];
}

/**
 * Deployment families whose factory, views implementation, and math contracts
 * are already reviewed by the pinned active cohort below. Every address and
 * hash here is the same evidence the eight hand-pinned pools carry; nothing is
 * asserted for a family that has no pinned pool.
 */
export const CURVE_CRYPTOSWAP_REVIEWED_FAMILIES: readonly CurveCryptoSwapReviewedDeploymentFamily[] = [
  {
    chain: "ethereum",
    generation: "twocrypto-ng",
    factoryAddress: ETHEREUM_TWOCRYPTO_FACTORY,
    factoryCodeHash: ETHEREUM_TWOCRYPTO_FACTORY_CODE_HASH,
    viewsAddress: ETHEREUM_TWOCRYPTO_VIEWS,
    viewsCodeHash: ETHEREUM_TWOCRYPTO_VIEWS_CODE_HASH,
    mathDeployments: [
      { address: ETHEREUM_TWOCRYPTO_MATH_A, codeHash: ETHEREUM_TWOCRYPTO_MATH_A_CODE_HASH },
      { address: ETHEREUM_TWOCRYPTO_MATH_B, codeHash: ETHEREUM_TWOCRYPTO_MATH_B_CODE_HASH },
      { address: ETHEREUM_TWOCRYPTO_MATH_C, codeHash: ETHEREUM_TWOCRYPTO_MATH_C_CODE_HASH },
      { address: ETHEREUM_TWOCRYPTO_MATH_D, codeHash: ETHEREUM_TWOCRYPTO_MATH_D_CODE_HASH },
    ],
  },
] as const;

export function getCurveCryptoSwapReviewedDeploymentFamily(
  chain: string,
  generation: CurveCryptoSwapGeneration,
): CurveCryptoSwapReviewedDeploymentFamily | null {
  const normalizedChain = chain.trim().toLowerCase();
  return (
    CURVE_CRYPTOSWAP_REVIEWED_FAMILIES.find(
      (family) => family.chain === normalizedChain && family.generation === generation,
    ) ?? null
  );
}

function activeEthereumTwocryptoPolicy(
  poolAddress: `0x${string}`,
  expectedPoolCodeHash: `0x${string}`,
  expectedMathAddress: `0x${string}`,
  expectedMathCodeHash: `0x${string}`,
): CurveCryptoSwapPoolPolicy {
  return {
    chain: "ethereum",
    poolAddress,
    generation: "twocrypto-ng",
    mode: "active",
    identityAnchor: "pinned-pool-code",
    scoreEligible: true,
    expectedPoolCodeHash,
    expectedFactoryAddress: ETHEREUM_TWOCRYPTO_FACTORY,
    expectedFactoryCodeHash: ETHEREUM_TWOCRYPTO_FACTORY_CODE_HASH,
    expectedViewsAddress: ETHEREUM_TWOCRYPTO_VIEWS,
    expectedViewsCodeHash: ETHEREUM_TWOCRYPTO_VIEWS_CODE_HASH,
    expectedMathAddress,
    expectedMathCodeHash,
    transferSemanticsReviewed: true,
  };
}

/**
 * Reviewed census pool promoted under ruling R3 (2026-07-29): the owner granted
 * the generation and transfer-semantics validation the census was waiting on,
 * so these pools quote through the same measured `get_dy` adapter as the pinned
 * cohort. Their runtime dependency triple is still proven at the pinned quote
 * block against the reviewed family; only the per-pool bytecode pin is absent,
 * because Curve NG bakes per-pool immutables into the runtime code and that
 * hash can only come from a production capture.
 */
function familyVerifiedPolicy(
  chain: CurveCryptoSwapPoolPolicy["chain"],
  poolAddress: `0x${string}`,
  generation: CurveCryptoSwapGeneration,
): CurveCryptoSwapPoolPolicy {
  return {
    chain,
    poolAddress,
    generation,
    mode: "active",
    identityAnchor: "reviewed-deployment-family",
    scoreEligible: true,
    transferSemanticsReviewed: true,
  };
}

function shadowPolicy(
  chain: CurveCryptoSwapPoolPolicy["chain"],
  poolAddress: `0x${string}`,
  generation: CurveCryptoSwapGeneration,
): CurveCryptoSwapPoolPolicy {
  return {
    chain,
    poolAddress,
    generation,
    mode: "shadow",
    identityAnchor: "pinned-pool-code",
    scoreEligible: false,
    transferSemanticsReviewed: false,
  };
}

/** Fixed reviewed cohort: eight active Ethereum TwoCrypto pools plus shadow-only candidates. */
export const CURVE_CRYPTOSWAP_SHADOW_COHORT: readonly CurveCryptoSwapPoolPolicy[] = [
  activeEthereumTwocryptoPolicy(
    "0x862cb4e988fb66e72f128d1183829f8c05b6c6a0",
    "0xd19e3a232367411c825df98165c95898c08e181fe2e0f9211445f48eb4c0dc62",
    "0xbfddf58cb6ef84e115ff47c10e49a80b2653ea13",
    "0x8d9625bc2747c3d3471e2cd9dd3a3dd3855271b6a4c711b6b7c2e576163211f2",
  ),
  activeEthereumTwocryptoPolicy(
    "0x313698667d7fdd6789a9bc70821309ff891e729a",
    "0xe4ac67017f888827e6efe22cd8edc37bf562166368f6eb62837bff2e4a4a23e8",
    "0xbfddf58cb6ef84e115ff47c10e49a80b2653ea13",
    "0x8d9625bc2747c3d3471e2cd9dd3a3dd3855271b6a4c711b6b7c2e576163211f2",
  ),
  activeEthereumTwocryptoPolicy(
    "0x6e5492f8ea2370844ee098a56dd88e1717e4a9c2",
    "0x21cdea51fbfdc55ec46c00742aa4518bb8bed7716052d59a5c878829b7ed8183",
    "0x79839c2d74531a8222c0f555865aac1834e82e51",
    "0xe97fd5e910f41e3c85fd62c320b19b05e505422366e8c2cad63af015338b38d7",
  ),
  activeEthereumTwocryptoPolicy(
    "0x4f52c3a81e33521e5a9a47fd9d3be475d2279c2e",
    "0xaefafc4c0157bc496db238fc46d730a140174f3fb542527bb86443974ed4f7a6",
    "0xbfddf58cb6ef84e115ff47c10e49a80b2653ea13",
    "0x8d9625bc2747c3d3471e2cd9dd3a3dd3855271b6a4c711b6b7c2e576163211f2",
  ),
  activeEthereumTwocryptoPolicy(
    "0x656341ef90b622c6634e0573772ffb7f3669b9f3",
    "0x116eeee684882885cda3ddf0287d0979f71d64030fbec90f1f52924cf0e7643a",
    "0xbfddf58cb6ef84e115ff47c10e49a80b2653ea13",
    "0x8d9625bc2747c3d3471e2cd9dd3a3dd3855271b6a4c711b6b7c2e576163211f2",
  ),
  familyVerifiedPolicy("ethereum", "0xe79fb88c7937b39b3e1cabd44faefa5258578b2d", "twocrypto-ng"),
  familyVerifiedPolicy("ethereum", "0x384ca8992f955009bdd94849488e580559590157", "twocrypto-ng"),
  familyVerifiedPolicy("ethereum", "0x4fdccb810f22578ad6700fc10a8c9b6c1df61852", "twocrypto-ng"),
  familyVerifiedPolicy("ethereum", "0xca546ae6c3b2bb9fba2b6e5eeb0881097cece5b0", "twocrypto-ng"),
  familyVerifiedPolicy("ethereum", "0x592878b920101946fb5915ab97961bc546f211cc", "twocrypto-ng"),
  shadowPolicy("ethereum", "0x06ac09ca29369e2483533eb68dfe0a4d4143543d", "tricrypto-ng"),
  shadowPolicy("ethereum", "0x4ebdf703948ddcea3b11f675b4d1fba9d2414a14", "tricrypto-ng"),
  activeEthereumTwocryptoPolicy(
    "0xf1f435b05d255a5dbde37333c0f61da6f69c6127",
    "0xd0b9195b91086bd9cafaa5e1ab8a6eab1a0d473fadb6c1a3ca69e31f687100e9",
    "0x79839c2d74531a8222c0f555865aac1834e82e51",
    "0xe97fd5e910f41e3c85fd62c320b19b05e505422366e8c2cad63af015338b38d7",
  ),
  activeEthereumTwocryptoPolicy(
    "0x83f24023d15d835a213df24fd309c47dab5beb32",
    "0xb00ba7467a75fffe15d018cc822a09b282a285f4012f857b19966046b3191b3a",
    "0x79839c2d74531a8222c0f555865aac1834e82e51",
    "0xe97fd5e910f41e3c85fd62c320b19b05e505422366e8c2cad63af015338b38d7",
  ),
  activeEthereumTwocryptoPolicy(
    "0xd9ff8396554a0d18b2cfbec53e1979b7ecce8373",
    "0x1578c5a836891e466a1fa5879bc7f0e36bfd9fc625586765541191d8cd3880ae",
    "0x79839c2d74531a8222c0f555865aac1834e82e51",
    "0xe97fd5e910f41e3c85fd62c320b19b05e505422366e8c2cad63af015338b38d7",
  ),
  familyVerifiedPolicy("ethereum", "0xec977f46467a3021785cff88894886e617abd65b", "twocrypto-ng"),
  shadowPolicy("ethereum", "0x66da369fc5dbba0774da70546bd20f2b242cd34d", "special-tridbr"),
  shadowPolicy("ethereum", "0x98a7f18d4e56cfe84e3d081b40001b3d5bd3eb8b", "legacy-cryptoswap"),
  familyVerifiedPolicy("ethereum", "0x26d85588b9ed20aba4fa8fb9b3c8977c4aad133c", "twocrypto-ng"),
  familyVerifiedPolicy("ethereum", "0x57129759d0e23116c1e7402dbc084e53d2e209a2", "twocrypto-ng"),
  familyVerifiedPolicy("ethereum", "0x43b98eea5c689f0036918f590a4b55f22d853734", "twocrypto-ng"),
  familyVerifiedPolicy("ethereum", "0x51a57b0a36ef63828929683609fa1fc12c72a776", "twocrypto-ng"),
  familyVerifiedPolicy("ethereum", "0x027b40f5917fcd0eac57d7015e120096a5f92ca9", "twocrypto-ng"),
  shadowPolicy("base", "0x6771bb9ec8da900eeba738599c3cc4f8fc07aea7d", "twocrypto-ng"),
  shadowPolicy("base", "0xba0c274085a078d19c46f2d902698a841cbfb289", "twocrypto-ng"),
  shadowPolicy("arbitrum", "0x590f7e2b211fa5ff7840dd3c425b543363797701", "twocrypto-ng"),
  shadowPolicy("polygon", "0xcb6dcbcb1da63acc01e6cc9804d0aee5a0dbb3ba", "twocrypto-ng"),
  shadowPolicy("polygon", "0xdcb72c163de84618417bec9aef7ae32b5336d70e", "twocrypto-ng"),
  shadowPolicy("polygon", "0xbae895c43c3af0f76e8bed2af8d1063afce35f5d", "twocrypto-ng"),
  shadowPolicy("polygon", "0xf5c83f5f7d3975726527feade0e51c6e5ecf7ba5", "twocrypto-ng"),
] as const;

export interface CurveCryptoSwapRuntimeEvidence {
  apiIsBroken?: boolean;
  poolCodeHash?: `0x${string}`;
  factoryAddress?: `0x${string}`;
  factoryCodeHash?: `0x${string}`;
  viewsAddress?: `0x${string}`;
  viewsCodeHash?: `0x${string}`;
  mathAddress?: `0x${string}`;
  mathCodeHash?: `0x${string}`;
  legacyIsKilled?: boolean;
  ngKillMethodUnavailable?: boolean;
  transferSemanticsReviewed?: boolean;
  onChainPoolTokenAddresses?: readonly `0x${string}`[];
}

export type CurveCryptoSwapEligibilityFailure =
  | "pool-not-in-shadow-cohort"
  | "execution-endpoint-mismatch"
  | "api-broken-or-unknown"
  | "legacy-kill-state-unavailable"
  | "legacy-pool-killed"
  | "ng-kill-method-not-proven-absent"
  | "runtime-allowlist-incomplete"
  | "runtime-code-unavailable"
  | "runtime-code-hash-mismatch"
  | "dependency-code-unavailable"
  | "dependency-identity-mismatch"
  | "dependency-code-hash-mismatch"
  | "transfer-semantics-unreviewed"
  | "pool-token-order-unverified"
  | "shadow-score-ineligible";

export type CurveCryptoSwapEligibility = { ok: true } | { ok: false; reason: CurveCryptoSwapEligibilityFailure };

export function getCurveCryptoSwapShadowPolicy(chain: string, poolAddress: string): CurveCryptoSwapPoolPolicy | null {
  const address = canonicalAddress(poolAddress);
  const normalizedChain = chain.trim().toLowerCase();
  if (address == null) return null;
  return (
    CURVE_CRYPTOSWAP_SHADOW_COHORT.find((entry) => entry.chain === normalizedChain && entry.poolAddress === address) ??
    null
  );
}

function matchesAddress(actual: unknown, expected: `0x${string}`): boolean {
  return canonicalAddress(actual) === expected;
}

function matchesCodeHash(actual: unknown, expected: `0x${string}`): boolean {
  return canonicalCodeHash(actual) === expected;
}

/** Fail-closed score eligibility independent of quote transport. */
export function evaluateCurveCryptoSwapEligibility(input: {
  chain: string;
  endpointAddress: string;
  policy?: CurveCryptoSwapPoolPolicy | null;
  evidence?: CurveCryptoSwapRuntimeEvidence;
}): CurveCryptoSwapEligibility {
  const endpointAddress = canonicalAddress(input.endpointAddress);
  const policy = input.policy ?? getCurveCryptoSwapShadowPolicy(input.chain, input.endpointAddress);
  if (policy == null) return { ok: false, reason: "pool-not-in-shadow-cohort" };
  if (endpointAddress !== policy.poolAddress || input.chain.trim().toLowerCase() !== policy.chain) {
    return { ok: false, reason: "execution-endpoint-mismatch" };
  }
  const evidence = input.evidence;
  if (evidence?.apiIsBroken !== false) return { ok: false, reason: "api-broken-or-unknown" };

  if (policy.generation === "legacy-cryptoswap") {
    if (evidence.legacyIsKilled == null) return { ok: false, reason: "legacy-kill-state-unavailable" };
    if (evidence.legacyIsKilled) return { ok: false, reason: "legacy-pool-killed" };
  } else if (evidence.ngKillMethodUnavailable !== true) {
    return { ok: false, reason: "ng-kill-method-not-proven-absent" };
  }

  if (policy.identityAnchor === "reviewed-deployment-family") {
    const family = getCurveCryptoSwapReviewedDeploymentFamily(policy.chain, policy.generation);
    if (family == null) return { ok: false, reason: "runtime-allowlist-incomplete" };
    if (canonicalCodeHash(evidence.poolCodeHash) == null) return { ok: false, reason: "runtime-code-unavailable" };
    const factoryAddress = canonicalAddress(evidence.factoryAddress);
    const viewsAddress = canonicalAddress(evidence.viewsAddress);
    const mathAddress = canonicalAddress(evidence.mathAddress);
    if (
      factoryAddress == null ||
      canonicalCodeHash(evidence.factoryCodeHash) == null ||
      viewsAddress == null ||
      canonicalCodeHash(evidence.viewsCodeHash) == null ||
      mathAddress == null ||
      canonicalCodeHash(evidence.mathCodeHash) == null
    )
      return { ok: false, reason: "dependency-code-unavailable" };
    const mathDeployment = family.mathDeployments.find((entry) => entry.address === mathAddress);
    if (factoryAddress !== family.factoryAddress || viewsAddress !== family.viewsAddress || mathDeployment == null) {
      return { ok: false, reason: "dependency-identity-mismatch" };
    }
    if (
      !matchesCodeHash(evidence.factoryCodeHash, family.factoryCodeHash) ||
      !matchesCodeHash(evidence.viewsCodeHash, family.viewsCodeHash) ||
      !matchesCodeHash(evidence.mathCodeHash, mathDeployment.codeHash)
    )
      return { ok: false, reason: "dependency-code-hash-mismatch" };
    if (!policy.transferSemanticsReviewed || evidence.transferSemanticsReviewed !== true) {
      return { ok: false, reason: "transfer-semantics-unreviewed" };
    }
    if (policy.scoreEligible && (evidence.onChainPoolTokenAddresses?.length ?? 0) < 2) {
      return { ok: false, reason: "pool-token-order-unverified" };
    }
    return policy.scoreEligible ? { ok: true } : { ok: false, reason: "shadow-score-ineligible" };
  }

  const expectedHashes = [
    policy.expectedPoolCodeHash,
    policy.expectedFactoryCodeHash,
    policy.expectedViewsCodeHash,
    policy.expectedMathCodeHash,
  ];
  const expectedAddresses = [policy.expectedFactoryAddress, policy.expectedViewsAddress, policy.expectedMathAddress];
  if (expectedHashes.some((value) => value == null) || expectedAddresses.some((value) => value == null)) {
    return { ok: false, reason: "runtime-allowlist-incomplete" };
  }
  if (canonicalCodeHash(evidence.poolCodeHash) == null) return { ok: false, reason: "runtime-code-unavailable" };
  if (!matchesCodeHash(evidence.poolCodeHash, policy.expectedPoolCodeHash!)) {
    return { ok: false, reason: "runtime-code-hash-mismatch" };
  }
  if (
    canonicalAddress(evidence.factoryAddress) == null ||
    canonicalCodeHash(evidence.factoryCodeHash) == null ||
    canonicalAddress(evidence.viewsAddress) == null ||
    canonicalCodeHash(evidence.viewsCodeHash) == null ||
    canonicalAddress(evidence.mathAddress) == null ||
    canonicalCodeHash(evidence.mathCodeHash) == null
  )
    return { ok: false, reason: "dependency-code-unavailable" };
  if (
    !matchesAddress(evidence.factoryAddress, policy.expectedFactoryAddress!) ||
    !matchesAddress(evidence.viewsAddress, policy.expectedViewsAddress!) ||
    !matchesAddress(evidence.mathAddress, policy.expectedMathAddress!)
  )
    return { ok: false, reason: "dependency-identity-mismatch" };
  if (
    !matchesCodeHash(evidence.factoryCodeHash, policy.expectedFactoryCodeHash!) ||
    !matchesCodeHash(evidence.viewsCodeHash, policy.expectedViewsCodeHash!) ||
    !matchesCodeHash(evidence.mathCodeHash, policy.expectedMathCodeHash!)
  )
    return { ok: false, reason: "dependency-code-hash-mismatch" };
  if (!policy.transferSemanticsReviewed || evidence.transferSemanticsReviewed !== true) {
    return { ok: false, reason: "transfer-semantics-unreviewed" };
  }
  if (policy.scoreEligible && (evidence.onChainPoolTokenAddresses?.length ?? 0) < 2) {
    return { ok: false, reason: "pool-token-order-unverified" };
  }
  if (!policy.scoreEligible) return { ok: false, reason: "shadow-score-ineligible" };
  return { ok: true };
}

export type CurveCryptoSwapDeploymentVerification =
  | { ok: true; codeHash: `0x${string}`; runtimeEvidence: CurveCryptoSwapRuntimeEvidence }
  | { ok: false; reason: CurveCryptoSwapEligibilityFailure };

export async function verifyCurveCryptoSwapDeployment(input: {
  policy: CurveCryptoSwapPoolPolicy;
  blockNumber: number;
  chainRpcs: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  rpcBudget?: DexMeasuredExecutionRpcBudget;
}): Promise<CurveCryptoSwapDeploymentVerification> {
  const { policy, rpcBudget } = input;
  const requestOptions = {
    chainRpcs: input.chainRpcs,
    signal: input.signal,
    timeoutMs: DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
    ...(rpcBudget ? { deadlineMs: rpcBudget.deadlineMs } : {}),
    ...(rpcBudget ? { beforeRequest: () => rpcBudget.tryConsume() } : {}),
    maxRetries: 0,
  };
  const readCodeHash = async (address: `0x${string}`): Promise<`0x${string}` | null> => {
    if (rpcBudget && !rpcBudget.canRequestChain(policy.chain)) return null;
    const code = await fetchEvmCodeAtBlock(policy.chain, address, input.blockNumber, requestOptions);
    rpcBudget?.recordChainResult(policy.chain, code != null);
    return code == null ? null : (keccak256(code).toLowerCase() as `0x${string}`);
  };
  const readAddress = async (address: `0x${string}`, functionName: "factory" | "MATH" | "views_implementation") => {
    if (rpcBudget && !rpcBudget.canRequestChain(policy.chain)) return null;
    const raw = await fetchEvmCallHexAtBlock(
      policy.chain,
      address,
      encodeFunctionData({ abi: CURVE_CRYPTOSWAP_DEPENDENCY_ABI, functionName }),
      input.blockNumber,
      requestOptions,
    );
    rpcBudget?.recordChainResult(policy.chain, raw != null);
    if (raw == null) return null;
    try {
      return canonicalAddress(decodeFunctionResult({ abi: CURVE_CRYPTOSWAP_DEPENDENCY_ABI, functionName, data: raw }));
    } catch {
      return null;
    }
  };

  const readCoin = async (index: number): Promise<`0x${string}` | null> => {
    if (rpcBudget && !rpcBudget.canRequestChain(policy.chain)) return null;
    const raw = await fetchEvmCallHexAtBlock(
      policy.chain,
      policy.poolAddress,
      encodeFunctionData({ abi: CURVE_CRYPTOSWAP_DEPENDENCY_ABI, functionName: "coins", args: [BigInt(index)] }),
      input.blockNumber,
      requestOptions,
    );
    rpcBudget?.recordChainResult(policy.chain, raw != null);
    if (raw == null) return null;
    try {
      return canonicalAddress(
        decodeFunctionResult({ abi: CURVE_CRYPTOSWAP_DEPENDENCY_ABI, functionName: "coins", data: raw }),
      );
    } catch {
      return null;
    }
  };

  const poolCodeHash = await readCodeHash(policy.poolAddress);
  if (poolCodeHash == null) return { ok: false, reason: "runtime-code-unavailable" };
  const factoryAddress = await readAddress(policy.poolAddress, "factory");
  const mathAddress = await readAddress(policy.poolAddress, "MATH");
  if (factoryAddress == null || mathAddress == null) return { ok: false, reason: "dependency-code-unavailable" };
  const viewsAddress = await readAddress(factoryAddress, "views_implementation");
  if (viewsAddress == null) return { ok: false, reason: "dependency-code-unavailable" };
  const factoryCodeHash = await readCodeHash(factoryAddress);
  const viewsCodeHash = await readCodeHash(viewsAddress);
  const mathCodeHash = await readCodeHash(mathAddress);
  const onChainPoolTokenAddresses = [await readCoin(0), await readCoin(1)];

  const killedRaw = await fetchEvmCallHexAtBlock(
    policy.chain,
    policy.poolAddress,
    encodeFunctionData({ abi: CURVE_CRYPTOSWAP_DEPENDENCY_ABI, functionName: "is_killed" }),
    input.blockNumber,
    requestOptions,
  );
  const runtimeEvidence: CurveCryptoSwapRuntimeEvidence = {
    apiIsBroken: false,
    poolCodeHash,
    factoryAddress,
    ...(factoryCodeHash ? { factoryCodeHash } : {}),
    viewsAddress,
    ...(viewsCodeHash ? { viewsCodeHash } : {}),
    mathAddress,
    ...(mathCodeHash ? { mathCodeHash } : {}),
    ngKillMethodUnavailable: killedRaw == null,
    transferSemanticsReviewed: policy.transferSemanticsReviewed,
    ...(onChainPoolTokenAddresses.every((address) => address != null)
      ? { onChainPoolTokenAddresses: onChainPoolTokenAddresses as [`0x${string}`, `0x${string}`] }
      : {}),
  };
  const eligibility = evaluateCurveCryptoSwapEligibility({
    chain: policy.chain,
    endpointAddress: policy.poolAddress,
    policy,
    evidence: runtimeEvidence,
  });
  return eligibility.ok ? { ok: true, codeHash: poolCodeHash, runtimeEvidence } : eligibility;
}

export type CurveCryptoSwapQuoteFailure =
  | DexMeasuredExecutionBudgetStopReason
  | "unsupported-chain-or-pool"
  | "invalid-pinned-block"
  | "invalid-quote-input"
  | "invalid-curve-cryptoswap-target"
  | "missing-pool-token-order"
  | "invalid-pool-token-order"
  | "ambiguous-token-index"
  | "token-index-mismatch"
  | "pool-token-order-mismatch"
  | "pool-revert"
  | "malformed-pool-return";

export interface CurveCryptoSwapRequest {
  target: DexMeasuredExecutionTarget;
  inputUsd: number;
  blockNumber: number;
  endpointAddress: `0x${string}`;
  runtimeEvidence?: CurveCryptoSwapRuntimeEvidence;
}

interface EncodedCurveCryptoSwapRequest extends CurveCryptoSwapRequest {
  index: number;
  label: string;
  amountInRaw: bigint;
  inputIndex: number;
  outputIndex: number;
  callData: `0x${string}`;
  endpointAddress: `0x${string}`;
  policy: CurveCryptoSwapPoolPolicy;
  eligibility: CurveCryptoSwapEligibility;
}

export interface CurveCryptoSwapBatchOutcome {
  targetId: string;
  inputUsd: number;
  blockNumber: number;
  eligibility: CurveCryptoSwapEligibility;
  point?: DexMeasuredRawQuotePoint;
  failureReason?: CurveCryptoSwapQuoteFailure;
}

interface CurveCryptoSwapQuoteDependencies {
  executeMulticall(input: {
    chain: string;
    calls: readonly EvmMulticall3Call[];
    blockNumber: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    rpcBudget?: DexMeasuredExecutionRpcBudget;
    onBudgetStop?: (reason: DexMeasuredExecutionBudgetStopReason) => void;
  }): Promise<EvmMulticall3Result[] | null>;
}

function canonicalAddress(value: unknown): `0x${string}` | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return EVM_ADDRESS_PATTERN.test(normalized) ? (normalized as `0x${string}`) : null;
}

function canonicalCodeHash(value: unknown): `0x${string}` | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return CODE_HASH_PATTERN.test(normalized) ? (normalized as `0x${string}`) : null;
}

export function resolveCurveCryptoSwapTokenIndices(
  target: DexMeasuredExecutionTarget | DexMeasuredExecutionProfile,
): { ok: true; inputIndex: number; outputIndex: number } | { ok: false; reason: CurveCryptoSwapQuoteFailure } {
  if (
    target.adapterProfileId !== CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID ||
    target.protocol.trim().toLowerCase() !== "curve"
  )
    return { ok: false, reason: "invalid-curve-cryptoswap-target" };
  if (target.poolTokenAddresses == null) return { ok: false, reason: "missing-pool-token-order" };
  if (target.poolTokenAddresses.length < 2 || target.poolTokenAddresses.length > 8) {
    return { ok: false, reason: "invalid-pool-token-order" };
  }
  const orderedTokens = target.poolTokenAddresses.map(canonicalAddress);
  if (orderedTokens.some((address) => address == null)) {
    return { ok: false, reason: "invalid-pool-token-order" };
  }
  const tokenIn = canonicalAddress(target.tokenIn.address);
  const tokenOut = canonicalAddress(target.tokenOut.address);
  if (tokenIn == null || tokenOut == null || tokenIn === tokenOut) {
    return { ok: false, reason: "invalid-curve-cryptoswap-target" };
  }
  const inputMatches = orderedTokens.flatMap((address, index) => (address === tokenIn ? [index] : []));
  const outputMatches = orderedTokens.flatMap((address, index) => (address === tokenOut ? [index] : []));
  if (inputMatches.length > 1 || outputMatches.length > 1) {
    return { ok: false, reason: "ambiguous-token-index" };
  }
  if (inputMatches.length !== 1 || outputMatches.length !== 1 || inputMatches[0] === outputMatches[0]) {
    return { ok: false, reason: "token-index-mismatch" };
  }
  return { ok: true, inputIndex: inputMatches[0]!, outputIndex: outputMatches[0]! };
}

export function encodeCurveCryptoSwapGetDy(input: {
  inputIndex: number;
  outputIndex: number;
  amountInRaw: bigint;
}): `0x${string}` {
  if (
    !Number.isInteger(input.inputIndex) ||
    input.inputIndex < 0 ||
    input.inputIndex > 7 ||
    !Number.isInteger(input.outputIndex) ||
    input.outputIndex < 0 ||
    input.outputIndex > 7 ||
    input.inputIndex === input.outputIndex ||
    input.amountInRaw <= 0n
  )
    throw new Error("Curve CryptoSwap quote indices or amount are invalid");
  return encodeFunctionData({
    abi: CURVE_CRYPTOSWAP_ABI,
    functionName: "get_dy",
    args: [BigInt(input.inputIndex), BigInt(input.outputIndex), input.amountInRaw],
  }).toLowerCase() as `0x${string}`;
}

export function decodeCurveCryptoSwapGetDy(returnData: `0x${string}`): bigint | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(returnData)) return null;
  try {
    return decodeFunctionResult({
      abi: CURVE_CRYPTOSWAP_ABI,
      functionName: "get_dy",
      data: returnData,
    }) as bigint;
  } catch {
    return null;
  }
}

function prepareRequest(
  request: CurveCryptoSwapRequest,
  index: number,
): {
  encoded?: EncodedCurveCryptoSwapRequest;
  failureReason?: CurveCryptoSwapQuoteFailure;
  eligibility: CurveCryptoSwapEligibility;
} {
  const endpointAddress = canonicalAddress(request.endpointAddress);
  const policy = endpointAddress == null ? null : getCurveCryptoSwapShadowPolicy(request.target.chain, endpointAddress);
  const eligibility = evaluateCurveCryptoSwapEligibility({
    chain: request.target.chain,
    endpointAddress: request.endpointAddress,
    policy,
    evidence: request.runtimeEvidence,
  });
  if (!Number.isSafeInteger(request.blockNumber) || request.blockNumber < 0) {
    return { failureReason: "invalid-pinned-block", eligibility };
  }
  if (endpointAddress == null || policy == null) {
    return { failureReason: "unsupported-chain-or-pool", eligibility };
  }
  const indices = resolveCurveCryptoSwapTokenIndices(request.target);
  if (!indices.ok) return { failureReason: indices.reason, eligibility };
  const expectedTargetId = buildDexMeasuredExecutionTargetId({
    adapterProfileId: request.target.adapterProfileId,
    stablecoinId: request.target.stablecoinId,
    chain: request.target.chain,
    protocol: request.target.protocol,
    poolId: request.target.poolId,
    tokenInAddress: request.target.tokenIn.address,
    tokenOutAddress: request.target.tokenOut.address,
    ...(request.target.poolTokenAddresses ? { poolTokenAddresses: request.target.poolTokenAddresses } : {}),
    ...(request.target.feePips != null ? { feePips: request.target.feePips } : {}),
  });
  if (request.target.targetId !== expectedTargetId) {
    return { failureReason: "invalid-curve-cryptoswap-target", eligibility };
  }
  if (eligibility.ok) {
    const onChainPoolTokenAddresses = request.runtimeEvidence?.onChainPoolTokenAddresses?.map(canonicalAddress) ?? [];
    const targetPoolTokenAddresses = request.target.poolTokenAddresses?.map(canonicalAddress) ?? [];
    if (
      onChainPoolTokenAddresses.length < targetPoolTokenAddresses.length ||
      targetPoolTokenAddresses.some(
        (address, tokenIndex) => address == null || address !== onChainPoolTokenAddresses[tokenIndex],
      )
    ) {
      return { failureReason: "pool-token-order-mismatch", eligibility };
    }
  }
  const amountInRaw = usdToRawAmount(
    request.inputUsd,
    request.target.tokenIn.decimals,
    request.target.tokenIn.referencePriceUsd,
    { maxInputUsd: Number.MAX_SAFE_INTEGER / 1_000_000 },
  );
  if (amountInRaw == null) return { failureReason: "invalid-quote-input", eligibility };
  const callData = encodeCurveCryptoSwapGetDy({
    inputIndex: indices.inputIndex,
    outputIndex: indices.outputIndex,
    amountInRaw,
  });
  return {
    eligibility,
    encoded: {
      ...request,
      index,
      label: `${index}:${request.target.targetId}`,
      amountInRaw,
      inputIndex: indices.inputIndex,
      outputIndex: indices.outputIndex,
      callData,
      endpointAddress,
      policy,
      eligibility,
    },
  };
}

export function decodeCurveCryptoSwapQuotePoint(
  request: Pick<
    EncodedCurveCryptoSwapRequest,
    "amountInRaw" | "callData" | "inputIndex" | "outputIndex" | "blockNumber" | "endpointAddress" | "policy" | "target"
  >,
  result: EvmMulticall3Result,
): { point?: DexMeasuredRawQuotePoint; failureReason?: CurveCryptoSwapQuoteFailure } {
  return decodeCurveMeasuredRawQuotePoint({
    request,
    result,
    decodeAmountOutRaw: decodeCurveCryptoSwapGetDy,
    adapterMetadata: {
      executionPool: request.endpointAddress,
      blockNumber: request.blockNumber,
      inputIndex: request.inputIndex,
      outputIndex: request.outputIndex,
      generation: request.policy.generation,
      shadow: true,
    },
    failureReasons: {
      poolRevert: "pool-revert",
      malformedPoolReturn: "malformed-pool-return",
    },
  });
}

export function createCurveCryptoSwapQuoteExecutor(dependencies: CurveCryptoSwapQuoteDependencies) {
  async function executeAdaptiveChunk(input: {
    chain: string;
    calls: readonly EvmMulticall3Call[];
    blockNumber: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    rpcBudget?: DexMeasuredExecutionRpcBudget;
  }) {
    return executeAdaptiveMulticall<EvmMulticall3Call, EvmMulticall3Result>({
      chain: input.chain,
      calls: input.calls,
      blockNumber: input.blockNumber,
      signal: input.signal,
      execute: ({ chain, calls, blockNumber, signal, onBudgetStop }) =>
        dependencies.executeMulticall({
          chain,
          calls,
          blockNumber,
          chainRpcs: input.chainRpcs,
          signal,
          rpcBudget: input.rpcBudget,
          onBudgetStop,
        }),
      failureResult: (call) => ({ label: call.label, success: false, returnData: "0x" }),
      getLabel: (call) => call.label,
      ...(input.rpcBudget ? { deadlineMs: input.rpcBudget.deadlineMs, budget: input.rpcBudget } : {}),
      failedAttemptAccounting: "all",
      unattemptedResult: "omit",
    });
  }

  return async function quoteCurveCryptoSwapRequests(input: {
    requests: readonly CurveCryptoSwapRequest[];
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    rpcBudget?: DexMeasuredExecutionRpcBudget;
  }): Promise<CurveCryptoSwapBatchOutcome[]> {
    const prepared = input.requests.map(prepareRequest);
    const outcomes: CurveCryptoSwapBatchOutcome[] = input.requests.map((request, index) => ({
      targetId: request.target.targetId,
      inputUsd: request.inputUsd,
      blockNumber: request.blockNumber,
      eligibility: prepared[index]!.eligibility,
      ...(prepared[index]!.failureReason ? { failureReason: prepared[index]!.failureReason } : {}),
    }));
    const valid = prepared.flatMap((entry) => (entry.encoded ? [entry.encoded] : []));
    const groupsByChain = new Map<string, EncodedCurveCryptoSwapRequest[]>();
    for (const request of valid) {
      const group = groupsByChain.get(request.policy.chain) ?? [];
      group.push(request);
      groupsByChain.set(request.policy.chain, group);
    }

    await forEachWithConcurrency([...groupsByChain.values()], 3, async (chainRequests) => {
      const requestsByBlock = new Map<number, EncodedCurveCryptoSwapRequest[]>();
      for (const request of chainRequests) {
        const blockRequests = requestsByBlock.get(request.blockNumber) ?? [];
        blockRequests.push(request);
        requestsByBlock.set(request.blockNumber, blockRequests);
      }
      // Each chain lane has at most one in-flight RPC request.
      for (const blockRequests of requestsByBlock.values()) {
        throwIfAborted(input.signal);
        for (let offset = 0; offset < blockRequests.length; offset += CURVE_MULTICALL_BATCH_SIZE) {
          throwIfAborted(input.signal);
          const chunk = blockRequests.slice(offset, offset + CURVE_MULTICALL_BATCH_SIZE);
          const calls = chunk.map((request) => ({
            label: request.label,
            target: request.endpointAddress,
            callData: request.callData,
            allowFailure: true,
          }));
          const chunkResult = await executeAdaptiveChunk({
            chain: chunk[0]!.policy.chain,
            calls,
            blockNumber: chunk[0]!.blockNumber,
            chainRpcs: input.chainRpcs,
            signal: input.signal,
            rpcBudget: input.rpcBudget,
          });
          const byLabel = new Map(chunkResult.results.map((result) => [result.label, result]));
          for (const request of chunk) {
            const result = byLabel.get(request.label);
            const budgetFailure = chunkResult.budgetStopReasonsByLabel.get(request.label);
            const decoded = budgetFailure
              ? { failureReason: budgetFailure }
              : result == null
                ? { failureReason: "pool-revert" as const }
                : decodeCurveCryptoSwapQuotePoint(request, result);
            outcomes[request.index] = {
              targetId: request.target.targetId,
              inputUsd: request.inputUsd,
              blockNumber: request.blockNumber,
              eligibility: request.eligibility,
              ...decoded,
            };
          }
        }
      }
    });
    return outcomes;
  };
}

export const quoteCurveCryptoSwapRequests = createCurveCryptoSwapQuoteExecutor({
  executeMulticall: async (input) =>
    fetchEvmMulticall3Aggregate3AtBlock(input.chain, input.calls, input.blockNumber, {
      chainRpcs: input.chainRpcs,
      signal: input.signal,
      timeoutMs: DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
      maxRetries: 1,
      ...(input.rpcBudget ? { deadlineMs: input.rpcBudget.deadlineMs } : {}),
      ...(input.rpcBudget
        ? {
            beforeRequest: () => {
              const consumed = input.rpcBudget!.tryConsume();
              const reason = input.rpcBudget!.stopReason;
              if (!consumed && reason) input.onBudgetStop?.(reason);
              return consumed;
            },
          }
        : {}),
      gas: CURVE_MULTICALL_GAS,
      multicallBatchSize: Math.min(CURVE_MULTICALL_BATCH_SIZE, input.calls.length),
    }),
});

/** Exact ABI-bound validation; score eligibility is checked separately. */
export function validateCurveCryptoSwapProfileProof(profile: DexMeasuredExecutionProfile): string[] {
  const issues = new Set<string>();
  if (profile.adapterProfileId !== CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID) issues.add("wrong-adapter-profile");
  const endpointAddress = canonicalAddress(profile.executionEndpoint.address);
  const policy = endpointAddress == null ? null : getCurveCryptoSwapShadowPolicy(profile.chain, endpointAddress);
  if (policy == null) issues.add("execution-pool-not-in-cohort");
  // A pinned policy binds the exact pool bytecode. A family-anchored policy has
  // no pre-pinned pool hash (Curve NG bakes per-pool immutables into the
  // runtime code), so the profile must at least carry a readable one; its
  // factory/views/math triple is proven producer-side at the pinned block.
  else if (
    policy.identityAnchor === "pinned-pool-code"
      ? profile.executionEndpoint.codeHash !== policy.expectedPoolCodeHash
      : canonicalCodeHash(profile.executionEndpoint.codeHash) == null
  ) {
    issues.add("endpoint-code-hash-mismatch");
  }
  const indices = resolveCurveCryptoSwapTokenIndices(profile);
  if (!indices.ok) issues.add(indices.reason);

  for (const point of profile.quoteProof) {
    try {
      const decodedCall = decodeFunctionData({
        abi: CURVE_CRYPTOSWAP_ABI,
        data: point.callData as `0x${string}`,
      });
      if (decodedCall.functionName !== "get_dy") {
        issues.add("wrong-function-selector");
        continue;
      }
      const [inputIndex, outputIndex, amountInRaw] = decodedCall.args;
      if (
        !indices.ok ||
        inputIndex !== BigInt(indices.inputIndex) ||
        outputIndex !== BigInt(indices.outputIndex) ||
        amountInRaw.toString() !== point.amountInRaw
      )
        issues.add("call-data-mismatch");

      const amountOutRaw = decodeCurveCryptoSwapGetDy(point.returnData as `0x${string}`);
      if (amountOutRaw == null) issues.add("abi-decode-failed");
      else if (amountOutRaw.toString() !== point.amountOutRaw) issues.add("return-data-mismatch");
    } catch {
      issues.add("abi-decode-failed");
    }
  }
  return [...issues];
}

/**
 * Generic dispatcher surface. It intentionally refuses to publish shadow
 * points until the cohort policies become score-eligible.
 */
export const CURVE_CRYPTOSWAP_ADAPTER: DexMeasuredExecutionAdapter = {
  profileId: CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID,
  async quotePoints(input) {
    const eligibility = evaluateCurveCryptoSwapEligibility({
      chain: input.target.chain,
      endpointAddress: input.endpointAddress,
    });
    if (!eligibility.ok) {
      return {
        points: [],
        failures: input.inputNotionalsUsd.map((inputUsd) => ({
          inputUsd,
          reason: eligibility.reason,
        })),
      };
    }
    const outcomes = await quoteCurveCryptoSwapRequests({
      requests: input.inputNotionalsUsd.map((inputUsd) => ({
        target: input.target,
        inputUsd,
        blockNumber: input.blockNumber,
        endpointAddress: input.endpointAddress,
      })),
      chainRpcs: input.chainRpcs,
      signal: input.signal,
    });
    return {
      points: outcomes.flatMap((outcome) => (outcome.point && outcome.eligibility.ok ? [outcome.point] : [])),
      failures: outcomes.flatMap((outcome) => {
        const reason = outcome.failureReason ?? (outcome.eligibility.ok ? null : outcome.eligibility.reason);
        return reason == null ? [] : [{ inputUsd: outcome.inputUsd, reason }];
      }),
    };
  },
};

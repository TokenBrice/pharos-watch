import { keccak256 } from "viem/utils";

import type { ChainRpcConfig } from "../../lib/chain-registry";
import { fetchEvmCodeAtBlock } from "../../lib/evm-rpc";
import {
  DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
  type DexMeasuredExecutionRpcBudget,
} from "./profiles";

export interface DexMeasuredExecutionDeployment {
  adapterProfileId:
    | "uniswap-v3-quoter-v2"
    | "pancakeswap-v3-quoter-v2"
    | "aerodrome-slipstream-quoter-v2";
  protocol: "uniswap-v3" | "pancakeswap" | "aerodrome-slipstream";
  chain: "ethereum" | "arbitrum" | "base" | "polygon" | "bsc";
  endpointAddress: `0x${string}`;
  expectedCodeHash: `0x${string}`;
  factoryAddress: `0x${string}`;
  expectedFactoryCodeHash: `0x${string}`;
}

/**
 * Reviewed against the protocols' official deployment registries. Bytecode
 * hashes were pinned from the deployed runtime code and are checked again at
 * the exact quote block before an adapter can publish measured evidence.
 */
const DEX_MEASURED_EXECUTION_DEPLOYMENTS: readonly DexMeasuredExecutionDeployment[] = [
  {
    adapterProfileId: "uniswap-v3-quoter-v2",
    protocol: "uniswap-v3",
    chain: "ethereum",
    endpointAddress: "0x61ffe014ba17989e743c5f6cb21bf9697530b21e",
    expectedCodeHash: "0x06148f47d0f41a68d3bc970030a7150e5d608cfbc28d372440a2e41ce543d92b",
    factoryAddress: "0x1f98431c8ad98523631ae4a59f267346ea31f984",
    expectedFactoryCodeHash: "0x4d7b8525cd5d14343fa67a732fba5b24cddba11620ca88392f4ec6c52f91fd69",
  },
  {
    adapterProfileId: "uniswap-v3-quoter-v2",
    protocol: "uniswap-v3",
    chain: "arbitrum",
    endpointAddress: "0x61ffe014ba17989e743c5f6cb21bf9697530b21e",
    expectedCodeHash: "0xd8162b13ba57ce21a146063b10658bda0a3fd15c99f768c86283fce6640858a5",
    factoryAddress: "0x1f98431c8ad98523631ae4a59f267346ea31f984",
    expectedFactoryCodeHash: "0x4d7b8525cd5d14343fa67a732fba5b24cddba11620ca88392f4ec6c52f91fd69",
  },
  {
    adapterProfileId: "uniswap-v3-quoter-v2",
    protocol: "uniswap-v3",
    chain: "polygon",
    endpointAddress: "0x61ffe014ba17989e743c5f6cb21bf9697530b21e",
    expectedCodeHash: "0x67d7cce806743d638e191025ab4233f44e99469f1bcda4c2b4b964b8af9099d9",
    factoryAddress: "0x1f98431c8ad98523631ae4a59f267346ea31f984",
    expectedFactoryCodeHash: "0x4d7b8525cd5d14343fa67a732fba5b24cddba11620ca88392f4ec6c52f91fd69",
  },
  {
    adapterProfileId: "uniswap-v3-quoter-v2",
    protocol: "uniswap-v3",
    chain: "base",
    endpointAddress: "0x3d4e44eb1374240ce5f1b871ab261cd16335b76a",
    expectedCodeHash: "0xceb5b8bc35e09fc64b1c48c6b920e0d2e37d5710e4f3ef214e1a81f75acee51e",
    factoryAddress: "0x33128a8fc17869897dce68ed026d694621f6fdfd",
    expectedFactoryCodeHash: "0x95707a4ac71f20181a63ef7d180e3c625be5d20fc8f6f980befa966bad568132",
  },
  {
    adapterProfileId: "aerodrome-slipstream-quoter-v2",
    protocol: "aerodrome-slipstream",
    chain: "base",
    endpointAddress: "0x254cf9e1e6e233aa1ac962cb9b05b2cfeaae15b0",
    expectedCodeHash: "0xfb0ab713266d089d5b6ac48d50455c4fadc9cd49a1efcc83a091e7c2e48dad0e",
    factoryAddress: "0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a",
    expectedFactoryCodeHash: "0x7340cf80843bd721bcaefbfc050e38304cb4174c239e6e914e3056f27f39b11c",
  },
  {
    adapterProfileId: "pancakeswap-v3-quoter-v2",
    protocol: "pancakeswap",
    chain: "bsc",
    endpointAddress: "0xb048bbc1ee6b733fffcfb9e9cef7375518e25997",
    expectedCodeHash: "0x2734833b7d2a656d4797f4a7d959314654749a7424ec473267613ff26424138a",
    factoryAddress: "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865",
    expectedFactoryCodeHash: "0x8191d3ab1d55d3da9822199f28865415c99566b6f1aee4a4b16713f57930678c",
  },
  {
    adapterProfileId: "pancakeswap-v3-quoter-v2",
    protocol: "pancakeswap",
    chain: "ethereum",
    endpointAddress: "0xb048bbc1ee6b733fffcfb9e9cef7375518e25997",
    expectedCodeHash: "0x236f9c811f95d29670d777304ba6f074edc006c568917b48b33cd78abd736d7e",
    factoryAddress: "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865",
    expectedFactoryCodeHash: "0x8191d3ab1d55d3da9822199f28865415c99566b6f1aee4a4b16713f57930678c",
  },
  {
    adapterProfileId: "pancakeswap-v3-quoter-v2",
    protocol: "pancakeswap",
    chain: "base",
    endpointAddress: "0xb048bbc1ee6b733fffcfb9e9cef7375518e25997",
    expectedCodeHash: "0x945e158b4d4b58c41ade0a10f7e6df0a3c631468fcd762eced1b3fe38fe1f812",
    factoryAddress: "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865",
    expectedFactoryCodeHash: "0x8191d3ab1d55d3da9822199f28865415c99566b6f1aee4a4b16713f57930678c",
  },
] as const;

/**
 * Activation is cohort-scoped. The 2026-07-17 owner-ratified cohort is backed
 * by the fork-equivalence, cross-check, drift, and shadow evidence packet at
 * agents/safety-score-v9/results/cl-activation-evidence-2026-07-17/packet.md
 * (120/120 exact provider reproductions; failures confined to producer
 * startup generations). Base Aerodrome Slipstream was admitted to V9
 * route scoring on 2026-07-24 after full target rotation, consumer replay,
 * binding checks, and independent historical-block quote reproduction.
 * The retired Optimism Uniswap V3 lane is no longer scheduled for evidence
 * collection after its 2026-07-27 score-facing consumers exceeded the Worker
 * memory limit and the owner accepted clean retirement. Keys not listed here
 * remain shadow-only fail-closed when a reviewed deployment still exists. The
 * initial cohort was restored 2026-07-20 after the #592 security rollup
 * emptied it as an over-broad artifact.
 */
export const DEX_MEASURED_EXECUTION_SCORE_ELIGIBLE_DEPLOYMENT_KEYS: readonly string[] = [
  "aerodrome-slipstream-quoter-v2:base",
  "uniswap-v3-quoter-v2:ethereum",
  "uniswap-v3-quoter-v2:polygon",
  "uniswap-v3-quoter-v2:arbitrum",
  "pancakeswap-v3-quoter-v2:base",
  "pancakeswap-v3-quoter-v2:bsc",
  "pancakeswap-v3-quoter-v2:ethereum",
];

function deploymentKey(adapterProfileId: string, chain: string): string {
  return `${adapterProfileId.trim().toLowerCase()}:${chain.trim().toLowerCase()}`;
}

export function isDexMeasuredExecutionDeploymentScoreEligible(adapterProfileId: string, chain: string): boolean {
  return DEX_MEASURED_EXECUTION_SCORE_ELIGIBLE_DEPLOYMENT_KEYS.includes(deploymentKey(adapterProfileId, chain));
}

export function getDexMeasuredExecutionDeployment(
  adapterProfileId: string,
  chain: string,
): DexMeasuredExecutionDeployment | null {
  const normalizedChain = chain.trim().toLowerCase();
  return (
    DEX_MEASURED_EXECUTION_DEPLOYMENTS.find(
      (deployment) => deployment.adapterProfileId === adapterProfileId && deployment.chain === normalizedChain,
    ) ?? null
  );
}

export async function verifyDexMeasuredExecutionDeployment(input: {
  deployment: DexMeasuredExecutionDeployment;
  blockNumber: number;
  chainRpcs: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  rpcBudget?: DexMeasuredExecutionRpcBudget;
}): Promise<
  | { ok: true; codeHash: `0x${string}`; factoryCodeHash: `0x${string}` }
  | {
      ok: false;
      reason: "code-unavailable" | "code-hash-mismatch" | "factory-code-unavailable" | "factory-code-hash-mismatch";
    }
> {
  if (input.rpcBudget && !input.rpcBudget.canRequestChain(input.deployment.chain)) {
    return { ok: false, reason: "code-unavailable" };
  }
  const code = await fetchEvmCodeAtBlock(input.deployment.chain, input.deployment.endpointAddress, input.blockNumber, {
    chainRpcs: input.chainRpcs,
    signal: input.signal,
    timeoutMs: DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
    ...(input.rpcBudget ? { deadlineMs: input.rpcBudget.deadlineMs } : {}),
    ...(input.rpcBudget ? { beforeRequest: () => input.rpcBudget!.tryConsume() } : {}),
    maxRetries: 0,
  });
  input.rpcBudget?.recordChainResult(input.deployment.chain, code != null);
  if (code == null) return { ok: false, reason: "code-unavailable" };
  const codeHash = keccak256(code).toLowerCase() as `0x${string}`;
  if (codeHash !== input.deployment.expectedCodeHash) return { ok: false, reason: "code-hash-mismatch" };
  if (input.rpcBudget && !input.rpcBudget.canRequestChain(input.deployment.chain)) {
    return { ok: false, reason: "factory-code-unavailable" };
  }
  const factoryCode = await fetchEvmCodeAtBlock(
    input.deployment.chain,
    input.deployment.factoryAddress,
    input.blockNumber,
    {
      chainRpcs: input.chainRpcs,
      signal: input.signal,
      timeoutMs: DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
      ...(input.rpcBudget ? { deadlineMs: input.rpcBudget.deadlineMs } : {}),
      ...(input.rpcBudget ? { beforeRequest: () => input.rpcBudget!.tryConsume() } : {}),
      maxRetries: 0,
    },
  );
  input.rpcBudget?.recordChainResult(input.deployment.chain, factoryCode != null);
  if (factoryCode == null) return { ok: false, reason: "factory-code-unavailable" };
  const factoryCodeHash = keccak256(factoryCode).toLowerCase() as `0x${string}`;
  if (factoryCodeHash !== input.deployment.expectedFactoryCodeHash) {
    return { ok: false, reason: "factory-code-hash-mismatch" };
  }
  return { ok: true, codeHash, factoryCodeHash };
}

import { CHAIN_META, resolveChainId } from "@shared/lib/chains";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { rethrowIfAborted, throwIfAborted } from "./abort";
import type { ChainRpcConfig } from "./chain-registry";
import { fetchEvmBlockHeader, fetchEvmMulticall3Aggregate3AtBlock, resolveClosestBlockAtOrBeforeTimestamp } from "./evm-rpc";
import { DECIMALS_SELECTOR, TOTAL_SUPPLY_SELECTOR } from "./evm-selectors";
import { getPublicRpcUrl, getSecondaryFallbackRpcUrl } from "./public-rpc-registry";
import { normalizeReviewedDeploymentAddress, reviewedDeploymentIdentityValidationError, reviewedDeploymentObservationTimingIssue, type ReviewedDeploymentSupplyObservation } from "./safety-score-v9-supply-attribution-contract";
import { decodeEvmUint256 } from "./safety-score-v9-supply-observation-primitives";
import { SAFETY_SCORE_V9_TRANSFER_MATERIALITY_ASSET_IDS, createSafetyScoreV9TransferMaterialityGeneration, type SafetyScoreV9TransferMaterialityGeneration, type SafetyScoreV9TransferMaterialityObservation } from "./safety-score-v9-transfer-materiality";

interface ObserverDependencies {
  fetchEvmBlockHeader: typeof fetchEvmBlockHeader;
  fetchEvmMulticall3Aggregate3AtBlock: typeof fetchEvmMulticall3Aggregate3AtBlock;
  resolveClosestBlockAtOrBeforeTimestamp: typeof resolveClosestBlockAtOrBeforeTimestamp;
}

const DEFAULT_DEPENDENCIES: ObserverDependencies = {
  fetchEvmBlockHeader,
  fetchEvmMulticall3Aggregate3AtBlock,
  resolveClosestBlockAtOrBeforeTimestamp,
};

function rejected(deploymentKey: string): SafetyScoreV9TransferMaterialityObservation {
  return { deploymentKey, rawTokenUnits: null, decimals: null, blockNumber: null, observedAtSec: null, status: "rejected" };
}

/**
 * Observer-local public RPCs for reviewed transfer-materiality deployments
 * that are absent from the global `PUBLIC_RPC_URLS` map. Do not fold these
 * into reserve-adapter RPC resolution: they exist only so an already-wired
 * independent-liability packet can observe its long-tail legs.
 */
const TRANSFER_MATERIALITY_EXTRA_RPCS: Record<string, { rpcUrl: string; fallbackRpcUrl?: string }> = {
  fraxtal: { rpcUrl: "https://rpc.frax.com", fallbackRpcUrl: "https://fraxtal.drpc.org" },
  sei: { rpcUrl: "https://evm-rpc.sei-apis.com", fallbackRpcUrl: "https://sei-evm-rpc.publicnode.com" },
  mode: { rpcUrl: "https://mainnet.mode.network", fallbackRpcUrl: "https://mode.drpc.org" },
  xlayer: { rpcUrl: "https://rpc.xlayer.tech" },
  katana: { rpcUrl: "https://rpc.katana.network", fallbackRpcUrl: "https://rpc.katanarpc.com" },
  sonic: { rpcUrl: "https://rpc.soniclabs.com", fallbackRpcUrl: "https://sonic-rpc.publicnode.com" },
};

export function transferMaterialityObserverResolvesRpc(
  chainId: string,
  configured: Map<string, ChainRpcConfig> = new Map(),
): boolean {
  return rpcConfig(chainId, configured) !== null;
}

function rpcConfig(chainId: string, configured: Map<string, ChainRpcConfig>): Map<string, ChainRpcConfig> | null {
  if (configured.has(chainId)) return configured;
  const meta = CHAIN_META[chainId];
  const extra = TRANSFER_MATERIALITY_EXTRA_RPCS[chainId];
  const rpcUrl = extra?.rpcUrl ?? getPublicRpcUrl(chainId);
  if (!meta || meta.type !== "evm" || !rpcUrl) return null;
  return new Map(configured).set(chainId, {
    chainId,
    chainName: meta.name,
    type: "evm",
    rpcUrl,
    fallbackRpcUrl: extra?.fallbackRpcUrl ?? getSecondaryFallbackRpcUrl(chainId),
    explorerUrl: meta.explorerUrl,
  });
}

interface DeploymentTarget {
  assetId: string;
  chainId: string;
  address: string;
  expectedDecimals: number;
  deploymentKey: string;
}

async function observeChainDeployments(
  chainId: string,
  targets: readonly DeploymentTarget[],
  scoringClockSec: number,
  chainRpcs: Map<string, ChainRpcConfig>,
  dependencies: ObserverDependencies,
  signal?: AbortSignal,
): Promise<Map<string, SafetyScoreV9TransferMaterialityObservation>> {
  const rejectedRows = () => new Map(targets.map((target) => [target.deploymentKey, rejected(target.deploymentKey)]));
  const resolvedRpcs = rpcConfig(chainId, chainRpcs);
  if (!resolvedRpcs) return rejectedRows();
  try {
    const options = { chainRpcs: resolvedRpcs, signal };
    const blockNumber = await dependencies.resolveClosestBlockAtOrBeforeTimestamp(
      chainId,
      scoringClockSec,
      { blockTimestampByNumber: new Map() },
      options,
    );
    if (blockNumber === null) return rejectedRows();
    const header = await dependencies.fetchEvmBlockHeader(chainId, blockNumber, options);
    if (!header || header.timestamp > scoringClockSec) return rejectedRows();
    const calls = targets.flatMap((target) => [
      { label: `${target.deploymentKey}:total-supply`, target: target.address, callData: TOTAL_SUPPLY_SELECTOR, allowFailure: true },
      { label: `${target.deploymentKey}:decimals`, target: target.address, callData: DECIMALS_SELECTOR, allowFailure: true },
    ]);
    const results = await dependencies.fetchEvmMulticall3Aggregate3AtBlock(chainId, calls, blockNumber, options);
    if (!results || results.length !== calls.length) return rejectedRows();
    const rows = new Map<string, SafetyScoreV9TransferMaterialityObservation>();
    for (const [index, target] of targets.entries()) {
      const rawSupply = decodeEvmUint256(results[index * 2]);
      const decimals = decodeEvmUint256(results[index * 2 + 1]);
      if (rawSupply === null || decimals === null || decimals > 255n || Number(decimals) !== target.expectedDecimals) {
        rows.set(target.deploymentKey, rejected(target.deploymentKey));
        continue;
      }
      const identityRow: ReviewedDeploymentSupplyObservation = {
        routeId: target.deploymentKey,
        chainId,
        contractAddress: normalizeReviewedDeploymentAddress(chainId, target.address),
        decimals: Number(decimals),
        rawSupply: rawSupply.toString(),
        blockNumberOrSlot: blockNumber.toString(),
        blockTimeSec: header.timestamp,
        blockHash: header.hash,
      };
      if (reviewedDeploymentIdentityValidationError(identityRow, target.assetId, { chainId, contractAddress: target.address }) !== null || reviewedDeploymentObservationTimingIssue({
        clockSec: scoringClockSec,
        captureStartedAtSec: header.timestamp,
        captureEndedAtSec: header.timestamp,
        observedAtSec: header.timestamp,
        deployments: [identityRow],
      }) !== null) {
        rows.set(target.deploymentKey, rejected(target.deploymentKey));
        continue;
      }
      rows.set(target.deploymentKey, {
        deploymentKey: target.deploymentKey,
        rawTokenUnits: rawSupply.toString(),
        decimals: Number(decimals),
        blockNumber: blockNumber.toString(),
        observedAtSec: header.timestamp,
        status: "accepted",
      });
    }
    return rows;
  } catch (error) {
    rethrowIfAborted(error, signal);
    return rejectedRows();
  }
}

export async function observeSafetyScoreV9TransferMaterialityGeneration(input: {
  activeAssetIds: readonly string[];
  baseInputGenerationId: string;
  registryFingerprint: string;
  scoringClockSec: number;
  chainRpcs: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
}, dependencyOverrides: Partial<ObserverDependencies> = {}): Promise<SafetyScoreV9TransferMaterialityGeneration> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const active = new Set(input.activeAssetIds);
  const observationsByAssetId: Record<string, SafetyScoreV9TransferMaterialityObservation[]> = {};
  const targetsByChainId = new Map<string, DeploymentTarget[]>();
  for (const assetId of SAFETY_SCORE_V9_TRANSFER_MATERIALITY_ASSET_IDS) {
    if (!active.has(assetId)) continue;
    throwIfAborted(input.signal);
    const meta = ACTIVE_META_BY_ID.get(assetId);
    const rows: SafetyScoreV9TransferMaterialityObservation[] = [];
    for (const deployment of meta?.contracts ?? []) {
      const chainId = resolveChainId(deployment.chain);
      if (chainId === null || CHAIN_META[chainId]?.type !== "evm") {
        rows.push(rejected(`${deployment.chain}:${deployment.address.toLowerCase()}`));
        continue;
      }
      const deploymentKey = `${chainId}:${normalizeReviewedDeploymentAddress(chainId, deployment.address)}`;
      targetsByChainId.set(chainId, [
        ...(targetsByChainId.get(chainId) ?? []),
        { assetId, chainId, address: deployment.address, expectedDecimals: deployment.decimals, deploymentKey },
      ]);
    }
    observationsByAssetId[assetId] = rows;
  }
  const chainTargets = [...targetsByChainId.entries()];
  for (let offset = 0; offset < chainTargets.length; offset += 3) {
    throwIfAborted(input.signal);
    const batch = chainTargets.slice(offset, offset + 3);
    const batchResults = await Promise.all(batch.map(async ([chainId, targets]) => ({
      targets,
      observed: await observeChainDeployments(chainId, targets, input.scoringClockSec, input.chainRpcs, dependencies, input.signal),
    })));
    for (const { targets, observed } of batchResults) {
      for (const target of targets) observationsByAssetId[target.assetId]!.push(observed.get(target.deploymentKey)!);
    }
  }
  return createSafetyScoreV9TransferMaterialityGeneration({
    schemaVersion: 1,
    kind: "safety-score-v9-transfer-materiality-generation",
    sourceBaseInputGenerationId: input.baseInputGenerationId,
    registryFingerprint: input.registryFingerprint,
    capturedAtSec: input.scoringClockSec,
    observationsByAssetId,
  });
}

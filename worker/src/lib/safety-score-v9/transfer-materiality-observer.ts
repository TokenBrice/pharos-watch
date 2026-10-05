import { CHAIN_META, resolveChainId } from "@shared/types/chain-identity";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { SUPPLY_RPC_DEFAULTS } from "@shared/lib/chain-rpc-registry";
import { rethrowIfAborted, throwIfAborted } from "../abort";
import { hasRegistryRpc, supplementalRpcEndpoints, registryRpcUrls, type ChainRpcConfig, type RpcEndpoint } from "../chain-registry";
import { fetchEvmBlockHeader, fetchEvmMulticall3Aggregate3AtBlock, resolveClosestBlockAtOrBeforeTimestamp } from "../evm-rpc";
import { DECIMALS_SELECTOR, TOTAL_SUPPLY_SELECTOR } from "../evm-selectors";
import { getPublicRpcUrl, getSecondaryFallbackRpcUrl } from "../public-rpc-registry";
import { normalizeReviewedDeploymentAddress, reviewedDeploymentIdentityValidationError, reviewedDeploymentObservationTimingIssue, type ReviewedDeploymentSupplyObservation } from "./supply-attribution-contract";
import { decodeEvmUint256 } from "./supply-observation-primitives";
import { SAFETY_SCORE_V9_TRANSFER_MATERIALITY_ASSET_IDS, createSafetyScoreV9TransferMaterialityGeneration, type SafetyScoreV9TransferMaterialityGeneration, type SafetyScoreV9TransferMaterialityObservation } from "./transfer-materiality";
import { isFixedDecimalDeployment } from "@shared/lib/deployment-amounts";
import { observeEconomicSolanaMint } from "./economic-supply-observer";
import { fetchMoveFungibleAssetSupply } from "../../cron/reserve-adapters/token-supply";
import { REVIEWED_PROVIDER_CHAIN_PARTITIONS, REVIEWED_ECONOMIC_SUPPLY_PLANS, REVIEWED_SUPPLY_ATTRIBUTION_ENVELOPE } from "./supply-attribution-contract";
import { ReviewedRegistryEntryError } from "./extension-reviewed-registry";

interface ObserverDependencies {
  fetchEvmBlockHeader: typeof fetchEvmBlockHeader;
  fetchEvmMulticall3Aggregate3AtBlock: typeof fetchEvmMulticall3Aggregate3AtBlock;
  resolveClosestBlockAtOrBeforeTimestamp: typeof resolveClosestBlockAtOrBeforeTimestamp;
  observeEconomicSolanaMint: typeof observeEconomicSolanaMint;
  fetchMoveFungibleAssetSupply: typeof fetchMoveFungibleAssetSupply;
}

const DEFAULT_DEPENDENCIES: ObserverDependencies = {
  fetchEvmBlockHeader,
  fetchEvmMulticall3Aggregate3AtBlock,
  resolveClosestBlockAtOrBeforeTimestamp,
  observeEconomicSolanaMint,
  fetchMoveFungibleAssetSupply,
};

function rejected(deploymentKey: string): SafetyScoreV9TransferMaterialityObservation {
  return { deploymentKey, rawTokenUnits: null, decimals: null, blockNumber: null, observedAtSec: null, status: "rejected" };
}

/**
 * Observer-local public RPCs for reviewed transfer-materiality deployments
 * that are absent from the global `PUBLIC_RPC_URLS` map. Do not fold these
 * into reserve-adapter RPC resolution: they exist only so an already-wired
 * independent-liability packet can observe its long-tail legs.
 * Added endpoints passed numbered totalSupply/decimals probes on 2026-10-05.
 * This proves historical read capability, not freshness of a stopped ledger.
 */
const TRANSFER_MATERIALITY_EXTRA_RPCS: Record<string, { rpcUrl: string; fallbackRpcUrl?: string }> = {
  fraxtal: { rpcUrl: "https://rpc.frax.com", fallbackRpcUrl: "https://fraxtal.drpc.org" },
  sei: { rpcUrl: "https://evm-rpc.sei-apis.com", fallbackRpcUrl: "https://sei-evm-rpc.publicnode.com" },
  mode: { rpcUrl: "https://mainnet.mode.network", fallbackRpcUrl: "https://mode.drpc.org" },
  xlayer: { rpcUrl: "https://rpc.xlayer.tech" },
  katana: { rpcUrl: "https://rpc.katana.network", fallbackRpcUrl: "https://rpc.katanarpc.com" },
  sonic: { rpcUrl: "https://rpc.soniclabs.com", fallbackRpcUrl: "https://sonic-rpc.publicnode.com" },
  aurora: { rpcUrl: "https://mainnet.aurora.dev" },
  "polygon-zkevm": { rpcUrl: "https://zkevm-rpc.com" },
  pharos: { rpcUrl: "https://api.zan.top/public/pharos-mainnet" },
  berachain: SUPPLY_RPC_DEFAULTS.berachain,
  hyperevm: SUPPLY_RPC_DEFAULTS.hyperevm,
  ink: SUPPLY_RPC_DEFAULTS.ink,
  linea: { rpcUrl: SUPPLY_RPC_DEFAULTS.linea.rpcUrl },
  scroll: SUPPLY_RPC_DEFAULTS.scroll,
  zksync: SUPPLY_RPC_DEFAULTS.zksync,
  abstract: { rpcUrl: "https://api.mainnet.abs.xyz" },
  unichain: SUPPLY_RPC_DEFAULTS.unichain,
  worldchain: SUPPLY_RPC_DEFAULTS.worldchain,
  megaeth: SUPPLY_RPC_DEFAULTS.megaeth,
};

export function transferMaterialityObserverResolvesRpc(
  chainId: string,
  configured: Map<string, ChainRpcConfig> = new Map(),
): boolean {
  return rpcConfig(chainId, configured) !== null;
}

/** Registry endpoint shape for the observer-local public RPCs: keyless, full history. */
function publicRegistryEndpoints(...urls: readonly (string | undefined)[]): RpcEndpoint[] {
  return urls
    .filter((url): url is string => typeof url === "string" && url.length > 0)
    .map((url): RpcEndpoint => ({
      url,
      operator: "public",
      keyed: false,
      position: "registry",
      stateHistory: "archive",
      logsHistory: "full",
    }));
}

function rpcConfig(chainId: string, configured: Map<string, ChainRpcConfig>): Map<string, ChainRpcConfig> | null {
  // Archive supplemental-only configs are usable by the state-read lane.
  // Do not discard their credentials or upgrade near-head endpoints to archive.
  if (hasRegistryRpc(configured.get(chainId)) ||
      supplementalRpcEndpoints(configured.get(chainId), { historicalBlock: true }).length > 0) return configured;
  const meta = CHAIN_META[chainId];
  const extra = TRANSFER_MATERIALITY_EXTRA_RPCS[chainId];
  const rpcUrl = extra?.rpcUrl ?? getPublicRpcUrl(chainId);
  if (!meta || meta.type !== "evm" || !rpcUrl) return null;
  return new Map(configured).set(chainId, {
    chainId,
    chainName: meta.name,
    type: "evm",
    endpoints: [
      ...publicRegistryEndpoints(rpcUrl, extra?.fallbackRpcUrl ?? getSecondaryFallbackRpcUrl(chainId)),
      ...(configured.get(chainId)?.endpoints ?? []),
    ],
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
  if (chainId === "solana") {
    const rows = rejectedRows();
    for (const target of targets) {
      try {
        const mint = await dependencies.observeEconomicSolanaMint({
          address: target.address, decimals: target.expectedDecimals, clockSec: scoringClockSec, chainRpcs, signal,
        });
        if (mint) rows.set(target.deploymentKey, {
          deploymentKey: target.deploymentKey, rawTokenUnits: mint.amount, decimals: target.expectedDecimals,
          blockNumber: mint.slot.split(":")[0]!, observedAtSec: mint.observedAtSec, status: "accepted",
        });
      } catch (error) { rethrowIfAborted(error, signal); }
    }
    return rows;
  }
  if (chainId === "aptos" || chainId === "movement") {
    const rows = rejectedRows();
    const urls = [...new Set([
      ...registryRpcUrls(chainRpcs.get(chainId)),
      getPublicRpcUrl(chainId),
    ].filter((url): url is string => typeof url === "string" && url.length > 0))];
    for (const target of targets) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(target.address)) continue;
      for (const url of urls) {
        try {
          const supply = await dependencies.fetchMoveFungibleAssetSupply(
            target.address, signal ?? new AbortController().signal, url, undefined, {
              clockSec: scoringClockSec, expectedChainId: chainId === "aptos" ? 1 : 126,
              identityKind: target.assetId === "sfrxusd-frax" ? "oft-package" : "metadata-address",
            },
          );
          if (!supply || supply.decimals !== target.expectedDecimals || supply.ledgerTimestampSec === undefined ||
              !/^(0|[1-9][0-9]*)$/.test(supply.ledgerVersion) || supply.rawSupply < 0n ||
              supply.ledgerTimestampSec > scoringClockSec || reviewedDeploymentObservationTimingIssue({
                clockSec: scoringClockSec, captureStartedAtSec: supply.ledgerTimestampSec,
                captureEndedAtSec: supply.ledgerTimestampSec, observedAtSec: supply.ledgerTimestampSec,
                deployments: [{ routeId: target.deploymentKey, blockTimeSec: supply.ledgerTimestampSec }],
              }) !== null) continue;
          rows.set(target.deploymentKey, {
            deploymentKey: target.deploymentKey, rawTokenUnits: supply.rawSupply.toString(),
            decimals: supply.decimals, blockNumber: supply.ledgerVersion,
            observedAtSec: supply.ledgerTimestampSec, status: "accepted",
          });
          break;
        } catch (error) { rethrowIfAborted(error, signal); }
      }
    }
    return rows;
  }
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
    let results = await dependencies.fetchEvmMulticall3Aggregate3AtBlock(chainId, calls, blockNumber, options);
    if (results === null) {
      // A failed aggregate is not zero. The existing fallback reads directly
      // only after proving Multicall3 absent, and authenticates the block hash.
      results = await dependencies.fetchEvmMulticall3Aggregate3AtBlock(chainId, calls, blockNumber, {
        ...options, multicallFallbackBlockHash: header.hash,
      });
    }
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
        blockHash: header.hash,
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
    // Chain-local censuses must not trigger an 88-contract whole-asset probe
    // or be mistaken for complete transfer-materiality coverage.
    let chainScope: string[] | null = null;
    if (!REVIEWED_ECONOMIC_SUPPLY_PLANS.has(assetId) &&
      !REVIEWED_SUPPLY_ATTRIBUTION_ENVELOPE.independentLiabilityAssetIds.includes(assetId)) {
      try {
        const reviews = REVIEWED_PROVIDER_CHAIN_PARTITIONS.getAll(assetId);
        if (reviews.length > 0) {
          const currentReviews = reviews.filter(review =>
            review.reviewedAtSec <= input.scoringClockSec && input.scoringClockSec < review.expiresAtSec);
          chainScope = currentReviews.map(review => review.chainId);
          const reviewedKeys = currentReviews.flatMap(review => review.deployments.map(row => row.routeId));
          const catalogKeys = (meta?.contracts ?? []).filter(deployment => chainScope!.includes(resolveChainId(deployment.chain) ?? "")).map(deployment =>
            `${resolveChainId(deployment.chain)}:${normalizeReviewedDeploymentAddress(resolveChainId(deployment.chain)!, deployment.address)}`);
          if (catalogKeys.length !== reviewedKeys.length || new Set(catalogKeys).size !== catalogKeys.length ||
            reviewedKeys.some(key => !catalogKeys.includes(key))) {
            observationsByAssetId[assetId] = reviewedKeys.map(rejected);
            continue;
          }
        }
      } catch (error) {
        if (!(error instanceof ReviewedRegistryEntryError)) throw error;
        observationsByAssetId[assetId] = rows;
        continue;
      }
    }
    for (const deployment of meta?.contracts ?? []) {
      const chainId = resolveChainId(deployment.chain);
      if (chainScope !== null && (chainId === null || !chainScope.includes(chainId))) continue;
      if (chainId === null || !isFixedDecimalDeployment(deployment) ||
        (CHAIN_META[chainId]?.type !== "evm" && chainId !== "solana" && chainId !== "aptos" && chainId !== "movement")) {
        rows.push(rejected(`${deployment.chain}:${normalizeReviewedDeploymentAddress(chainId ?? deployment.chain, deployment.address)}`));
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
  // Finalized Solana account snapshots cannot be rewound. Capture them before
  // the bounded historical-capable EVM/Move tasks, while finality is still
  // behind the scoring clock; their actual block timestamps remain mandatory.
  const chainTargets = [...targetsByChainId.entries()].sort(([left], [right]) =>
    left === "solana" ? -1 : right === "solana" ? 1 : 0);
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

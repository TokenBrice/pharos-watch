import type { sha256HexFromBytes } from "@shared/lib/sha256";
import { throwIfAborted } from "./abort";
import {
  getAlchemyAuthHeaders,
  type ChainRpcConfig,
} from "./chain-registry";
import type {
  EvmBlockHeader,
  EvmMulticall3Call,
  EvmMulticall3Result,
  fetchEvmBlockHeader,
  fetchEvmBlockNumber,
  fetchEvmCodeAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  fetchEvmStorageAtBlock,
} from "./evm-rpc";
import { DECIMALS_SELECTOR, TOTAL_SUPPLY_SELECTOR } from "./evm-selectors";
import { fetchJsonWithRetry } from "./fetch-retry";
import {
  buildReviewedDeploymentRouteInventory,
  deriveReviewedDeploymentUnitPartition,
  normalizeReviewedDeploymentAddress,
  reviewedDeploymentObservationTimingIssue,
  type ReviewedDeploymentSupplyObservation,
  type ReviewedDeploymentUnitPartitionV1,
} from "./safety-score-v9-supply-attribution-contract";

const REVIEWED_DEPLOYMENT_MAX_SCORING_CLOCK_REWIND_BLOCKS = 128;
const REVIEWED_DEPLOYMENT_SOLANA_BLOCK_ANCHOR_LOOKBACK_SLOTS = 64;
const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

export type ReviewedDeploymentObservationRejectionCode =
  | "route-inventory-unavailable"
  | "deployment-identity-unavailable"
  | "chain-rpc-unavailable"
  | "safe-block-unavailable"
  | "deployment-state-unavailable"
  | "deployment-state-invalid"
  | "deployment-identity-mismatch"
  | "deployment-observation-skew"
  | "packet-reconciliation-failed";

export type ReviewedDeploymentObservationAttempt =
  | { status: "accepted"; attribution: ReviewedDeploymentUnitPartitionV1 }
  | {
      status: "rejected";
      rejectionCode: ReviewedDeploymentObservationRejectionCode;
      failedRouteId: string | null;
    };

export type ReviewedDeploymentObservationResult =
  | { status: "accepted"; observation: ReviewedDeploymentSupplyObservation }
  | {
      status: "rejected";
      rejectionCode: ReviewedDeploymentObservationRejectionCode;
      failedRouteId: string;
    };

export interface ReviewedDeploymentEvmObserverDependencies {
  sha256HexFromBytes: typeof sha256HexFromBytes;
  fetchEvmBlockNumber: typeof fetchEvmBlockNumber;
  fetchEvmBlockHeader: typeof fetchEvmBlockHeader;
  fetchEvmCodeAtBlock: typeof fetchEvmCodeAtBlock;
  fetchEvmMulticall3Aggregate3AtBlock: typeof fetchEvmMulticall3Aggregate3AtBlock;
  fetchEvmStorageAtBlock: typeof fetchEvmStorageAtBlock;
}

type ReviewedDeploymentEvmProtocolResult =
  | { status: "accepted"; implementationAddress?: string; observation: Partial<ReviewedDeploymentSupplyObservation> }
  | { status: "rejected"; rejectionCode: "deployment-state-unavailable" | "deployment-state-invalid" };

export async function observeReviewedEvmDeployment<Identity>(input: {
  routeId: string; chainId: string; contractAddress: string; scoringClockSec: number;
  chainRpcs: Map<string, ChainRpcConfig>; dependencies: ReviewedDeploymentEvmObserverDependencies;
  signal?: AbortSignal;
  identity: (routeId: string) => Identity | undefined;
  safeBlockLag: (identity: Identity, chainId: string) => number;
  extraRpcUrls: (identity: Identity, chainId: string) => readonly string[] | undefined;
  protocolCalls: (identity: Identity) => readonly EvmMulticall3Call[];
  decodeProtocolObservation: (context: { identity: Identity; results: EvmMulticall3Result[];
    implementationSlot: `0x${string}` }) => ReviewedDeploymentEvmProtocolResult;
  identityValidationError: (observation: ReviewedDeploymentSupplyObservation) => string | null;
}): Promise<ReviewedDeploymentObservationResult> {
  const { routeId, chainId, contractAddress, chainRpcs, dependencies, signal } = input;
  const rejectDeployment = (
    rejectionCode: ReviewedDeploymentObservationRejectionCode,
  ): ReviewedDeploymentObservationResult => ({
    status: "rejected",
    rejectionCode,
    failedRouteId: routeId,
  });
  const identity = input.identity(routeId);
  if (!identity) return rejectDeployment("deployment-identity-unavailable");

  const extraRpcUrls = input.extraRpcUrls(identity, chainId);
  if (!chainRpcs.has(chainId) && (extraRpcUrls?.length ?? 0) === 0) {
    return rejectDeployment("chain-rpc-unavailable");
  }
  const options = safetyScoreV9EvmObservationOptions({ chainRpcs,
    ...(extraRpcUrls ? { extraRpcUrls } : {}), signal });
  const headBlockNumber = await dependencies.fetchEvmBlockNumber(chainId, options);
  const safetyLag = input.safeBlockLag(identity, chainId);
  if (headBlockNumber === null || !Number.isSafeInteger(safetyLag) ||
      safetyLag <= 0 || headBlockNumber < safetyLag) {
    return rejectDeployment("safe-block-unavailable");
  }

  const blockHeader = await rewindEvmBlockHeaderToScoringClock({
    initialBlockNumber: headBlockNumber - safetyLag,
    scoringClockSec: input.scoringClockSec,
    signal,
    fetchHeader: (blockNumber) => dependencies.fetchEvmBlockHeader(chainId, blockNumber, options),
  });
  if (blockHeader === null) return rejectDeployment("safe-block-unavailable");
  const blockNumber = blockHeader.number;
  const calls = [
    { label: "total-supply", target: contractAddress, callData: TOTAL_SUPPLY_SELECTOR, allowFailure: false },
    { label: "decimals", target: contractAddress, callData: DECIMALS_SELECTOR, allowFailure: false },
    ...input.protocolCalls(identity),
  ];
  const [results, runtimeCode, implementationSlot] = await Promise.all([
    dependencies.fetchEvmMulticall3Aggregate3AtBlock(chainId, calls, blockNumber, options),
    dependencies.fetchEvmCodeAtBlock(chainId, contractAddress, blockNumber, options),
    dependencies.fetchEvmStorageAtBlock(chainId, contractAddress,
      EIP1967_IMPLEMENTATION_SLOT, blockNumber, options),
  ]);
  if (!results || results.length !== calls.length || !runtimeCode || !implementationSlot) {
    return rejectDeployment("deployment-state-unavailable");
  }

  const totalSupplyRaw = decodeEvmUint256(results[0]);
  const decimalsRaw = decodeEvmUint256(results[1]);
  const runtimeBytes = decodeEvmHexBytes(runtimeCode);
  if (totalSupplyRaw === null || decimalsRaw === null ||
      decimalsRaw > 36n || runtimeBytes === null) {
    return rejectDeployment("deployment-state-invalid");
  }
  const protocolResult = input.decodeProtocolObservation({
    identity,
    results,
    implementationSlot,
  });
  if (protocolResult.status === "rejected") return rejectDeployment(protocolResult.rejectionCode);
  const implementationBytes = protocolResult.implementationAddress
    ? decodeEvmHexBytes(await dependencies.fetchEvmCodeAtBlock(
        chainId,
        protocolResult.implementationAddress,
        blockNumber,
        options,
      ) ?? "")
    : null;
  if (protocolResult.implementationAddress && implementationBytes === null) {
    return rejectDeployment("deployment-state-unavailable");
  }

  const observation: ReviewedDeploymentSupplyObservation = {
    routeId,
    chainId,
    contractAddress: normalizeReviewedDeploymentAddress(chainId, contractAddress),
    decimals: Number(decimalsRaw),
    rawSupply: totalSupplyRaw.toString(),
    blockNumberOrSlot: blockNumber.toString(),
    blockTimeSec: blockHeader.timestamp,
    blockHash: blockHeader.hash,
    runtimeCodeSha256: dependencies.sha256HexFromBytes(runtimeBytes),
    ...(protocolResult.implementationAddress && implementationBytes
      ? {
          implementationAddress: protocolResult.implementationAddress,
          implementationCodeSha256: dependencies.sha256HexFromBytes(implementationBytes),
        }
      : {}),
    ...protocolResult.observation,
  };
  return input.identityValidationError(observation) === null
    ? { status: "accepted", observation }
    : rejectDeployment("deployment-identity-mismatch");
}

export async function rewindEvmBlockHeaderToScoringClock(input: {
  initialBlockNumber?: number;
  initialHeader?: EvmBlockHeader;
  scoringClockSec: number;
  fetchHeader: (blockNumber: number) => Promise<EvmBlockHeader | null>;
  signal?: AbortSignal;
  maxRewindBlocks?: number;
}): Promise<EvmBlockHeader | null> {
  let blockNumber = input.initialHeader?.number ?? input.initialBlockNumber ?? -1;
  let header = input.initialHeader ?? null;
  const maxRewindBlocks = input.maxRewindBlocks
    ?? REVIEWED_DEPLOYMENT_MAX_SCORING_CLOCK_REWIND_BLOCKS;
  for (let rewind = 0; rewind <= maxRewindBlocks && blockNumber >= 0; rewind += 1) {
    throwIfAborted(input.signal);
    header ??= await input.fetchHeader(blockNumber);
    if (header === null) return null;
    if (header.timestamp <= input.scoringClockSec) return header;
    blockNumber -= 1;
    header = null;
  }
  return null;
}

export async function observeReviewedDeploymentUnitPartitionAttempt(input: {
  assetId: string;
  aggregateSupplyUsd: number;
  registryFingerprint: string;
  scoringClockSec: number;
  signal?: AbortSignal;
  identityRuntime: (routeId: string) => "evm" | "solana" | null;
  observeEvm: (route: {
    routeId: string;
    chainId: string;
    contractAddress: string;
  }) => Promise<ReviewedDeploymentObservationResult>;
  observeSolana: (route: {
    routeId: string;
    chainId: string;
    contractAddress: string;
  }) => Promise<ReviewedDeploymentSupplyObservation | null>;
  identityValidationError: (observation: ReviewedDeploymentSupplyObservation) => string | null;
}): Promise<ReviewedDeploymentObservationAttempt> {
  const inventory = buildReviewedDeploymentRouteInventory(input.assetId);
  if (!inventory) {
    return { status: "rejected", rejectionCode: "route-inventory-unavailable", failedRouteId: null };
  }

  const observations: ReviewedDeploymentSupplyObservation[] = [];
  for (const route of inventory.routes) {
    throwIfAborted(input.signal);
    const runtime = input.identityRuntime(route.routeId);
    if (!runtime) {
      return {
        status: "rejected",
        rejectionCode: "deployment-identity-unavailable",
        failedRouteId: route.routeId,
      };
    }
    const result = runtime === "evm"
      ? await input.observeEvm(route)
      : await input.observeSolana(route).then<ReviewedDeploymentObservationResult>((observation) => observation
          ? { status: "accepted", observation }
          : {
              status: "rejected",
              rejectionCode: "deployment-state-unavailable",
              failedRouteId: route.routeId,
            });
    if (result.status === "rejected") return result;
    if (input.identityValidationError(result.observation)) {
      return {
        status: "rejected",
        rejectionCode: "deployment-identity-mismatch",
        failedRouteId: route.routeId,
      };
    }
    observations.push(result.observation);
  }

  const blockTimes = observations.map((observation) => observation.blockTimeSec);
  const captureStartedAtSec = Math.min(...blockTimes);
  const captureEndedAtSec = Math.max(...blockTimes);
  const timingIssue = reviewedDeploymentObservationTimingIssue({
    assetId: input.assetId,
    clockSec: input.scoringClockSec,
    captureStartedAtSec,
    captureEndedAtSec,
    observedAtSec: captureEndedAtSec,
    deployments: observations,
  });
  if (timingIssue) {
    return {
      status: "rejected",
      rejectionCode: "deployment-observation-skew",
      failedRouteId: timingIssue.failedRouteId,
    };
  }

  const attribution = deriveReviewedDeploymentUnitPartition({
    assetId: input.assetId,
    aggregateSupplyUsd: input.aggregateSupplyUsd,
    registryFingerprint: input.registryFingerprint,
    scoringClockSec: input.scoringClockSec,
    observations,
  });
  return attribution
    ? { status: "accepted", attribution }
    : { status: "rejected", rejectionCode: "packet-reconciliation-failed", failedRouteId: null };
}

const SOLANA_RPC_URLS = [
  "https://api.mainnet-beta.solana.com",
  "https://api.mainnet.solana.com",
  "https://solana.api.pocket.network",
  "https://solana-rpc.publicnode.com",
] as const;

interface SolanaRpcEnvelope<T> {
  result?: T;
  error?: { code?: number; message?: string };
}

interface SolanaMintAccountValue {
  owner?: string;
  data?: {
    parsed?: {
      info?: {
        decimals?: number;
        supply?: string;
        mintAuthority?: string | null;
      };
    };
  };
}

interface SolanaControllerAccountValue {
  owner?: string;
  executable?: boolean;
}

interface SolanaMultipleAccountsResult {
  context?: { slot?: number };
  value?: [
    SolanaMintAccountValue | null,
    SolanaControllerAccountValue | null,
  ];
}

interface SolanaBlockResult {
  blockhash?: string;
  blockTime?: number | null;
}

export interface ReviewedDeploymentSolanaIdentity {
  programOwner: string;
  mintAuthority: string;
  controllerAddress: string;
  controllerProgramOwner: string;
  controllerExecutable: boolean;
}

export type SafetyScoreV9SolanaRpcFetcher = <T>(
  method: string,
  params: unknown[],
  signal?: AbortSignal,
) => Promise<T | null>;

export function decodeEvmUint256(
  result: EvmMulticall3Result | undefined,
): bigint | null {
  if (!result?.success || !/^0x[0-9a-fA-F]{64}$/.test(result.returnData)) {
    return null;
  }
  return BigInt(result.returnData);
}

export function decodeEvmAddressHex(
  value: string | undefined,
): string | null {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  const address = `0x${value.slice(-40).toLowerCase()}`;
  return /^0x[0-9a-f]{40}$/.test(address) &&
    address !== "0x0000000000000000000000000000000000000000"
    ? address
    : null;
}

export function decodeEvmAddress(
  result: EvmMulticall3Result | undefined,
): string | null {
  return result?.success
    ? decodeEvmAddressHex(result.returnData)
    : null;
}

export function decodeEvmHexBytes(value: string): Uint8Array | null {
  const body = value.startsWith("0x") ? value.slice(2) : value;
  if (
    body.length === 0 ||
    body.length % 2 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(body)
  ) {
    return null;
  }
  const bytes = new Uint8Array(body.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(
      body.slice(index * 2, index * 2 + 2),
      16,
    );
  }
  return bytes;
}

export function safetyScoreV9EvmObservationOptions(input: {
  chainRpcs: Map<string, ChainRpcConfig>;
  extraRpcUrls?: readonly string[];
  signal?: AbortSignal;
}) {
  return {
    chainRpcs: input.chainRpcs,
    ...(input.extraRpcUrls
      ? { extraRpcUrls: [...input.extraRpcUrls] }
      : {}),
    signal: input.signal,
    timeoutMs: 10_000,
    maxRetries: 1,
  };
}

export async function fetchSafetyScoreV9SolanaRpc<T>(
  method: string,
  params: unknown[],
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<T | null> {
  const configured = chainRpcs?.get("solana");
  const rpcUrls = [
    configured?.rpcUrl,
    configured?.fallbackRpcUrl,
    ...SOLANA_RPC_URLS,
  ].filter((rpcUrl, index, values): rpcUrl is string =>
    typeof rpcUrl === "string" && values.indexOf(rpcUrl) === index,
  );
  for (const rpcUrl of rpcUrls) {
    throwIfAborted(signal);
    const result = await fetchJsonWithRetry<SolanaRpcEnvelope<T>>(
      rpcUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getAlchemyAuthHeaders(rpcUrl),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal,
      },
      1,
      { timeoutMs: 10_000, maxResponseBytes: 128_000 },
    );
    if (
      result?.response.ok &&
      !result.body.error &&
      result.body.result !== undefined
    ) {
      return result.body.result;
    }
  }
  return null;
}

export async function fetchReviewedDeploymentSolanaObservation(
  input: {
    routeId: string;
    contractAddress: string;
    identity: ReviewedDeploymentSolanaIdentity;
    chainRpcs?: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
  },
  rpc?: SafetyScoreV9SolanaRpcFetcher,
): Promise<ReviewedDeploymentSupplyObservation | null> {
  const fetchRpc: SafetyScoreV9SolanaRpcFetcher = rpc ?? (
    (method, params, signal) =>
      fetchSafetyScoreV9SolanaRpc(method, params, signal, input.chainRpcs)
  );
  const accounts = await fetchRpc<SolanaMultipleAccountsResult>(
    "getMultipleAccounts",
    [
      [input.contractAddress, input.identity.controllerAddress],
      { commitment: "finalized", encoding: "jsonParsed" },
    ],
    input.signal,
  );
  const slot = accounts?.context?.slot;
  const mint = accounts?.value?.[0];
  const controller = accounts?.value?.[1];
  const info = mint?.data?.parsed?.info;
  if (
    typeof slot !== "number" ||
    !Number.isSafeInteger(slot) ||
    typeof info?.supply !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(info.supply) ||
    typeof info.decimals !== "number" ||
    !Number.isInteger(info.decimals) ||
    typeof info.mintAuthority !== "string" ||
    typeof mint?.owner !== "string" ||
    controller?.executable !== input.identity.controllerExecutable ||
    typeof controller.owner !== "string"
  ) {
    return null;
  }

  // A finalized bank slot is not necessarily a produced block: Solana leaders
  // can skip slots, while getMultipleAccounts still reports the current bank
  // context. Resolve the latest produced block at or before that context so a
  // valid account snapshot is not rejected merely because its context slot was
  // skipped. This gives the observation a bounded finalized chronology anchor;
  // the mint and controller values still come from the single account request.
  const blockAnchorStartSlot = Math.max(
    0,
    slot - REVIEWED_DEPLOYMENT_SOLANA_BLOCK_ANCHOR_LOOKBACK_SLOTS,
  );
  const blockSlots = await fetchRpc<number[]>(
    "getBlocks",
    [
      blockAnchorStartSlot,
      slot,
      { commitment: "finalized", minContextSlot: slot },
    ],
    input.signal,
  );
  const blockSlot = (Array.isArray(blockSlots) ? blockSlots : [])
    .filter((candidate) => Number.isSafeInteger(candidate)
      && candidate >= blockAnchorStartSlot
      && candidate <= slot)
    .reduce<number | null>((latest, candidate) => latest === null || candidate > latest ? candidate : latest, null);
  if (blockSlot === null) return null;

  const block = await fetchRpc<SolanaBlockResult>(
    "getBlock",
    [
      blockSlot,
      {
        commitment: "finalized",
        transactionDetails: "none",
        rewards: false,
        maxSupportedTransactionVersion: 0,
      },
    ],
    input.signal,
  );
  if (
    !Number.isSafeInteger(block?.blockTime) ||
    block!.blockTime! < 0 ||
    typeof block?.blockhash !== "string" ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(block.blockhash)
  ) {
    return null;
  }

  return {
    routeId: input.routeId,
    chainId: "solana",
    contractAddress: input.contractAddress,
    decimals: info.decimals,
    rawSupply: info.supply,
    blockNumberOrSlot: blockSlot.toString(),
    blockTimeSec: block!.blockTime!,
    blockHash: block!.blockhash!,
    programOwner: mint!.owner!,
    mintAuthority: info.mintAuthority,
    controllerAddress: input.identity.controllerAddress,
    controllerProgramOwner: controller!.owner!,
  };
}

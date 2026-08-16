import { throwIfAborted } from "./abort";
import type { ChainRpcConfig } from "./chain-registry";
import type { EvmBlockHeader, EvmMulticall3Result } from "./evm-rpc";
import { fetchJsonWithRetry } from "./fetch-retry";
import {
  buildReviewedDeploymentRouteInventory,
  deriveReviewedDeploymentUnitPartition,
  reviewedDeploymentObservationTimingIssue,
  type ReviewedDeploymentSupplyObservation,
  type ReviewedDeploymentUnitPartitionV1,
} from "./safety-score-v9-supply-attribution-contract";

export const REVIEWED_DEPLOYMENT_MAX_SCORING_CLOCK_REWIND_BLOCKS = 128;

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
): Promise<T | null> {
  for (const rpcUrl of SOLANA_RPC_URLS) {
    throwIfAborted(signal);
    const result = await fetchJsonWithRetry<SolanaRpcEnvelope<T>>(
      rpcUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal,
      },
      0,
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
    signal?: AbortSignal;
  },
  rpc: SafetyScoreV9SolanaRpcFetcher = fetchSafetyScoreV9SolanaRpc,
): Promise<ReviewedDeploymentSupplyObservation | null> {
  const accounts = await rpc<SolanaMultipleAccountsResult>(
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

  const block = await rpc<SolanaBlockResult>(
    "getBlock",
    [
      slot,
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
    blockNumberOrSlot: slot!.toString(),
    blockTimeSec: block!.blockTime!,
    blockHash: block!.blockhash!,
    programOwner: mint!.owner!,
    mintAuthority: info.mintAuthority,
    controllerAddress: input.identity.controllerAddress,
    controllerProgramOwner: controller!.owner!,
  };
}

import { throwIfAborted } from "./abort";
import type { ChainRpcConfig } from "./chain-registry";
import type { EvmMulticall3Result } from "./evm-rpc";
import { fetchJsonWithRetry } from "./fetch-retry";
import type { ReviewedDeploymentSupplyObservation } from "./safety-score-v9-supply-attribution-contract";

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

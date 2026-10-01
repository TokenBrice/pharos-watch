import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReserveInput } from "@shared/types/live-reserves";
import type { AdapterContext } from "./types";
import { throwIfAborted } from "../../lib/abort";
import { redactProviderUrls } from "../../lib/safe-error-message";
import { toErrorMessage } from "@shared/lib/error-utils";
import { APTOS_PUBLIC_REST_URL } from "@shared/lib/chain-rpc-registry";
import { getRpcAuthHeaders, registryRpcUrls } from "../../lib/chain-registry";
import { fetchErc20TotalSupply } from "./onchain";
import { fetchJsonPostWithRetry, fetchJsonWithRetry } from "./request";
import { requireOnchainInput } from "./input-guards";
import { resolveCoinContractAddress } from "./evm";

type EvmInput = Extract<LiveReserveInput, { kind: "onchain-evm" }>;
type SolanaInput = Extract<LiveReserveInput, { kind: "onchain-solana" }>;

interface SolanaTokenSupplyResponse {
  result?: {
    value?: {
      amount?: string;
    };
  };
}

const SOLANA_RPC_URLS = [
  "https://api.mainnet-beta.solana.com",
  "https://api.mainnet.solana.com",
  "https://solana-rpc.publicnode.com",
] as const;

const MOVE_CONCURRENT_SUPPLY_TYPE = "0x1::fungible_asset::ConcurrentSupply";
const MOVE_METADATA_TYPE = "0x1::fungible_asset::Metadata";
export { APTOS_PUBLIC_REST_URL };

interface MoveLedgerResponse {
  ledger_version?: string;
  ledger_timestamp?: string;
}

interface MoveResourceResponse {
  type?: string;
  data?: Record<string, unknown>;
}

export interface MoveFungibleAssetSupplyObservation {
  rawSupply: bigint;
  decimals: number;
  ledgerVersion: string;
  /** Ledger timestamp in unix seconds when the node reports one. */
  ledgerTimestampSec?: number;
}

/**
 * Reads an Aptos-framework fungible asset's supply and decimals at one pinned
 * ledger version. Serves every Move chain on the Aptos framework REST API
 * (Aptos mainnet, Movement).
 */
export async function fetchMoveFungibleAssetSupply(
  metadataAddress: string,
  signal: AbortSignal,
  rpcUrl: string,
  ctx?: AdapterContext,
): Promise<MoveFungibleAssetSupplyObservation | null> {
  const baseUrl = rpcUrl.replace(/\/$/, "");
  const ledger = await fetchJsonWithRetry<MoveLedgerResponse>(baseUrl, signal, 10_000, ctx);
  if (!ledger.ledger_version || !/^(0|[1-9][0-9]*)$/.test(ledger.ledger_version)) return null;

  const resourceUrl = (type: string) =>
    `${baseUrl}/accounts/${metadataAddress}/resource/${type}?ledger_version=${ledger.ledger_version}`;
  const supply = await fetchJsonWithRetry<MoveResourceResponse>(
    resourceUrl(MOVE_CONCURRENT_SUPPLY_TYPE), signal, 10_000, ctx,
  );
  const metadata = await fetchJsonWithRetry<MoveResourceResponse>(
    resourceUrl(MOVE_METADATA_TYPE), signal, 10_000, ctx,
  );
  if (supply.type !== MOVE_CONCURRENT_SUPPLY_TYPE || metadata.type !== MOVE_METADATA_TYPE) return null;

  const current = supply.data?.current;
  const raw = current && typeof current === "object" ? (current as Record<string, unknown>).value : null;
  const decimals = metadata.data?.decimals;
  if (typeof raw !== "string" || !/^(0|[1-9][0-9]*)$/.test(raw)) return null;
  if (!Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 30) return null;

  // Aptos-framework nodes report the ledger timestamp in microseconds.
  const ledgerTimestampMicros = ledger.ledger_timestamp;
  const ledgerTimestampSec = typeof ledgerTimestampMicros === "string" && /^[1-9][0-9]{0,19}$/.test(ledgerTimestampMicros)
    ? Number(BigInt(ledgerTimestampMicros) / 1_000_000n)
    : undefined;

  return {
    rawSupply: BigInt(raw),
    decimals: decimals as number,
    ledgerVersion: ledger.ledger_version,
    ...(ledgerTimestampSec != null && ledgerTimestampSec > 0 ? { ledgerTimestampSec } : {}),
  };
}

const SPL_TOKEN_PROGRAM_IDS: Readonly<Record<string, true>> = {
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: true,
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: true,
};

interface SolanaMintAccountResponse {
  result?: {
    context?: { slot?: number };
    value?: {
      owner?: string;
      data?: { parsed?: { type?: string; info?: { supply?: unknown; decimals?: unknown } } };
    } | null;
  };
}

export interface SolanaMintSupplyObservation {
  rawSupply: bigint;
  decimals: number;
  slot: number;
}

/**
 * SPL mint supply and decimals from one `getAccountInfo` (jsonParsed) read of
 * the mint account. Unlike `getTokenSupply`, keyless public endpoints serve
 * this method, and the parsed account proves the address is an SPL mint owned
 * by a token program. Returns null when no endpoint yields a well-formed mint.
 */
export async function fetchSolanaMintSupply(
  mintAddress: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<SolanaMintSupplyObservation | null> {
  let lastError: unknown = null;
  const rpcUrls = [...new Set([
    ...registryRpcUrls(ctx?.chainRpcs?.get("solana")),
    ...SOLANA_RPC_URLS,
  ])];

  for (const rpcUrl of rpcUrls) {
    throwIfAborted(signal);
    try {
      const body = await fetchJsonPostWithRetry<SolanaMintAccountResponse>(
        rpcUrl,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "getAccountInfo",
          params: [mintAddress, { encoding: "jsonParsed", commitment: "finalized" }],
        },
        signal,
        10_000,
        ctx,
        { headers: getRpcAuthHeaders(rpcUrl) },
      );
      const value = body.result?.value;
      const slot = body.result?.context?.slot;
      const parsed = value?.data?.parsed;
      const supply = parsed?.info?.supply;
      const decimals = parsed?.info?.decimals;
      if (
        !value?.owner || SPL_TOKEN_PROGRAM_IDS[value.owner] !== true || parsed?.type !== "mint"
        || typeof supply !== "string" || !/^(0|[1-9][0-9]*)$/.test(supply)
        || !Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 30
        || !Number.isSafeInteger(slot) || (slot as number) <= 0
      ) {
        continue;
      }
      return { rawSupply: BigInt(supply), decimals: decimals as number, slot: slot as number };
    } catch (error) {
      lastError = new Error(redactProviderUrls(toErrorMessage(error)));
    }
  }

  if (lastError) throw lastError;
  return null;
}

function isOnchainEvmInput(input: LiveReserveInput): input is EvmInput {
  return input.kind === "onchain-evm";
}

function isOnchainSolanaInput(input: LiveReserveInput): input is SolanaInput {
  return input.kind === "onchain-solana";
}

/**
 * Raw SPL mint supply in base units, or null when no endpoint answers.
 *
 * `probeTrackedTokenSupply()` treats a zero read as an adapter failure, which is
 * right for reserve adapters but wrong for curated aggregate legs that opt into
 * `allowZeroSupply`. Those callers read the mint through this reader directly,
 * mirroring how the EVM branch bypasses the probe with `fetchErc20TotalSupply`.
 */
export async function fetchSolanaTokenSupply(
  mintAddress: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
  rpcUrl?: string,
  fallbackRpcUrl?: string,
): Promise<bigint | null> {
  let lastError: unknown = null;
  const configuredRpc = ctx?.chainRpcs?.get("solana");
  const rpcUrls = [...new Set([
    ...registryRpcUrls(configuredRpc),
    rpcUrl,
    fallbackRpcUrl,
    ...SOLANA_RPC_URLS,
  ].filter((url): url is string => typeof url === "string" && url.length > 0))];

  for (const rpcUrl of rpcUrls) {
    throwIfAborted(signal);
    try {
      const body = await fetchJsonPostWithRetry<SolanaTokenSupplyResponse>(
        rpcUrl,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "getTokenSupply",
          params: [mintAddress],
        },
        signal,
        10_000,
        ctx,
        { headers: getRpcAuthHeaders(rpcUrl) },
      );

      const amount = body.result?.value?.amount;
      if (typeof amount !== "string" || amount.length === 0) {
        continue;
      }

      try {
        return BigInt(amount);
      } catch {
        continue;
      }
    } catch (error) {
      lastError = new Error(redactProviderUrls(toErrorMessage(error)));
      continue;
    }
  }

  if (lastError) throw lastError;
  return null;
}

/**
 * Resolves contract address for a coin on a given chain, fetches ERC-20 totalSupply,
 * and validates it is non-zero. Throws with descriptive error on any failure.
 */
export async function probeOnchainTotalSupply(
  coin: StablecoinMeta,
  input: LiveReserveInput,
  signal: AbortSignal,
  adapterName: string,
  ctx?: AdapterContext,
  rpcUrl?: string,
  fallbackRpcUrl?: string,
): Promise<bigint> {
  const onchain = requireOnchainInput(input, adapterName);
  const contract = resolveCoinContractAddress(coin, onchain.chain);
  if (!contract) {
    throw new Error(`${adapterName} could not find a ${onchain.chain} contract for ${coin.id}`);
  }
  const supply = await fetchErc20TotalSupply(onchain, contract, signal, ctx, rpcUrl, fallbackRpcUrl);
  if (supply == null || supply <= 0n) {
    throw new Error(`${adapterName} totalSupply probe failed for ${coin.id}`);
  }
  return supply;
}

/**
 * Resolves contract/mint metadata for a coin on a supported onchain input and
 * validates that the published token supply is non-zero.
 */
export async function probeTrackedTokenSupply(
  coin: StablecoinMeta,
  input: LiveReserveInput,
  signal: AbortSignal,
  adapterName: string,
  ctx?: AdapterContext,
  rpcUrl?: string,
  fallbackRpcUrl?: string,
): Promise<bigint> {
  if (isOnchainEvmInput(input)) {
    return probeOnchainTotalSupply(
      coin,
      input,
      signal,
      adapterName,
      ctx,
      rpcUrl,
      fallbackRpcUrl,
    );
  }

  if (!isOnchainSolanaInput(input)) {
    throw new Error(`${adapterName} adapter requires a supported onchain primary input`);
  }

  const mintAddress = coin.contracts?.find((contract) => contract.chain === "solana")?.address;
  if (!mintAddress) {
    throw new Error(`${adapterName} could not find a solana contract for ${coin.id}`);
  }

  const supply = await fetchSolanaTokenSupply(mintAddress, signal, ctx, rpcUrl, fallbackRpcUrl);
  if (supply == null || supply <= 0n) {
    throw new Error(`${adapterName} totalSupply probe failed for ${coin.id}`);
  }
  return supply;
}

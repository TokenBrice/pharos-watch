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
  chain_id?: number;
  ledger_version?: string;
  ledger_timestamp?: string;
}

interface MoveBlockResponse {
  first_version?: string;
  last_version?: string;
  block_timestamp?: string;
}

const MOVE_INTEGER_RE = /^(0|[1-9][0-9]*)$/;

function moveTimestampSec(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value)) return undefined;
  const seconds = Number(BigInt(value) / 1_000_000n);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
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

export interface MoveFungibleAssetSupplyReadOptions {
  clockSec: number;
  expectedChainId?: number;
  /** Exact deployed OFT package identity, resolved through its pinned mint/burn refs. */
  identityKind?: "metadata-address" | "oft-package";
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
  options?: MoveFungibleAssetSupplyReadOptions,
): Promise<MoveFungibleAssetSupplyObservation | null> {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(metadataAddress)) return null;
  const baseUrl = rpcUrl.replace(/\/$/, "");
  const ledger = await fetchJsonWithRetry<MoveLedgerResponse>(baseUrl, signal, 10_000, ctx);
  if (!ledger.ledger_version || !MOVE_INTEGER_RE.test(ledger.ledger_version)) return null;
  if (options?.expectedChainId !== undefined && ledger.chain_id !== options.expectedChainId) return null;
  let ledgerVersion = ledger.ledger_version;
  let ledgerTimestampSec = moveTimestampSec(ledger.ledger_timestamp);
  if (options) {
    if (!Number.isSafeInteger(options.clockSec) || options.clockSec <= 0 || ledgerTimestampSec === undefined) return null;
    if (ledgerTimestampSec > options.clockSec) {
      // Locate the newest complete block at/before the scoring clock. Never
      // attach an old clock to the latest supply, or read partial block state.
      let low = 0n;
      let high = BigInt(ledgerVersion);
      let historicalVersion: string | null = null;
      let historicalTimestamp: number | undefined;
      let bracketed = false;
      let offset = 0n;
      for (let probe = 0; low <= high && probe < 64; probe += 1) {
        throwIfAborted(signal);
        // Near-clock captures need near-head state, not a pruned half-chain
        // probe. Walk back exponentially before bisecting the retained bracket.
        const middle = bracketed ? (low + high) / 2n
          : BigInt(ledgerVersion) > offset ? BigInt(ledgerVersion) - offset : 0n;
        const block = await fetchJsonWithRetry<MoveBlockResponse>(
          `${baseUrl}/blocks/by_version/${middle}?with_transactions=false`, signal, 10_000, ctx,
        );
        const timestamp = moveTimestampSec(block.block_timestamp);
        if (!block.first_version || !block.last_version || !MOVE_INTEGER_RE.test(block.first_version) ||
            !MOVE_INTEGER_RE.test(block.last_version) || timestamp === undefined) return null;
        const first = BigInt(block.first_version);
        const last = BigInt(block.last_version);
        if (first > middle || last < middle || last > BigInt(ledger.ledger_version)) return null;
        if (timestamp <= options.clockSec) {
          historicalVersion = block.last_version;
          historicalTimestamp = timestamp;
          low = last + 1n;
          bracketed = true;
        } else {
          high = first - 1n;
          const nextOffset = offset === 0n ? 1n : offset * 2n;
          offset = nextOffset > BigInt(ledgerVersion) - high ? nextOffset : BigInt(ledgerVersion) - high;
        }
      }
      if (low <= high || historicalVersion === null || historicalTimestamp === undefined) return null;
      ledgerVersion = historicalVersion;
      ledgerTimestampSec = historicalTimestamp;
    }
  }
  if (options?.identityKind === "oft-package") {
    const packageType = `${metadataAddress}::oft_fa::OftImpl`;
    const oft = await fetchJsonWithRetry<MoveResourceResponse>(
      `${baseUrl}/accounts/${metadataAddress}/resource/${packageType}?ledger_version=${ledgerVersion}`,
      signal, 10_000, ctx,
    );
    if (oft.type !== packageType) return null;
    const inner = (value: unknown): unknown =>
      value !== null && typeof value === "object" && "inner" in value ? value.inner : null;
    const metadata = inner(oft.data?.metadata);
    if (typeof metadata !== "string" || !/^0x[0-9a-f]{64}$/.test(metadata)) return null;
    for (const name of ["mint_ref", "burn_ref", "transfer_ref"]) {
      const ref = oft.data?.[name];
      if (ref === null || typeof ref !== "object" || !("metadata" in ref) ||
          inner(ref.metadata) !== metadata) return null;
    }
    metadataAddress = metadata;
  }

  const resourceUrl = (type: string) =>
    `${baseUrl}/accounts/${metadataAddress}/resource/${type}?ledger_version=${ledgerVersion}`;
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

  return {
    rawSupply: BigInt(raw),
    decimals: decimals as number,
    ledgerVersion,
    ...(ledgerTimestampSec !== undefined ? { ledgerTimestampSec } : {}),
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

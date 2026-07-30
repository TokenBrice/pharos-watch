import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReserveInput } from "@shared/types/live-reserves";
import type { AdapterContext } from "./types";
import { throwIfAborted } from "../../lib/abort";
import { fetchErc20TotalSupply } from "./onchain";
import { fetchJsonPostWithRetry } from "./request";
import { requireOnchainInput } from "./input-guards";

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
): Promise<bigint | null> {
  let lastError: unknown = null;

  for (const rpcUrl of SOLANA_RPC_URLS) {
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
      lastError = error;
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
  const contract = coin.contracts?.find((c) => c.chain === onchain.chain)?.address;
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

  const supply = await fetchSolanaTokenSupply(mintAddress, signal, ctx);
  if (supply == null || supply <= 0n) {
    throw new Error(`${adapterName} totalSupply probe failed for ${coin.id}`);
  }
  return supply;
}

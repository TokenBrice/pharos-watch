import type { ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReserveInput } from "@shared/types/live-reserves";
import type { AdapterContext } from "./types";
import { createAdapterChainObservationContext } from "./request";
import {
  fetchMoveFungibleAssetSupply as observeMoveFungibleAssetSupply,
  fetchSolanaMintSupply as observeSolanaMintSupply,
  fetchSolanaTokenSupply as observeSolanaTokenSupply,
  type MoveFungibleAssetSupplyReadOptions,
} from "../../lib/native-token-supply";
import { fetchErc20TotalSupply } from "./onchain";
import { requireOnchainInput } from "./input-guards";
import { resolveCoinContractAddress } from "./evm";

type EvmInput = Extract<LiveReserveInput, { kind: "onchain-evm" }>;
type SolanaInput = Extract<LiveReserveInput, { kind: "onchain-solana" }>;

export async function fetchMoveFungibleAssetSupply(
  metadataAddress: string,
  signal: AbortSignal,
  rpcUrl: string,
  ctx?: AdapterContext,
  options?: MoveFungibleAssetSupplyReadOptions,
  network?: "aptos" | "movement",
) {
  return observeMoveFungibleAssetSupply(metadataAddress, signal, rpcUrl, createAdapterChainObservationContext(ctx), options, network);
}

export async function fetchSolanaMintSupply(mintAddress: string, signal: AbortSignal, ctx?: AdapterContext) {
  return observeSolanaMintSupply(mintAddress, signal, createAdapterChainObservationContext(ctx));
}

export async function fetchSolanaTokenSupply(
  mintAddress: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
  rpcUrl?: string,
  fallbackRpcUrl?: string,
) {
  return observeSolanaTokenSupply(mintAddress, signal, createAdapterChainObservationContext(ctx), rpcUrl, fallbackRpcUrl);
}

function isOnchainEvmInput(input: LiveReserveInput): input is EvmInput {
  return input.kind === "onchain-evm";
}

function isOnchainSolanaInput(input: LiveReserveInput): input is SolanaInput {
  return input.kind === "onchain-solana";
}

/**
 * Resolves contract address for a coin on a given chain, fetches ERC-20 totalSupply,
 * and validates it is non-zero. Throws with descriptive error on any failure.
 */
export async function probeOnchainTotalSupply(
  coin: ReserveAdapterCoin,
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
  coin: ReserveAdapterCoin,
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

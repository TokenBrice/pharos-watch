import { jsonRequestExecutor } from "./json-request";
import type { ChainObservationContext, ChainObservationOptions } from "./chain-observation-context";
import {
  fetchSolanaAccounts as observeSolanaAccounts,
  fetchSolanaAccountBatch as observeSolanaAccountBatch,
} from "./solana-observation";
import {
  fetchMoveFungibleAssetSupply as observeMoveFungibleAssetSupply,
  fetchTonJettonSupply as observeTonJettonSupply,
  fetchSolanaTokenSupply as observeSolanaTokenSupply,
  type MoveFungibleAssetSupplyReadOptions,
} from "./native-token-supply";

export { readSolanaMint, solanaPublicKey, SOLANA_TOKEN_PROGRAM, type SolanaAccount } from "./solana-observation";
export type { MoveFungibleAssetSupplyObservation } from "./native-token-supply";

function observationContext(ctx?: ChainObservationOptions): ChainObservationContext {
  return {
    chainRpcs: ctx?.chainRpcs,
    dwellirNative: ctx?.dwellirNative,
    jsonRequestExecutor: ctx?.jsonRequestExecutor ?? jsonRequestExecutor,
  };
}

export async function fetchSolanaAccounts(addresses: string[], signal: AbortSignal, ctx?: ChainObservationOptions, minContextSlot?: number) {
  return observeSolanaAccounts(addresses, signal, observationContext(ctx), minContextSlot);
}

export async function fetchSolanaAccountBatch(addresses: string[], signal: AbortSignal, ctx?: ChainObservationOptions, minContextSlot?: number) {
  return observeSolanaAccountBatch(addresses, signal, observationContext(ctx), minContextSlot);
}

export async function fetchMoveFungibleAssetSupply(
  metadataAddress: string,
  signal: AbortSignal,
  rpcUrl: string,
  ctx?: ChainObservationOptions,
  options?: MoveFungibleAssetSupplyReadOptions,
  network?: "aptos" | "movement",
) {
  return observeMoveFungibleAssetSupply(metadataAddress, signal, rpcUrl, observationContext(ctx), options, network);
}

export async function fetchTonJettonSupply(
  masterAddress: string,
  signal: AbortSignal,
  rpcUrl: string,
  options: { clockSec: number; expectedDecimals: number },
  ctx?: ChainObservationOptions,
) {
  return observeTonJettonSupply(masterAddress, signal, rpcUrl, options, observationContext(ctx));
}

export async function fetchSolanaTokenSupply(
  mintAddress: string,
  signal: AbortSignal,
  ctx?: ChainObservationOptions,
  rpcUrl?: string,
  fallbackRpcUrl?: string,
) {
  return observeSolanaTokenSupply(mintAddress, signal, observationContext(ctx), rpcUrl, fallbackRpcUrl);
}

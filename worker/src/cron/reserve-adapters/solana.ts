import type { AdapterContext } from "./types";
import { createAdapterChainObservationContext } from "./request";
import {
  fetchSolanaAccounts as observeSolanaAccounts,
  fetchSolanaAccountsWithPrograms as observeSolanaAccountsWithPrograms,
} from "../../lib/solana-observation";

export async function fetchSolanaAccounts(addresses: string[], signal: AbortSignal, ctx?: AdapterContext, minContextSlot?: number) {
  return observeSolanaAccounts(addresses, signal, createAdapterChainObservationContext(ctx), minContextSlot);
}

export async function fetchSolanaAccountsWithPrograms(addresses: string[], programAddresses: readonly string[], signal: AbortSignal, ctx?: AdapterContext) {
  return observeSolanaAccountsWithPrograms(addresses, programAddresses, signal, createAdapterChainObservationContext(ctx));
}

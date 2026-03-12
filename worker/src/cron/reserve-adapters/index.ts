import { fetchInfiniFiReserves } from "./infinifi";
import type { ReserveSlice } from "@shared/types";

/** Context passed from the cron to adapters that need worker infrastructure. */
export interface AdapterContext {
  etherscanApiKey?: string;
  alchemyApiKey?: string;
}

export interface AdapterResult {
  slices: ReserveSlice[];
  /** Position/farm names not in the adapter's risk map (for operator awareness). */
  unknownFarms?: string[];
}

type AdapterFn = (url: string, signal: AbortSignal, ctx?: AdapterContext) => Promise<AdapterResult>;

const ADAPTERS: Record<string, AdapterFn> = {
  infinifi: fetchInfiniFiReserves,
};

/** Returns the adapter function for the given key, or null if unknown. */
export function getReserveAdapter(adapterKey: string): AdapterFn | null {
  return ADAPTERS[adapterKey] ?? null;
}

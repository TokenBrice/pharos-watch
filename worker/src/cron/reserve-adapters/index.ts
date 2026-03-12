import { fetchInfiniFiReserves } from "./infinifi";
import type { LiveReserveWarning, LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";

/** Context passed from the cron to adapters that need worker infrastructure. */
export interface AdapterContext {
  etherscanApiKey?: string;
  alchemyApiKey?: string;
}

export interface AdapterResult {
  slices: ReserveSlice[];
  warnings?: LiveReserveWarning[];
  metadata?: Record<string, unknown>;
}

type AdapterFn = (
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
) => Promise<AdapterResult>;

const ADAPTERS: Record<string, AdapterFn> = {
  infinifi: fetchInfiniFiReserves,
};

/** Returns the adapter function for the given key, or null if unknown. */
export function getReserveAdapter(adapterKey: string): AdapterFn | null {
  return ADAPTERS[adapterKey] ?? null;
}

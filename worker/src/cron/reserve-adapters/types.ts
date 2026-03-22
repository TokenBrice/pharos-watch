import type { LiveReserveWarning, LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import type { ChainRpcConfig } from "../../lib/chain-registry";

/** Context passed from the cron to adapters that need worker infrastructure. */
export interface AdapterContext {
  etherscanApiKey?: string;
  alchemyApiKey?: string;
  chainRpcs?: Map<string, ChainRpcConfig>;
}

export interface AdapterResult {
  slices: ReserveSlice[];
  warnings?: LiveReserveWarning[];
  metadata?: Record<string, unknown>;
}

export type AdapterFn = (
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
) => Promise<AdapterResult>;

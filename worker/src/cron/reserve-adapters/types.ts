import type { LiveReserveWarning, LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import type {
  LiveReserveAdapterKey,
  LiveReserveEvidenceClass,
  LiveReserveSourceModel,
  LiveReserveSourceSharingMode,
} from "@shared/types";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import type { LiveReserveAdapterValidationPolicy } from "@shared/lib/live-reserve-adapters";

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

export interface ReserveAdapterDefinition {
  key: LiveReserveAdapterKey;
  fetch: AdapterFn;
  sourceModel: LiveReserveSourceModel;
  evidenceClass: LiveReserveEvidenceClass;
  sharedSourceMode: LiveReserveSourceSharingMode;
  validation?: LiveReserveAdapterValidationPolicy;
}

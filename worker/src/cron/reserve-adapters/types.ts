import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type {
  LiveReserveAdapterKey,
  LiveReserveAdapterValidationPolicy,
  LiveReserveEvidenceClass,
  LiveReserveSnapshotMetadata,
  LiveReserveSourceModel,
  LiveReserveSourceSharingMode,
  LiveReserveWarning,
  LiveReservesConfig,
} from "@shared/types/live-reserves";
import type { ChainRpcConfig } from "../../lib/chain-registry";

/** Context passed from the cron to adapters that need worker infrastructure. */
export interface AdapterContext {
  etherscanApiKey?: string;
  alchemyApiKey?: string;
  chainRpcs?: Map<string, ChainRpcConfig>;
  nowSec?: number;
  requestCache?: Map<string, Promise<unknown>>;
}

export interface AdapterResult {
  slices: ReserveSlice[];
  warnings?: LiveReserveWarning[];
  metadata?: LiveReserveSnapshotMetadata;
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
  redemptionTelemetry?: {
    capacity: "direct" | "proxy" | "none";
    fee: "current-bps" | "none";
  };
  validation?: LiveReserveAdapterValidationPolicy;
}

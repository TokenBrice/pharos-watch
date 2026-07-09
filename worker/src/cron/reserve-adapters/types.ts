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
import type { AdapterIoLimiter } from "./concurrency";

/** Context passed from the cron to adapters that need worker infrastructure. */
export interface AdapterContext {
  db?: D1Database;
  etherscanApiKey?: string;
  alchemyApiKey?: string;
  trongridApiKey?: string;
  chainRpcs?: Map<string, ChainRpcConfig>;
  nowSec?: number;
  requestCache?: Map<string, Promise<unknown>>;
  ioLimiter?: AdapterIoLimiter;
  abortSignal?: AbortSignal;
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

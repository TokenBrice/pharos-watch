import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveAdapterDescriptor } from "@shared/types/live-reserve-adapter-declarations";
import type {
  LiveReserveAdapterKey,
  LiveReserveSnapshotMetadata,
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
  m0ApiKey?: string;
  chainRpcs?: Map<string, ChainRpcConfig>;
  nowSec?: number;
  observedBlock?: { chain: string; number: number; timestamp: number };
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

/**
 * Projection of the shared declaration plus the Worker-only fetch function.
 * Projecting rather than re-declaring keeps fields such as
 * `redemptionTelemetry.capacityParamsGated` visible to the Worker as soon as
 * the declaration gains them.
 */
export type ReserveAdapterDefinition = Pick<
  LiveReserveAdapterDescriptor,
  "sourceModel" | "evidenceClass" | "sharedSourceMode" | "redemptionTelemetry" | "validation"
> & {
  key: LiveReserveAdapterKey;
  fetch: AdapterFn;
};
